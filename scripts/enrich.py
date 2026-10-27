#!/usr/bin/env python3
"""Vérifie les parutions des séries (lancé chaque semaine par GitHub Actions).

- AniList : état de la série au Japon (terminée, en cours…) et nombre de tomes en VO.
- BnF (catalogue général, dépôt légal) : tomes réellement parus en France et date du dernier.

Écrit data/enrich.json. Ne touche jamais à series.json ni à fonds.json.
Données BnF : Licence Ouverte (Etalab). Données AniList : https://anilist.co
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import difflib
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
DATA = RACINE / "data"
UA = "Suivixo/1.0 (suivi des mangas de la mediatheque de Servon-sur-Vilaine; github.com/mediatheque-ssv/suivixo)"
AUJOURDHUI = dt.date.today()

# --------------------------------------------------------------------------- titres

ARTICLE_FIN = re.compile(r"\s*\((l'|l’|le|la|les)\)\s*$", re.I)
ARTICLE_DEBUT = re.compile(r"^(l'|l’|le\s+|la\s+|les\s+)", re.I)


def sans_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn")


def cle(t: str) -> str:
    s = re.sub(r"\s+", " ", sans_accents(t).lower()).strip()
    s = ARTICLE_FIN.sub("", s)
    s = ARTICLE_DEBUT.sub("", s)
    return re.sub(r"[^a-z0-9]", "", s)


def mots(t: str) -> str:
    s = sans_accents(t).lower()
    s = ARTICLE_FIN.sub("", s)
    s = ARTICLE_DEBUT.sub("", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(w for w in s.split() if len(w) > 1 or w.isdigit())[:120]


def titres_de(serie: dict) -> list[str]:
    out = [serie["titre"], *serie.get("alias", [])]
    for t in list(out):
        if " : " in t:
            out.append(t.split(" : ")[0])
    mn = (serie.get("liens") or {}).get("mangaNews", "")
    if mn:
        slug = mn.rstrip("/").split("/")[-1]
        slug = re.sub(r"-(l|le|la|les)$", "", slug, flags=re.I)
        out.append(slug.replace("-", " "))
    vus, res = set(), []
    for t in out:
        k = cle(t)
        if k and k not in vus:
            vus.add(k)
            res.append(t)
    return res

# --------------------------------------------------------------------------- HTTP


def http(url: str, data: bytes | None = None, headers: dict | None = None, essais: int = 5) -> bytes:
    h = {"User-Agent": UA, **(headers or {})}
    for i in range(essais):
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            # trop de requêtes, accès refusé temporairement ou serveur surchargé : on patiente
            if e.code in (403, 429, 502, 503, 504) and i < essais - 1:
                try:
                    attente = int(e.headers.get("Retry-After") or 0)
                except ValueError:
                    attente = 0
                attente = max(attente, 20 * (i + 1)) + 1
                print(f"  {e.code} sur {url[:60]}…, pause {attente}s", flush=True)
                time.sleep(attente)
                continue
            if e.code >= 500 and i < essais - 1:
                time.sleep(5 * (i + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if i < essais - 1:
                time.sleep(5 * (i + 1))
                continue
            raise
    raise RuntimeError(f"échec après {essais} essais : {url}")

# --------------------------------------------------------------------------- AniList

CHAMPS = "id title { romaji english native } synonyms status volumes chapters format countryOfOrigin popularity genres tags { name rank } coverImage { medium large } siteUrl staff(perPage: 8) { edges { role node { name { full native alternative } } } }"
Q_ID = "query ($id: Int) { Media(id: $id, type: MANGA) { %s } }" % CHAMPS
Q_CHERCHE = "query ($q: String) { Page(perPage: 8) { media(search: $q, type: MANGA, sort: SEARCH_MATCH) { %s } } }" % CHAMPS
DEMOGRAPHIES = {"Shounen": "Shonen", "Seinen": "Seinen", "Shoujo": "Shojo", "Josei": "Josei", "Kids": "Kodomo"}
_dernier_appel = 0.0
JOURNAL: list[str] = []


def dbg(msg: str) -> None:
    print(msg, flush=True)
    JOURNAL.append(msg)


def anilist(query: str, variables: dict) -> dict:
    global _dernier_appel
    attente = 2.2 - (time.time() - _dernier_appel)
    if attente > 0:
        time.sleep(attente)
    _dernier_appel = time.time()
    corps = json.dumps({"query": query, "variables": variables}).encode()
    try:
        brut = http("https://graphql.anilist.co", corps, {"Content-Type": "application/json", "Accept": "application/json"})
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}
        raise
    return json.loads(brut).get("data") or {}


def noms(m: dict) -> list[str]:
    t = m.get("title") or {}
    return [x for x in [t.get("romaji"), t.get("english"), *(m.get("synonyms") or [])] if x]


def score(titres: list[str], m: dict) -> float:
    """1.0 si le titre principal correspond exactement, 0.97 pour un titre alternatif, sinon la ressemblance."""
    cles = [cle(t) for t in titres if cle(t)]
    t = m.get("title") or {}
    principaux = {cle(x) for x in [t.get("romaji"), t.get("english")] if x}
    if principaux & set(cles):
        return 1.0
    meilleur = 0.0
    for n in noms(m):
        kn = cle(n)
        for k in cles:
            if not kn:
                continue
            if k == kn:
                return 0.97
            meilleur = max(meilleur, difflib.SequenceMatcher(None, k, kn).ratio())
    return meilleur


def resume_anilist(m: dict, auto: bool, sc: float | None) -> dict:
    demo = next((DEMOGRAPHIES[t["name"]] for t in sorted(m.get("tags") or [], key=lambda t: -t.get("rank", 0)) if t["name"] in DEMOGRAPHIES), None)
    t = m.get("title") or {}
    return {
        "id": m["id"],
        "titre": t.get("english") or t.get("romaji"),
        "titreVO": t.get("romaji"),
        "statut": m.get("status"),
        "volumes": m.get("volumes"),
        "format": m.get("format"),
        "pays": m.get("countryOfOrigin"),
        "demographie": demo,
        "genres": m.get("genres") or [],
        "image": (m.get("coverImage") or {}).get("medium"),
        "imageGrande": (m.get("coverImage") or {}).get("large"),
        "auteurs": auteurs_anilist(m)[:4],
        "auto": auto,
        **({"score": round(sc, 3)} if sc is not None else {}),
    }


def auteurs_anilist(m: dict) -> list[str]:
    out = []
    for ed in ((m.get("staff") or {}).get("edges") or []):
        role = (ed.get("role") or "").lower()
        if any(r in role for r in ("story", "art", "original")):
            n = (ed.get("node") or {}).get("name") or {}
            out += [x for x in [n.get("full"), *(n.get("alternative") or [])] if x]
    return out


def jetons_nom(t: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", sans_accents(t or "").lower()) if len(w) >= 3}


def meme_auteur(auteur_orphee: str, m_ou_noms) -> bool | None:
    """Vrai si l'auteur d'Orphée figure parmi ceux d'AniList ; None si on ne peut pas comparer."""
    noms_al = m_ou_noms if isinstance(m_ou_noms, list) else auteurs_anilist(m_ou_noms)
    j = jetons_nom(auteur_orphee)
    if not j or not noms_al:
        return None
    return bool(j & set().union(*(jetons_nom(n) for n in noms_al)))


