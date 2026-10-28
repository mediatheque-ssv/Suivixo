"""Essai ponctuel : quelles sources trouvent les couvertures qui manquent (BD et romans jeunesse) ?
Rien n'est enregistré dans les données : les images trouvées vont dans essai/ pour être regardées."""
import hashlib, io, json, os, re, sys, time, urllib.parse, urllib.request, urllib.error
from pathlib import Path
from PIL import Image

UA = "Suivixo/1.0 (médiathèque de Servon-sur-Vilaine; https://github.com/mediatheque-ssv/Suivixo)"
SORTIE = Path("essai")


def isbn13(i):
    i = re.sub(r"[^0-9Xx]", "", i or "")
    if len(i) == 13:
        return i
    if len(i) != 10:
        return None
    b = "978" + i[:9]
    s = sum(int(c) * (1 if k % 2 == 0 else 3) for k, c in enumerate(b))
    return b + str((10 - s % 10) % 10)


def get(url, accept_json=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json" if accept_json else "image/*,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.headers.get("Content-Type") or "", r.read()
    except urllib.error.HTTPError as e:
        return e.code, "", b""
    except Exception as e:
        return -1, str(e)[:60], b""


def image_ok(corps):
    try:
        img = Image.open(io.BytesIO(corps)).convert("RGB")
    except Exception:
        return None
    if img.width < 80 or img.height < 100 or not (1.05 < img.height / img.width < 2.2):
        return None
    return img


def main(collection, maxi):
    series = json.load(open(f"data/{collection}/series.json"))["series"]
    fonds = json.load(open(f"data/{collection}/fonds.json"))["series"]
    enr = json.load(open(f"data/{collection}/enrich.json"))["series"]
    deja = {p.stem for p in Path(f"couvertures/{collection}").glob("*.jpg")}
    sans = [s for s in series if s["id"] not in deja][:maxi]
    res = {}
    stats = {}
    for k, s in enumerate(sans):
        sid = s["id"]
        f = fonds.get(sid) or {}
        b = (enr.get(sid) or {}).get("bnf") or {}
        isbns = []
        for c in b.get("candidatsCouv") or []:
            i13 = isbn13(c.get("isbn"))
            if i13 and i13 not in isbns:
                isbns.append(i13)
        r = {"titre": s["titre"], "auteur": f.get("auteur"), "editeur": f.get("editeur"), "isbns": isbns, "sources": {}}
        essais = []
        for i in isbns[:2]:
            essais += [
                ("gb-content", f"https://books.google.com/books/content?vid=ISBN{i}&printsec=frontcover&img=1&zoom=1"),
                ("epagine", f"https://images.epagine.fr/{i[-3:]}/{i}_1_75.jpg"),
                ("decitre", f"https://products-images.di-static.com/image/x/{i}-475x500-1.jpg"),
            ]
            if collection == "bd":
                essais.append(("bdfugue", f"https://www.bdfugue.com/media/catalog/product/{i[0]}/{i[1]}/{i}_1_75.jpg"))
        if isbns:
            st, ct, corps = get(f"https://www.googleapis.com/books/v1/volumes?q=isbn:{isbns[0]}", True)
            gb = {"statut": st}
            if st == 200:
                items = json.loads(corps).get("items") or []
                il = ((items[0].get("volumeInfo") or {}).get("imageLinks") or {}) if items else {}
                gb["items"] = len(items)
                if il.get("thumbnail"):
                    essais.append(("gb-api", il["thumbnail"].replace("http://", "https://")))
            r["gbApi"] = gb
            time.sleep(1)
        else:
            # pas de notice BnF : recherche par titre et auteur
            q = f'intitle:{s["titre"]}' + (f' inauthor:{f["auteur"].split()[-1]}' if f.get("auteur") else "")
            st, ct, corps = get("https://www.googleapis.com/books/v1/volumes?" + urllib.parse.urlencode({"q": q, "maxResults": 5, "langRestrict": "fr"}), True)
            r["gbRecherche"] = {"q": q, "statut": st}
            if st == 200:
                items = json.loads(corps).get("items") or []
                r["gbRecherche"]["titres"] = [((it.get("volumeInfo") or {}).get("title"), (it.get("volumeInfo") or {}).get("authors")) for it in items[:5]]
                for it in items[:2]:
                    il = (it.get("volumeInfo") or {}).get("imageLinks") or {}
                    if il.get("thumbnail"):
                        essais.append(("gb-recherche", il["thumbnail"].replace("http://", "https://")))
                        break
            time.sleep(1)
            st, ct, corps = get("https://openlibrary.org/search.json?" + urllib.parse.urlencode({"title": s["titre"], **({"author": f["auteur"]} if f.get("auteur") else {}), "limit": 3, "fields": "title,author_name,cover_i,language"}), True)
            r["olRecherche"] = {"statut": st}
            if st == 200:
                docs = json.loads(corps).get("docs") or []
                r["olRecherche"]["titres"] = [(d.get("title"), d.get("author_name"), d.get("cover_i")) for d in docs[:3]]
                for d in docs:
                    if d.get("cover_i"):
                        essais.append(("ol-recherche", f"https://covers.openlibrary.org/b/id/{d['cover_i']}-M.jpg"))
                        break
        for nom, url in essais:
            if nom in r["sources"] and r["sources"][nom].get("ok"):
                continue
            st, ct, corps = get(url)
            info = {"statut": st, "type": ct[:30], "taille": len(corps), "md5": hashlib.md5(corps).hexdigest()[:10] if corps else ""}
            img = image_ok(corps) if st == 200 and corps else None
            if img:
                info["ok"] = True
                info["dim"] = f"{img.width}x{img.height}"
                d = SORTIE / collection / nom
                d.mkdir(parents=True, exist_ok=True)
                img.thumbnail((160, 240))
                img.save(d / f"{sid}.jpg", "JPEG", quality=80)
            r["sources"][nom] = info
            time.sleep(0.3)
        res[sid] = r
        for nom, info in r["sources"].items():
            stats.setdefault(nom, [0, 0])
            stats[nom][0] += 1
            stats[nom][1] += 1 if info.get("ok") else 0
        trouve = sorted(n for n, i in r["sources"].items() if i.get("ok"))
        print(f"[{k + 1}/{len(sans)}] {s['titre']} : {', '.join(trouve) or 'rien'}", flush=True)
    SORTIE.mkdir(exist_ok=True)
    json.dump(res, open(SORTIE / f"{collection}.json", "w"), ensure_ascii=False, indent=1)
    print("Bilan", collection, json.dumps(stats))
    au_moins = sum(1 for r in res.values() if any(i.get("ok") for i in r["sources"].values()))
    print(f"Au moins une source : {au_moins}/{len(res)}")


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 10000)
