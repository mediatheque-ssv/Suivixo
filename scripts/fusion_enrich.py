#!/usr/bin/env python3
"""Fusion à trois voies de data/enrich.json quand deux vérifications ont tourné en même temps.

Usage : fusion_enrich.py base.json nous.json eux.json > resultat.json
Pour chaque série et chaque champ : si cette vérification l'a modifié (nous != base), on garde
notre valeur ; sinon on garde celle de l'autre (eux).
"""
import json
import sys

base, nous, eux = (json.load(open(f)) for f in sys.argv[1:4])
b, n, e = base.get("series", {}), nous.get("series", {}), eux.get("series", {})
fusion = {}
for sid in sorted(set(n) | set(e)):
    sb, sn, se = b.get(sid, {}), n.get(sid, {}), e.get(sid, {})
    res = dict(se)
    for k in set(sn) | set(sb):
        if sn.get(k) != sb.get(k):
            if k in sn:
                res[k] = sn[k]
            else:
                res.pop(k, None)
    fusion[sid] = res
sortie = dict(eux)
sortie["series"] = fusion
sortie["maj"] = max(nous.get("maj") or "", eux.get("maj") or "")
json.dump(sortie, sys.stdout, ensure_ascii=False, indent=1)
sys.stdout.write("\n")