def chercher_anilist(serie: dict, auteur: str = "", debug: bool = False) -> dict | None:
    titres = titres_de(serie)
    vus: dict[int, tuple[dict, float]] = {}
    for q in titres[:3]:
        data = anilist(Q_CHERCHE, {"q": q})
        cands = [m for m in (data.get("Page") or {}).get("media", []) if m.get("format") not in ("NOVEL",)]
        for m in cands:
            sc = score(titres, m)
            if debug:
                dbg(f"    [{q}] {m['id']} {noms(m)[:3]} {m.get('status')} vol={m.get('volumes')} score={sc:.2f} auteurs={auteurs_anilist(m)[:2]} même auteur={meme_auteur(auteur, m)}")
            if sc >= 0.75 and (m["id"] not in vus or vus[m["id"]][1] < sc):
                vus[m["id"]] = (m, sc)
        if any(sc >= 1.0 and meme_auteur(auteur, m) is not False for m, sc in vus.values()):
            break
    if not vus:
        return None
    # Priorité au même auteur que dans Orphée, puis au titre le plus proche
    # puis, à égalité (spin-offs du même auteur), le format manga plutôt que one shot, et la série la plus connue
    ordre = sorted(vus.values(), key=lambda x: ({True: 2, None: 1, False: 0}[meme_auteur(auteur, x[0])], x[1],
                                               x[0].get("format") != "ONE_SHOT", x[0].get("popularity") or 0), reverse=True)
    m, sc = ordre[0]
    r = resume_anilist(m, True, sc)
    if meme_auteur(auteur, m) is False:
        r["auteurDifferent"] = True  # gardé comme simple proposition, pas utilisé
    return r

# --------------------------------------------------------------------------- Manga-News (data.gouv.fr)
# Jeu de données « Manga-News » publié sur data.gouv.fr (licence ODbL) : nombre de tomes parus en France
# pour environ 11 700 séries. Sert de deuxième source française à côté de la BnF.

MN_API = "https://www.data.gouv.fr/api/1/datasets/manga-news/"
_MN: dict | None = None
_MN_DATE = ""


def manga_news() -> dict:
    global _MN, _MN_DATE
    if _MN is not None:
        return _MN
    _MN = {}
    try:
        meta = json.loads(http(MN_API))
        res = next((r for r in meta.get("resources", []) if (r.get("format") or "").lower() == "csv"), None)
        if not res:
            return _MN
        _MN_DATE = (res.get("last_modified") or "")[:10]
        brut = http(res["url"]).decode("utf-8-sig", errors="replace")
        try:
            dialecte = csv.Sniffer().sniff(brut[:20000], delimiters=",;\t")
        except csv.Error:
            dialecte = csv.excel
        lignes = list(csv.DictReader(io.StringIO(brut), dialect=dialecte))
        if not lignes:
            return _MN
        colonnes = list(lignes[0].keys())

        def col(*mots):
            for c in colonnes:
                cl = sans_accents(c or "").lower()
                if all(m in cl for m in mots):
                    return c
            return None

        c_titre = col("titre") or col("title") or col("nom")
        c_tomes = col("tome", "par") or col("nombre", "tome") or col("tome") or col("volume")
        c_ed = col("editeur") or col("publisher")
        c_url = col("url")
        c_couv = col("cover") or col("couv") or col("image")
        c_aut = [c for c in colonnes if any(m in sans_accents(c or "").lower() for m in ("artist", "writer", "auteur", "dessin", "scenar"))]
        dbg(f"Manga-News ({_MN_DATE}) : {len(lignes)} séries, colonnes {colonnes} ; titre={c_titre}, tomes={c_tomes}, éditeur={c_ed}")
        for r in lignes:
            t = (r.get(c_titre) or "").strip()
            m = re.search(r"\d+", r.get(c_tomes) or "")
            if not t or not m or int(m.group(0)) == 0:
                continue
            _MN.setdefault(cle(t), []).append({"tomes": int(m.group(0)), "editeur": (r.get(c_ed) or "").strip(), "url": (r.get(c_url) or "").strip(),
                                               "titre": t, "auteurs": " ; ".join((r.get(c) or "") for c in c_aut),
                                               "couv": (r.get(c_couv) or "").strip() if c_couv else ""})
        for liste in _MN.values():
            for c in liste:
                c["_ed"] = norm_editeur(c["editeur"])
                c["_aut"] = jetons_nom(c["auteurs"])
    except Exception as ex:
        print(f"::warning title=Manga-News::Fichier data.gouv.fr illisible : {str(ex)[:200]}", flush=True)
    return _MN


def chemin_mn(u: str) -> str:
    """« https://www.manga-news.com/index.php/serie/Pokemon-X/Y » → « serie/pokemon-x/y » (pour comparer deux adresses)."""
    u = re.sub(r"^https?://(www\.)?manga-news\.com/", "", (u or "").strip(), flags=re.I)
    return re.sub(r"^index\.php/", "", u).strip("/").lower()


RE_AUTRE_FORMAT = re.compile(r"light\s*novel|\bnovel\b|\broman\b|art\s*book|fan\s*book|data\s*book|\bguide\b|coffret|anime\s*comics|\ble film\b")


