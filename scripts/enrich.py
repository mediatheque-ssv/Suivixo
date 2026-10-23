#!/usr/bin/env python3
"""Vérifie les parutions des séries (lancé chaque semaine par GitHub Actions).

- AniList : état de la série au Japon (terminée, en cours…) et nombre de tomes en VO.
- BnF (catalogue général, dépôt légal) : tomes réellement parus en France et date du dernier.

Écrit data/enrich.json. Ne touche jamais à series.json ni à fonds.json.
Données BnF : Licence Ouverte (Etalab). Données AniList : https://anilist.co
"""
from __future__ import annotations

import argparse
import datetime as dt
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


def http(url: str, data: bytes | None = None, headers: dict | None = None, essais: int = 4) -> bytes:
    h = {"User-Agent": UA, **(headers or {})}
    for i in range(essais):
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                attente = int(e.headers.get("Retry-After", "60") or 60) + 1
                print(f"  limite atteinte, pause {attente}s", flush=True)
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

CHAMPS = "id title { romaji english native } synonyms status volumes chapters format countryOfOrigin genres tags { name rank } coverImage { medium } siteUrl"
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
    meilleur = 0.0
    cles = [cle(t) for t in titres]
    for n in noms(m):
        kn = cle(n)
        for k in cles:
            if not k or not kn:
                continue
            if k == kn:
                return 1.0
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
        "auto": auto,
        **({"score": round(sc, 3)} if sc is not None else {}),
    }


def chercher_anilist(serie: dict, debug: bool = False) -> dict | None:
    titres = titres_de(serie)
    meilleur, meilleur_sc = None, 0.0
    for q in titres[:3]:
        data = anilist(Q_CHERCHE, {"q": q})
        cands = [m for m in (data.get("Page") or {}).get("media", []) if m.get("format") not in ("NOVEL",)]
        for m in cands:
            sc = score(titres, m)
            if debug:
                dbg(f"    [{q}] {m['id']} {noms(m)[:3]} {m.get('status')} vol={m.get('volumes')} score={sc:.2f}")
            if sc > meilleur_sc:
                meilleur, meilleur_sc = m, sc
        if meilleur_sc >= 0.95:
            break
    if meilleur and meilleur_sc >= 0.75:
        return resume_anilist(meilleur, True, meilleur_sc)
    return None

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


def norm_editeur(e: str) -> str:
    s = sans_accents(e or "").lower()
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
            tomes.append({"n": num, "editeur": editeur, "annee": annee, "creee": creee})
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
    dernier = max(nums)
    plusieurs_editions = False
    # Plus de tomes en France qu'au Japon : souvent deux éditions mélangées (ex. Akira 14 tomes
    # couleur puis 6 tomes en édition originale). Si tous les tomes de la VO sont là, on s'y tient.
    if volumes_vo and dernier > volumes_vo and all(n in nums for n in range(1, volumes_vo + 1)):
        dernier, plusieurs_editions = volumes_vo, True
        nums = [n for n in nums if n <= volumes_vo]
    rec_dernier = max((t for t in g if t["n"] == dernier), key=lambda t: t["creee"] or "")
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
        "requete": requete,
    }


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
    args = ap.parse_args()

    series = json.loads((DATA / "series.json").read_text())["series"]
    fonds = json.loads((DATA / "fonds.json").read_text())["series"]
    chemin = DATA / "enrich.json"
    enrich = json.loads(chemin.read_text()) if chemin.exists() else {}
    cache: dict = enrich.get("series") or {}
    debut = time.time()
    debug = bool(args.serie)

    a_faire = []
    for s in series:
        if args.serie and s["id"] != args.serie:
            continue
        if not args.serie and s["id"] not in fonds:
            continue  # seulement les séries présentes dans le réseau
        if s.get("genre") == "Comics":
            continue
        a_faire.append(s)
    # les jamais vérifiées d'abord, puis les plus anciennes
    a_faire.sort(key=lambda s: -age_jours((cache.get(s["id"]) or {}).get("verifie")))

    faites = erreurs = 0
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
        if not args.forcer and not debug:
            recent = age_jours(e.get("verifie")) < (120 if complet else 6)
            if recent and not (lien and (not al or al.get("id") != lien)):
                continue
        print(f"- {s['titre']}", flush=True)
        try:
            one_shot = s.get("type") == "One shot"
            # AniList
            if lien:
                if not al or al.get("id") != lien or age_jours(e.get("anilistVerifie")) > 6 or args.forcer:
                    m = anilist(Q_ID, {"id": int(lien)}).get("Media")
                    e["anilist"] = resume_anilist(m, False, None) if m else {"id": lien, "titre": "Introuvable sur AniList", "statut": None, "auto": False}
                    e["anilistVerifie"] = AUJOURDHUI.isoformat()
            elif not one_shot:
                deja_vu_sans = e.get("anilistVerifie") and al is None and age_jours(e.get("anilistVerifie")) < 30
                if args.forcer or debug or not (al or deja_vu_sans) or (al and al.get("statut") != "FINISHED"):
                    if al and al.get("id"):
                        m = anilist(Q_ID, {"id": al["id"]}).get("Media")
                        e["anilist"] = resume_anilist(m, True, al.get("score")) if m else None
                    else:
                        e["anilist"] = chercher_anilist(s, debug)
                    e["anilistVerifie"] = AUJOURDHUI.isoformat()
            # BnF
            if not one_shot:
                vo = (e.get("anilist") or {}).get("volumes") if (e.get("anilist") or {}).get("statut") == "FINISHED" else None
                e["bnf"] = notices_bnf(s, (fonds.get(s["id"]) or {}).get("editeur", ""), vo, debug)
                e["bnfVerifie"] = AUJOURDHUI.isoformat()
            e["verifie"] = AUJOURDHUI.isoformat()
            cache[s["id"]] = e
            faites += 1
            if debug:
                dbg(json.dumps(e, ensure_ascii=False, indent=1))
        except Exception as ex:  # une série en erreur ne bloque pas les autres
            erreurs += 1
            print(f"  erreur : {ex}", file=sys.stderr, flush=True)
            if erreurs > 25:
                print("Trop d'erreurs, arrêt.", file=sys.stderr)
                break
        if faites and faites % 25 == 0:
            ecrire(chemin, cache)

    if debug:
        annoter("\n".join(JOURNAL))
    else:
        ecrire(chemin, cache)
    reliees = sum(1 for v in cache.values() if v.get("anilist"))
    avec_bnf = sum(1 for v in cache.values() if (v.get("bnf") or {}).get("dernier"))
    print(f"Vérifiées ce passage : {faites}, erreurs : {erreurs}. Total : {len(cache)} séries, {reliees} reliées à AniList, {avec_bnf} trouvées à la BnF.")
    return 0 if erreurs <= 25 else 1


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
        "sources": "AniList (anilist.co) ; BnF, catalogue général (Licence Ouverte)",
        "series": dict(sorted(cache.items())),
    }
    chemin.write_text(json.dumps(contenu, ensure_ascii=False, indent=1) + "\n")


if __name__ == "__main__":
    sys.exit(main())
