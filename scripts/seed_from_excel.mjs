// Migration unique : convertit l'ancien classeur « MangaV2-3.xlsm » en données Suivixo.
// Usage : node scripts/seed_from_excel.mjs chemin/vers/MangaV2-3.xlsm [dossier-stats-local]
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import {
  titreNaturel, slug, cleTitre, lireExportOrphee, construireFonds, tomesReseau, lireListe, listeCompacte,
} from "../assets/core.js";

const [, , fichier, dossierStats] = process.argv;
if (!fichier) { console.error("Usage : node scripts/seed_from_excel.mjs MangaV2-3.xlsm"); process.exit(1); }

const wb = XLSX.readFile(fichier, { cellDates: true });
const lignes = (nom) => XLSX.utils.sheet_to_json(wb.Sheets[nom], { header: 1, raw: true, defval: null });
const txt = (v) => (v === null || v === undefined ? "" : String(v).trim());

// --- Onglet Param : liens Manga-News (col C) et Bédéthèque (col D)
const liens = new Map();
for (const r of lignes("Param").slice(2)) {
  const t = txt(r[0]);
  if (!t) continue;
  let mn = txt(r[2]);
  if (mn.startsWith("ndex.php")) mn = "i" + mn;
  if (mn && !mn.startsWith("index.php/")) mn = "index.php/serie/" + mn;
  let bd = txt(r[3]);
  if (bd === "#N/A") bd = "";
  liens.set(cleTitre(t), { mangaNews: mn || undefined, bedetheque: bd || undefined });
}

// --- Onglet Mangas : une ligne par série à partir de la ligne 4
const ETATS = { "terminée": "Terminée", "terminé": "Terminée", "en cours": "En cours", "abandonnée": "Abandonnée" };
const series = [];
const parCle = new Map();
const ids = new Set();
const excelTomes = new Map(); // pour vérification
for (const r of lignes("Mangas").slice(3)) {
  const brut = txt(r[0]);
  if (!brut) continue;
  const titre = titreNaturel(brut);
  const cle = cleTitre(titre);
  const etat = ETATS[txt(r[6]).toLowerCase()] || null;
  const total = Number.isFinite(+r[8]) && txt(r[8]) !== "" ? +r[8] : null;
  const annee = Number.isFinite(+r[9]) && +r[9] >= 1950 && +r[9] <= 2035 ? +r[9] : null;
  const typeBrut = txt(r[7]).toLowerCase();
  const s = {
    id: null,
    titre,
    alias: [],
    genre: txt(r[2]),
    public: txt(r[3]),
    age: txt(r[4]),
    type: typeBrut.startsWith("one") ? "One shot" : "Série",
    liens: liens.get(cle) || {},
    commande: txt(r[16]),
    commentaire: txt(r[17]),
    ancien: { total, etat, annee },
  };
  excelTomes.set(cle, lireListe(r[11]));
  if (parCle.has(cle)) {
    // doublon (ex. « Beet\nThe Vandel Buster » et « Beet : the Vandel Buster ») : on fusionne
    const d = parCle.get(cle);
    for (const k of ["genre", "public", "age", "commande", "commentaire"]) if (!d[k] && s[k]) d[k] = s[k];
    d.liens = { ...s.liens, ...d.liens };
    for (const k of ["total", "etat", "annee"]) if (d.ancien[k] == null && s.ancien[k] != null) d.ancien[k] = s.ancien[k];
    if (!d.alias.includes(titre) && titre !== d.titre) d.alias.push(titre);
    continue;
  }
  let id = slug(titre), n = 2;
  while (ids.has(id)) id = `${slug(titre)}-${n++}`;
  ids.add(id);
  s.id = id;
  parCle.set(cle, s);
  series.push(s);
}

// --- Onglet MajReseau : le dernier export Orphée collé dans l'Excel
const { exemplaires, lignesTitre } = lireExportOrphee(lignes("MajReseau"));
const dateImport = "2025-09-19";
const res = construireFonds(exemplaires, series, { date: dateImport, source: "Ancien classeur Excel (onglet MajReseau)" });
for (const s of res.nouvelles) { delete s.nouvelle; s.ajout = dateImport; series.push(s); }

// --- Nettoyage des champs vides
const propre = (o) => {
  for (const [k, v] of Object.entries(o)) {
    if (v === "" || v === null || v === undefined) delete o[k];
    else if (Array.isArray(v) && !v.length) delete o[k];
    else if (typeof v === "object" && !Array.isArray(v)) { propre(v); if (!Object.keys(v).length) delete o[k]; }
  }
  return o;
};
series.forEach(propre);
series.sort((a, b) => a.titre.localeCompare(b.titre, "fr", { sensitivity: "base" }));

const racine = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ecrire = (f, obj) => fs.writeFileSync(path.join(racine, "data", f), JSON.stringify(obj, null, 1) + "\n");
ecrire("series.json", { version: 1, series });
ecrire("fonds.json", res.fonds);
if (!fs.existsSync(path.join(racine, "data", "enrich.json"))) ecrire("enrich.json", { maj: null, series: {} });
if (dossierStats) fs.writeFileSync(path.join(dossierStats, "stats_local.json"), JSON.stringify(res.stats));

// --- Rapport de vérification contre la colonne « Tome(s) présent(s) » de l'Excel
let identiques = 0, differents = [], sansFonds = 0;
for (const s of series) {
  const ex = excelTomes.get(cleTitre(s.titre));
  if (!ex) continue;
  const f = res.fonds.series[s.id];
  if (!f) { sansFonds++; continue; }
  const calc = tomesReseau(f);
  if (listeCompacte(calc) === listeCompacte(ex)) identiques++;
  else differents.push(`${s.titre} | Excel ${listeCompacte(ex)} | calculé ${listeCompacte(calc)}`);
}
console.log(`Exemplaires lus : ${exemplaires.length} (lignes titre ${lignesTitre})`);
console.log(`Séries : ${series.length} dont ${res.nouvelles.length} absentes de l'Excel`);
console.log(`Séries avec fonds : ${Object.keys(res.fonds.series).length} ; Excel sans exemplaire : ${sansFonds}`);
console.log(`Tomes réseau identiques à l'Excel : ${identiques} ; différents : ${differents.length}`);
console.log(differents.slice(0, 40).join("\n"));
console.log("Anomalies :", res.fonds.anomalies.length);
console.log("Nouvelles :", res.nouvelles.map((s) => s.titre).join(" | "));