def tomes_manga_news(serie: dict, editeur_orphee: str, debug: bool = False, al: dict | None = None,
                     auteur: str = "", maxi: int = 0) -> dict | None:
    idx = manga_news()
    eo = norm_editeur(editeur_orphee)
    ja = jetons_nom(auteur)
    meme_ed = lambda c: bool(eo) and c.get("_ed", norm_editeur(c["editeur"])) == eo
    meme_aut = lambda c: bool(ja) and bool(ja & c.get("_aut", set()))
    cands, approx, manuel = [], False, False
    # 1. la page indiquée dans la série (souvent reprise de l'ancien Excel) : c'est elle qui fait foi
    lien = (serie.get("liens") or {}).get("mangaNews")
    if lien:
        cible = chemin_mn(lien)
        cands = [c for liste in idx.values() for c in liste if chemin_mn(c["url"]) == cible]
        manuel = bool(cands)
    # 2. même titre
    if not cands:
        for t in titres_de(serie):
            cands += idx.get(cle(t), [])
    # 3. titre anglais ou japonais d'AniList (fréquent pour les webtoons), chez le même éditeur ou du même auteur
    if not cands and al and not al.get("rejete") and not al.get("auteurDifferent"):
        for t in {al.get("titre") or "", al.get("titreVO") or ""} - {""}:
            cands += [c for c in idx.get(cle(t), []) if meme_ed(c) or meme_aut(c)]
    # 4. titre un peu différent (sous-titre, ponctuation) : même éditeur, même auteur, et titres vraiment proches.
    #    Seulement les titres complets : « Pokémon » tout seul ne doit pas attraper « Pokémon - Noir et Blanc ».
    if not cands and eo and ja:
        import difflib
        ks = [k for k in (cle(t) for t in [serie["titre"], *serie.get("alias", [])]) if len(k) >= 6]
        meilleurs = []
        for k2, liste in idx.items():
            # même éditeur, même auteur ; pas un roman ou un artbook ; assez de tomes pour ce que le réseau possède
            # (« Captain Tsubasa », 23 tomes au réseau, n'est pas « Captain Tsubasa - Kids Dream », 5 tomes)
            ok = [c for c in liste if meme_ed(c) and meme_aut(c) and not RE_AUTRE_FORMAT.search(sans_accents(c["titre"]).lower())
                  and not (maxi and c["tomes"] < maxi)]
            if not ok:
                continue
            sc = max((difflib.SequenceMatcher(None, k, k2).ratio() for k in ks), default=0)
            if any((k2.startswith(k) or k.startswith(k2)) and min(len(k), len(k2)) >= 0.6 * max(len(k), len(k2)) for k in ks):
                sc = max(sc, 0.9)
            if sc >= 0.82:
                meilleurs.append((sc, ok))
        meilleurs.sort(key=lambda x: -x[0])
        # plusieurs séries proches presque à égalité : on ne choisit pas au hasard
        if meilleurs and (len(meilleurs) == 1 or meilleurs[0][0] - meilleurs[1][0] >= 0.05):
            cands = meilleurs[0][1]
            approx = True
    if debug:
        dbg(f"    Manga-News : {[{k: v for k, v in c.items() if k[0] != '_'} for c in cands[:6]]}{' (titre approché)' if approx else ''}{' (page indiquée)' if manuel else ''}")
    if not cands:
        return None
    memes = [c for c in cands if meme_ed(c)]
    c = max(memes or cands, key=lambda c: c["tomes"])
    return {"tomes": c["tomes"], "editeur": c["editeur"], "url": c["url"], "date": _MN_DATE,
            **({"couv": c["couv"]} if c.get("couv") else {}),
            **({"titre": c["titre"], "approche": True} if approx else {}),
            **({} if manuel or memes or not eo else {"editeurDifferent": True})}

RE_VF = re.compile(r"\bVF\s*:\s*(\d+)\s*\(([^)]{3,40})\)", re.I)
RE_VO = re.compile(r"\bVO\s*:\s*(\d+)\s*\(([^)]{3,40})\)", re.I)
_dernier_mn = 0.0


def url_manga_news(serie: dict, mn: dict | None) -> str | None:
    lien = (serie.get("liens") or {}).get("mangaNews")
    if lien:
        return lien if lien.startswith("http") else "https://www.manga-news.com/" + lien.lstrip("/")
    return (mn or {}).get("url") or None


RE_VOL = re.compile(r"/vol-(\d{1,3})\b")
RE_DATE = re.compile(r"\b(\d{2})/(\d{2})/(\d{4})\b")
PAYS_MN = {"japon": "JP", "coree": "KR", "coree du sud": "KR", "chine": "CN", "taiwan": "TW", "france": "FR"}


def _bloc_volume(page: str, debut: str, fin: str | None) -> tuple[int | None, str | None]:
    """Numéro de tome et date (AAAA-MM-JJ) d'un encadré « Dernier paru » ou « A paraître »."""
    i = page.find(debut)
    if i < 0:
        return None, None
    j = page.find(fin, i + len(debut)) if fin else -1
    bloc = page[i: j if j > i else i + 2500]
    v, d = RE_VOL.search(bloc), RE_DATE.search(bloc)
    return (int(v.group(1)) if v else None), (f"{d.group(3)}-{d.group(2)}-{d.group(1)}" if d else None)


def fiche_manga_news(url: str | None) -> dict | None:
    """Lit la fiche d'une série sur Manga-News : « VF : 20 (Terminé) », « VO : 20 (Terminé) »,
    le dernier tome paru et le prochain annoncé."""
    global _dernier_mn
    if not url:
        return None
    attente = 2.0 - (time.time() - _dernier_mn)
    if attente > 0:
        time.sleep(attente)
    _dernier_mn = time.time()
    import html as h
    page = http(url).decode("utf-8", errors="replace")
    page = h.unescape(re.sub(r"<script.*?</script>|<style.*?</style>", " ", page, flags=re.S))
    texte = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", page))
    vf, vo = RE_VF.search(texte), RE_VO.search(texte)
    og = re.search(r'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', page) or re.search(r'<meta[^>]+content="([^"]+)"[^>]+property="og:image"', page)
    couv = og.group(1).strip() if og and "/public/images/" in og.group(1) else ""
    r = {"url": url, **({"couv": couv} if couv else {})}
    if not vf and not vo:
        # Webtoon : la fiche compte les chapitres en ligne, sans état de l'édition papier ;
        # on garde au moins la date du dernier tome paru en France.
        _, d = _bloc_volume(page, "Dernier paru", "paraître")
        return {"url": url, "lu": False, **({"vfDernierDate": d} if d else {}), **({"couv": couv} if couv else {}),
                "verifie": AUJOURDHUI.isoformat()}
    if vf:
        r.update(vf=int(vf.group(1)), vfStatut=vf.group(2).strip())
    if vo:
        r.update(vo=int(vo.group(1)), voStatut=vo.group(2).strip())
    n, d = _bloc_volume(page, "Dernier paru", "paraître")
    if n:
        r["vfDernier"] = n
    if d:
        r["vfDernierDate"] = d
    n, d = _bloc_volume(page, "A paraître", "Acheter")
    if d and d > AUJOURDHUI.isoformat():
        r["vfProchainDate"] = d
        if n:
            r["vfProchain"] = n
    o = re.search(r"Origine\s*:\s*([^\-:|]{3,30}?)\s*-\s*(\d{4})", texte)
    if o:
        pays = PAYS_MN.get(sans_accents(o.group(1)).strip().lower())
        if pays:
            r["pays"] = pays
        r["annee"] = int(o.group(2))
    r["verifie"] = AUJOURDHUI.isoformat()
    return r


def fiche_a_lire(e: dict, forcer: bool = False) -> bool:
    f = e.get("mangaNewsFiche") or {}
    if forcer or not f.get("verifie") or f.get("lu") is False:
        return True  # (les fiches illisibles, des webtoons surtout, sont rares : on les relit à chaque passage)
    fini = "termin" in sans_accents(f.get("vfStatut") or "").lower()
    return age_jours(f.get("verifie")) >= (90 if fini else 6)

def lire_fiche(s: dict, e: dict, forcer: bool = False, debug: bool = False) -> None:
    """Met à jour e["mangaNewsFiche"] si c'est le moment ; une erreur ne fait pas perdre le reste."""
    url = url_manga_news(s, e.get("mangaNews"))
    if not url:
        e.pop("mangaNewsFiche", None)  # la page lue avant n'était pas la bonne
        return
    autre_page = chemin_mn((e.get("mangaNewsFiche") or {}).get("url") or "") != chemin_mn(url)
    if not (debug or autre_page or fiche_a_lire(e, forcer)):
        return
    try:
        e["mangaNewsFiche"] = fiche_manga_news(url)
    except Exception as ex:
        print(f"  fiche Manga-News : {ex}", file=sys.stderr, flush=True)
        if "404" not in str(ex) and "410" not in str(ex):
            return
        e["mangaNewsFiche"] = {"url": url, "lu": False, "verifie": AUJOURDHUI.isoformat()}
        # La page indiquée (souvent reprise de l'ancien Excel) a disparu : on essaie celle du jeu de données
        secours = (e.get("mangaNews") or {}).get("url")
        if secours and secours != url and not (e.get("mangaNews") or {}).get("editeurDifferent"):
            try:
                f = fiche_manga_news(secours)
                if f:
                    f["secours"] = True
                    e["mangaNewsFiche"] = f
            except Exception as ex2:
                print(f"  fiche Manga-News (secours) : {ex2}", file=sys.stderr, flush=True)
    if debug:
        dbg(f"    Fiche Manga-News lue : {e.get('mangaNewsFiche')}")
        if (e.get("mangaNewsFiche") or {}).get("lu") is False:
            tester_page_manga_news({"url": url})

# --------------------------------------------------------------------------- BnF

SRU = "https://catalogue.bnf.fr/api/SRU"
EXCLUS = re.compile(r"\b(roman|novel|artbook|art book|guide|fanbook|databook|coloriage|anime comics|film|coffret|calendrier|agenda|carnet|light novel)\b", re.I)
_dernier_bnf = 0.0


def bnf_page(query: str, debut: int) -> ET.Element:
    global _dernier_bnf
    attente = 1.0 - (time.time() - _dernier_bnf)
    if attente > 0:
        time.sleep(attente)
    _dernier_bnf = time.time()
    params = {
        "version": "1.2", "operation": "searchRetrieve", "query": query,
        "recordSchema": "unimarcXchange", "maximumRecords": "100", "startRecord": str(debut),
    }
    brut = http(SRU + "?" + urllib.parse.urlencode(params))
    return ET.fromstring(brut)


def sans_ns(tag: str) -> str:
    return tag.split("}")[-1]


def champs(rec: ET.Element) -> dict[str, list[dict[str, list[str]]]]:
    out: dict[str, list[dict[str, list[str]]]] = {}
    for el in rec.iter():
        if sans_ns(el.tag) == "datafield":
            sf: dict[str, list[str]] = {}
            for s in el:
                if sans_ns(s.tag) == "subfield":
                    sf.setdefault(s.get("code"), []).append((s.text or "").strip())
            out.setdefault(el.get("tag"), []).append(sf)
    return out


def premier(f: dict, tag: str, code: str) -> str:
    for occ in f.get(tag, []):
        if occ.get(code):
            return occ[code][0]
    return ""


def numero(s: str) -> int | None:
    m = re.search(r"(?<!\d)(\d{1,3})(?!\d)", s or "")
    return int(m.group(1)) if m else None


# Les éditeurs de mangas apparaissent sous plusieurs noms à la BnF (« Kana », « Dargaud Bénélux-Kana »,
# « Dargaud-Lombard Kana »…). On les ramène à un nom unique ; l'ordre compte (vega avant dupuis).
EDITEURS = ["kana", "glenat", "pika", "kurokawa", "kioon", "crunchyroll", "kaze", "delcourt", "tonkam", "akata",
            "ankama", "panini", "soleil", "casterman", "dokidoki", "mangetsu", "meian", "noeve", "vega", "dupuis",
            "nobinobi", "komikku", "imho", "taifu", "ototo", "akileos", "blackbox", "bamboo", "jailu", "michellafon",
            "hachette", "kotoji", "kbooks", "sakka", "pika", "kidpaddle", "dargaud", "lezard", "omake", "boykoff",
            "neotoon", "hugo", "albinmichel", "webtoonfr", "michel"]
ALIAS_EDITEURS = {"dargaud": "kana", "tonkam": "delcourt", "kaze": "crunchyroll", "sakka": "casterman",
                  "neotoon": "hugo", "albinmichel": "albin", "michel": "albin"}


def norm_editeur(e: str) -> str:
    s = sans_accents(e or "").lower()
    brut = re.sub(r"[^a-z0-9]", "", s)
    for nom in EDITEURS:
        if nom in brut:
            return ALIAS_EDITEURS.get(nom, nom)
    s = re.sub(r"\b(editions?|ed|impr|imprimerie|maury|sa|sas|france|publishing|presse)\b\.?", " ", s)
    return re.sub(r"[^a-z0-9]", "", s)


def notices_bnf(serie: dict, editeur_orphee: str, volumes_vo: int | None = None, debug: bool = False) -> dict | None:
    titres = titres_de(serie)
    cles_ok = {cle(t) for t in titres}
    requete = f'bib.title all "{mots(serie["titre"])}" and (bib.doctype="a")'
    tomes: list[dict] = []
    debut, total = 1, None
    while True:
        racine = bnf_page(requete, debut)
        if total is None:
            n = next((e.text for e in racine.iter() if sans_ns(e.tag) == "numberOfRecords"), "0")
            total = int(n or 0)
            if debug:
                dbg(f"    BnF {requete} -> {total} notices")
        recs = [e for e in racine.iter() if sans_ns(e.tag) == "recordData"]
        for rd in recs:
            f = champs(rd)
            lang = premier(f, "101", "a")
            if lang and lang != "fre":
                continue
            titre = premier(f, "200", "a")
            serie_t = premier(f, "461", "t") or premier(f, "225", "a")
            texte = " ".join([titre, premier(f, "200", "e"), premier(f, "200", "i"), serie_t, premier(f, "225", "e")])
            if EXCLUS.search(texte):
                continue
            if not ({cle(titre), cle(serie_t)} & cles_ok):
                continue
            num = numero(premier(f, "461", "v")) or numero(premier(f, "225", "v")) or numero(premier(f, "200", "h"))
            if num is None or num > 300:
                continue
            editeur = premier(f, "214", "c") or premier(f, "210", "c")
            annee = numero_annee(premier(f, "214", "d") or premier(f, "210", "d"))
            creee = premier(f, "100", "a")[:8]
            ark = next((m.group(0) for el in rd.iter() if sans_ns(el.tag) == "controlfield" and el.get("tag") == "003"
                        for m in [re.search(r"ark:/12148/[a-z0-9]+", el.text or "")] if m), None)
            isbn = re.sub(r"[^0-9Xx]", "", premier(f, "010", "a")) or None
            tomes.append({"n": num, "editeur": editeur, "annee": annee, "creee": creee, "ark": ark, "isbn": isbn})
            if debug:
                dbg(f"      t{num} | {titre} | {serie_t} | {editeur} | {annee} | {creee}")
        debut += 100
        if debut > min(total or 0, 600):
            break
    if not tomes:
        return {"dernier": None, "notices": 0, "requete": requete}
    # Une série peut exister chez plusieurs éditeurs (rééditions) : on garde celui d'Orphée,
    # sinon celui qui a le plus de tomes.
    groupes: dict[str, list[dict]] = {}
    for t in tomes:
        groupes.setdefault(norm_editeur(t["editeur"]), []).append(t)
    eo = norm_editeur(editeur_orphee)
    choix = None
    if eo:
        choix = next((k for k in groupes if k and (k in eo or eo in k)), None)
    if choix is None:
        choix = max(groupes, key=lambda k: len({t["n"] for t in groupes[k]}))
    g = groupes[choix]
    nums = sorted({t["n"] for t in g})
    # Numéro isolé très loin des autres (ex. « 202 » lu dans « 2024 ») : on l'écarte.
    while len(nums) > 1 and nums[-1] - nums[-2] > 20:
        nums.pop()
    dernier = max(nums)
    plusieurs_editions = False
    # Plus de tomes en France qu'au Japon : souvent deux éditions mélangées (ex. Akira 14 tomes
    # couleur puis 6 tomes en édition originale). Si tous les tomes de la VO sont là, on s'y tient.
    if volumes_vo and dernier > volumes_vo and all(n in nums for n in range(1, volumes_vo + 1)):
        dernier, plusieurs_editions = volumes_vo, True
        nums = [n for n in nums if n <= volumes_vo]
    rec_dernier = max((t for t in g if t["n"] == dernier), key=lambda t: t["creee"] or "")
    # Candidats pour la couverture : le tome 1 de l'édition retenue (réédition la plus récente
    # d'abord), puis les tomes suivants.
    candidats = sorted((t for t in g if (t["ark"] or t["isbn"]) and t["n"] in nums),
                       key=lambda t: (t["n"], -int(t["creee"]) if (t["creee"] or "").isdigit() else 0))
    candidats = [{"n": t["n"], "ark": t["ark"], "isbn": t["isbn"]} for t in candidats][:4]
    t1 = candidats[0] if candidats else None
    date = None
    if rec_dernier["creee"] and len(rec_dernier["creee"]) == 8:
        a, m = rec_dernier["creee"][:4], rec_dernier["creee"][4:6]
        date = f"{a}-{m}" if not rec_dernier["annee"] or str(rec_dernier["annee"]) == a else str(rec_dernier["annee"])
    elif rec_dernier["annee"]:
        date = str(rec_dernier["annee"])
    return {
        "dernier": dernier,
        "tomes": compacte(nums),
        "dateDernier": date,
        "editeur": g[0]["editeur"],
        "notices": len(g),
        "autresEditeurs": sorted({t["editeur"] for k, v in groupes.items() if k != choix for t in v})[:5],
        **({"plusieursEditions": True} if plusieurs_editions else {}),
        **({"ark1": t1["ark"], "isbn1": t1["isbn"], "candidatsCouv": candidats} if t1 else {}),
        "requete": requete,
    }


DOSSIER_COUV = RACINE / "couvertures"


def telecharger(url: str, essais: int = 3) -> bytes | None:
    """Télécharge une image ; réessaie après une pause si le site est saturé (trop de demandes d'affilée)."""
    h = {"User-Agent": UA}
    if "manga-news.com" in url:
        h["Referer"] = "https://www.manga-news.com/"
    for i in range(essais):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=40) as r:
                if not (r.headers.get("Content-Type") or "").startswith("image/"):
                    return None
                corps = r.read()
                return corps if len(corps) > 1500 else None
        except urllib.error.HTTPError as e:
            if e.code in (403, 408, 429, 500, 502, 503, 504) and i < essais - 1:
                time.sleep(8 * (i + 1))
                continue
            return None
        except Exception:
            if i < essais - 1:
                time.sleep(5 * (i + 1))
                continue
            return None
    return None


COUV_VERSION = 2  # 2 : Manga-News ajouté aux sources ; les séries sans couverture sont réessayées une fois


def couverture_fr(ident: str, bnf: dict | None, mn: dict | None = None, debug: bool = False, fiche: dict | None = None) -> dict | None:
    """Cherche la couverture française (Manga-News, BnF, puis Open Library) et l'enregistre en vignette."""
    try:
        from PIL import Image
    except ImportError:
        return None
    import io
    fichier = DOSSIER_COUV / f"{ident}.jpg"
    essais = []
    # Manga-News d'abord : fiable et rapide (la BnF répond souvent en erreur 500)
    vues = set()
    for u in [(mn or {}).get("couv") if not (mn or {}).get("editeurDifferent") else "", (fiche or {}).get("couv")]:
        if u and u not in vues:
            vues.add(u)
            essais.append(("Manga-News", u if u.startswith("http") else "https://www.manga-news.com/" + u.lstrip("/"), None))
    for c in (bnf or {}).get("candidatsCouv", []):
        if c.get("ark"):
            essais.append(("BnF", f"https://catalogue.bnf.fr/couverture?appName=NE&idArk={c['ark']}&couverture=1", c["n"]))
        if c.get("isbn"):
            essais.append(("Open Library", f"https://covers.openlibrary.org/b/isbn/{c['isbn']}-M.jpg?default=false", c["n"]))
    for nom, url, tome in essais:
        time.sleep(0.8)
        corps = telecharger(url)
        if not corps:
            if debug:
                dbg(f"    couverture {nom} : rien <- {url}")
            continue
        try:
            img = Image.open(io.BytesIO(corps)).convert("RGB")
        except Exception as ex:
            if debug:
                dbg(f"    couverture {nom} : illisible ({ex}) <- {url}")
            continue
        if img.width < 80 or img.height < 100 or not (1.05 < img.height / img.width < 2.2):
            if debug:
                dbg(f"    couverture {nom} : {img.width}×{img.height} refusée <- {url}")
            continue  # vignette vide, image trop petite ou pas au format d'une couverture
        img.thumbnail((300, 460))
        if debug:
            dbg(f"    couverture {nom} : OK {img.width}×{img.height} <- {url}")
            return {"source": nom, "tome": tome, "test": True}
        DOSSIER_COUV.mkdir(exist_ok=True)
        img.save(fichier, "JPEG", quality=82, optimize=True, progressive=True)
        return {"source": nom, **({"tome": tome} if tome else {}), **({"mn": (mn or {}).get("url") or (fiche or {}).get("url")} if nom == "Manga-News" else {}),
                "maj": AUJOURDHUI.isoformat()}
    return None


def couverture_a_chercher(s: dict, e: dict, forcer: bool = False) -> bool:
    if forcer:
        return True
    cf = e.get("couvFR")
    page_mn = (e.get("mangaNews") or {}).get("url") or (e.get("mangaNewsFiche") or {}).get("url")
    if cf:
        # image prise sur une page Manga-News qui n'est plus celle de la série (rapprochement corrigé)
        if cf.get("source") == "Manga-News" and ("mn" not in cf or cf["mn"] != page_mn):
            return True
        return not (DOSSIER_COUV / f"{s['id']}.jpg").exists()
    # Manga-News a une image pour cette série : on réessaie à chaque passage (un échec vient en général
    # d'un site saturé ce jour-là), et tout de suite si l'image a changé
    couv_mn = (e.get("mangaNews") or {}).get("couv") or (e.get("mangaNewsFiche") or {}).get("couv")
    if couv_mn and (couv_mn != e.get("couvEssaiMN") or age_jours(e.get("couvEssai")) >= 1):
        return True
    # jamais essayé, nouvelle source depuis le dernier essai, ou dernier essai il y a plus de 6 mois
    return (e.get("couvVersion") or 1) < COUV_VERSION or age_jours(e.get("couvEssai")) > 180


def chercher_couverture(s: dict, e: dict) -> None:
    trouvee = couverture_fr(s["id"], e.get("bnf"), e.get("mangaNews"), fiche=e.get("mangaNewsFiche"))
    e["couvEssai"] = AUJOURDHUI.isoformat()
    e["couvVersion"] = COUV_VERSION
    e["couvEssaiMN"] = (e.get("mangaNews") or {}).get("couv") or (e.get("mangaNewsFiche") or {}).get("couv") or ""
    if trouvee:
        e["couvFR"] = trouvee
    else:
        e.pop("couvFR", None)


def tester_page_manga_news(mn: dict | None) -> None:
    """Mode test : télécharge la fiche Manga-News et affiche le texte autour des volumes VF / VO."""
    url = (mn or {}).get("url")
    if not url:
        dbg("    Fiche Manga-News : pas d'adresse")
        return
    try:
        html = http(url).decode("utf-8", errors="replace")
    except Exception as ex:
        dbg(f"    Fiche Manga-News : ÉCHEC {ex}")
        return
    dbg(f"    Fiche Manga-News : {len(html)} caractères")
    texte = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S)
    for motif in ["numberblock", "Les Volumes", "Nb volumes", "Statut", "VF", "Dernier paru", "paraître"]:
        for m in list(re.finditer(re.escape(motif), texte))[:2]:
            extrait = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " | ", texte[max(0, m.start() - 60): m.end() + 700]))
            dbg(f"      [{motif}] …{extrait[:700]}…")


def tester_couvertures(bnf: dict) -> None:
    """Mode test : essaie plusieurs sources de couverture pour le tome 1 et affiche le résultat."""
    ark, isbn = bnf.get("ark1"), bnf.get("isbn1")
    dbg(f"    Couvertures : ark={ark} isbn={isbn}")
    essais = []
    if ark:
        essais.append(("BnF", f"https://catalogue.bnf.fr/couverture?appName=NE&idArk={ark}&couverture=1"))
    if isbn:
        essais.append(("OpenLibrary", f"https://covers.openlibrary.org/b/isbn/{isbn}-M.jpg?default=false"))
        essais.append(("GoogleBooks", f"https://www.googleapis.com/books/v1/volumes?q=isbn:{isbn}"))
    for nom, url in essais:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                corps = r.read()
                info = f"{r.status} {r.headers.get('Content-Type')} {len(corps)} octets"
                if nom == "GoogleBooks":
                    items = json.loads(corps).get("items") or []
                    liens = [(i.get("volumeInfo") or {}).get("imageLinks") for i in items]
                    info += f" items={len(items)} images={liens[:1]}"
                dbg(f"      {nom}: {info} <- {url}")
        except Exception as ex:
            dbg(f"      {nom}: ÉCHEC {ex} <- {url}")


def numero_annee(s: str) -> int | None:
    m = re.search(r"(19|20)\d{2}", s or "")
    return int(m.group(0)) if m else None


def compacte(nums: list[int]) -> str:
    out, i = [], 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(f"{nums[i]}-{nums[j]}" if j > i else str(nums[i]))
        i = j + 1
    return ",".join(out)

# --------------------------------------------------------------------------- programme


def age_jours(d: str | None) -> int:
    if not d:
        return 10**6
    try:
        return (AUJOURDHUI - dt.date.fromisoformat(d[:10])).days
    except ValueError:
        return 10**6


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limite", type=int, default=0, help="nombre max de séries à vérifier")
    ap.add_argument("--serie", default="", help="identifiant d'une seule série (test, affiche le détail)")
    ap.add_argument("--max-minutes", type=float, default=100)
    ap.add_argument("--forcer", action="store_true", help="ignorer le cache")
    ap.add_argument("--bnf-seulement", action="store_true", help="refaire seulement la BnF (garde AniList)")
    ap.add_argument("--verifier-auteurs", action="store_true", help="revérifier les liens AniList automatiques avec l'auteur d'Orphée")
    ap.add_argument("--manga-news-seulement", action="store_true", help="mettre à jour seulement le nombre de tomes Manga-News (rapide)")
    ap.add_argument("--couvertures", action="store_true", help="chercher seulement les couvertures qui manquent (Manga-News compris)")
    ap.add_argument("--series", default="", help="revérifier et enregistrer ces séries (identifiants séparés par des virgules)")
    args = ap.parse_args()

    series = json.loads((DATA / "series.json").read_text())["series"]
    fonds = json.loads((DATA / "fonds.json").read_text())["series"]
    chemin = DATA / "enrich.json"
    enrich = json.loads(chemin.read_text()) if chemin.exists() else {}
    cache: dict = enrich.get("series") or {}
    debut = time.time()
    debug = bool(args.serie)
    choisies = {x.strip() for x in args.series.split(",") if x.strip()}
    if choisies:
        args.forcer = True  # demandé depuis le site : tout refaire pour ces séries

    a_faire = []
    for s in series:
        if args.serie and s["id"] != args.serie:
            continue
        if choisies and s["id"] not in choisies:
            continue
        if not args.serie and not choisies and s["id"] not in fonds:
            continue  # seulement les séries présentes dans le réseau
        a_faire.append(s)
    # les jamais vérifiées d'abord, puis les plus anciennes
    a_faire.sort(key=lambda s: -age_jours((cache.get(s["id"]) or {}).get("verifie")))

    faites = erreurs = consecutives = 0
    for s in a_faire:
        if args.limite and faites >= args.limite:
            break
        if (time.time() - debut) / 60 > args.max_minutes:
            print("Temps maximum atteint, la suite au prochain passage.")
            break
        e = cache.get(s["id"]) or {}
        lien = (s.get("liens") or {}).get("anilist")
        al = e.get("anilist")
        termine = bool(al and al.get("statut") == "FINISHED")
        complet = termine and al.get("volumes") and (e.get("bnf") or {}).get("dernier") and e["bnf"]["dernier"] >= al["volumes"]
        complet = complet or "termin" in sans_accents((e.get("mangaNewsFiche") or {}).get("vfStatut") or "").lower()
        auteur = (fonds.get(s["id"]) or {}).get("auteur", "")
        maxi = max((n for l in ((fonds.get(s["id"]) or {}).get("tomes") or {}).values() for n in l), default=0)
        editeur = (fonds.get(s["id"]) or {}).get("editeur", "")
        if args.couvertures:
            # rapprochement Manga-News refait pour toutes les séries (rapide), fiche relue si la page a changé
            e.setdefault("liensVus", s.get("liens") or {})
            e["mangaNews"] = tomes_manga_news(s, editeur, debug, e.get("anilist"), auteur, maxi)
            if s.get("type") != "One shot" or (s.get("liens") or {}).get("mangaNews"):
                lire_fiche(s, e, False, debug)
            if not couverture_a_chercher(s, e, args.forcer):
                cache[s["id"]] = e
                continue
            try:
                if debug:
                    couverture_fr(s["id"], e.get("bnf"), e.get("mangaNews"), debug=True, fiche=e.get("mangaNewsFiche"))
                else:
                    chercher_couverture(s, e)
            except Exception as ex:
                print(f"  couverture : {ex}", file=sys.stderr, flush=True)
            cache[s["id"]] = e
            faites += 1
            if faites % 40 == 0:
                ecrire(chemin, cache)
            continue
        if args.manga_news_seulement:
            if s.get("type") != "One shot":
                e["mangaNews"] = tomes_manga_news(s, editeur, debug, e.get("anilist"), auteur, maxi)
                lire_fiche(s, e, args.forcer, debug)
                cache[s["id"]] = e
                faites += 1
                if faites % 50 == 0:
                    ecrire(chemin, cache)
            continue
        if args.verifier_auteurs:
            # Revérifie les liens AniList trouvés automatiquement, sans toucher à la BnF ni aux couvertures
            if lien or not auteur or s.get("type") == "One shot":
                if s.get("type") != "One shot":
                    e["mangaNews"] = tomes_manga_news(s, editeur, debug, e.get("anilist"), auteur, maxi)
                    lire_fiche(s, e, False, debug)
                    cache[s["id"]] = e
                continue
            print(f"- {s['titre']}", flush=True)
            try:
                e["anilist"] = chercher_anilist(s, auteur, debug)
                e["mangaNews"] = tomes_manga_news(s, editeur, debug, e.get("anilist"), auteur, maxi)
                lire_fiche(s, e, False, debug)
                e["anilistVerifie"] = AUJOURDHUI.isoformat()
                cache[s["id"]] = e
                faites += 1
            except Exception as ex:
                erreurs += 1
                print(f"  erreur : {ex}", file=sys.stderr, flush=True)
            if faites and faites % 25 == 0:
                ecrire(chemin, cache)
            continue
        if not args.forcer and not debug and not args.bnf_seulement:
            recent = age_jours(e.get("verifie")) < (120 if complet else 6)
            # liens modifiés dans le site (page Manga-News, AniList…) depuis la dernière vérification
            liens_changes = "liensVus" in e and (s.get("liens") or {}) != e["liensVus"]
            if recent and not liens_changes and not (lien and (not al or al.get("id") != lien)):
                continue
        print(f"- {s['titre']}", flush=True)
        try:
            one_shot = s.get("type") == "One shot"
            # AniList
            if args.bnf_seulement:
                pass
            elif lien:
                if not al or al.get("id") != lien or age_jours(e.get("anilistVerifie")) > 6 or args.forcer:
                    m = anilist(Q_ID, {"id": int(lien)}).get("Media")
                    e["anilist"] = resume_anilist(m, False, None) if m else {"id": lien, "titre": "Introuvable sur AniList", "statut": None, "auto": False}
                    e["anilistVerifie"] = AUJOURDHUI.isoformat()
            elif not one_shot and s.get("genre") != "Comics":  # pas de comics sur AniList
                deja_vu_sans = e.get("anilistVerifie") and al is None and age_jours(e.get("anilistVerifie")) < 30
                if args.forcer or debug or not (al or deja_vu_sans) or (al and al.get("statut") != "FINISHED"):
                    if al and al.get("id") and not al.get("auteurDifferent"):
                        m = anilist(Q_ID, {"id": al["id"]}).get("Media")
                        e["anilist"] = resume_anilist(m, True, al.get("score")) if m else None
                        if m and meme_auteur(auteur, m) is False:
                            e["anilist"] = chercher_anilist(s, auteur, debug)
                    else:
                        e["anilist"] = chercher_anilist(s, auteur, debug)
                    e["anilistVerifie"] = AUJOURDHUI.isoformat()
            if one_shot:
                # un one shot : seulement Manga-News, pour la couverture (et la page indiquée, si elle n'est pas dans le jeu de données)
                e["mangaNews"] = tomes_manga_news(s, editeur, debug, e.get("anilist"), auteur, maxi)
                if (s.get("liens") or {}).get("mangaNews"):
                    lire_fiche(s, e, args.forcer, debug)
            # BnF
            if not one_shot:
                vo = (e.get("anilist") or {}).get("volumes") if (e.get("anilist") or {}).get("statut") == "FINISHED" else None
                e["bnf"] = notices_bnf(s, (fonds.get(s["id"]) or {}).get("editeur", ""), vo, debug)
                e["bnfVerifie"] = AUJOURDHUI.isoformat()
                e["mangaNews"] = tomes_manga_news(s, editeur, debug, e.get("anilist"), auteur, maxi)
                lire_fiche(s, e, args.forcer, debug)
            # Couverture française, une seule fois (puis tous les 6 mois si elle manque)
            if not debug and couverture_a_chercher(s, e, args.forcer):
                chercher_couverture(s, e)
            e["verifie"] = AUJOURDHUI.isoformat()
            e["liensVus"] = s.get("liens") or {}
            cache[s["id"]] = e
            faites += 1
            if debug:
                if e.get("bnf"):
                    tester_couvertures(e["bnf"])
                couverture_fr(s["id"], e.get("bnf"), e.get("mangaNews"), debug=True, fiche=e.get("mangaNewsFiche"))
                dbg(json.dumps(e, ensure_ascii=False, indent=1))
        except Exception as ex:  # une série en erreur ne bloque pas les autres
            erreurs += 1
            consecutives += 1
            print(f"  erreur : {ex}", file=sys.stderr, flush=True)
            if erreurs <= 8:
                print(f"::warning title=Erreur sur {s['titre'][:40]}::{str(ex)[:300]}", flush=True)
            if consecutives >= 5:
                print("Plusieurs erreurs de suite : pause de 3 minutes.", flush=True)
                time.sleep(180)
                consecutives = 0
            if erreurs > 40:
                print("::warning title=Arrêt anticipé::Trop d'erreurs (source indisponible ?). Les séries déjà vérifiées sont enregistrées, la suite au prochain passage.", flush=True)
                break
            continue
        consecutives = 0
        if faites and faites % 25 == 0:
            ecrire(chemin, cache)

    if debug:
        annoter("\n".join(JOURNAL))
    else:
        ecrire(chemin, cache)
    reliees = sum(1 for v in cache.values() if v.get("anilist"))
    avec_bnf = sum(1 for v in cache.values() if (v.get("bnf") or {}).get("dernier"))
    print(f"Vérifiées ce passage : {faites}, erreurs : {erreurs}. Total : {len(cache)} séries, {reliees} reliées à AniList, {avec_bnf} trouvées à la BnF.")
    return 0


def annoter(texte: str) -> None:
    """En test, renvoie le détail sous forme d'annotations GitHub (lisibles par l'API)."""
    import os
    if not os.environ.get("GITHUB_ACTIONS"):
        return
    morceaux = [texte[i:i + 3500] for i in range(0, len(texte), 3500)][:9]
    for n, m in enumerate(morceaux, 1):
        m = m.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
        print(f"::notice title=Test {n}/{len(morceaux)}::{m}", flush=True)


def ecrire(chemin: Path, cache: dict) -> None:
    contenu = {
        "maj": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": "AniList (anilist.co) ; BnF, catalogue général (Licence Ouverte) ; Manga-News via data.gouv.fr (ODbL) ; couvertures : BnF, Open Library",
        "series": dict(sorted(cache.items())),
    }
    chemin.write_text(json.dumps(contenu, ensure_ascii=False, indent=1) + "\n")


if __name__ == "__main__":
    sys.exit(main())
