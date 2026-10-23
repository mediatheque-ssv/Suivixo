// Tests rapides de la logique métier : node scripts/test_core.mjs
import assert from "node:assert/strict";
import * as C from "../assets/core.js";

let ok = 0;
const t = (nom, f) => { try { f(); ok++; } catch (e) { console.error(`✗ ${nom}\n  ${e.message}`); process.exitCode = 1; } };

t("clé de titre", () => {
  assert.equal(C.cleTitre("Atelier des sorciers (L')"), C.cleTitre("L'atelier des sorciers"));
  assert.equal(C.cleTitre("Yotsuba & !"), C.cleTitre("Yotsuba"));
  assert.equal(C.cleTitre("Kaiju n° 8"), C.cleTitre("Kaiju n°8"));
  assert.notEqual(C.cleTitre("Les Enfants de la baleine"), C.cleTitre("Enfants loups"));
});
t("titre naturel", () => {
  assert.equal(C.titreNaturel("Atelier des sorciers (L')"), "L'Atelier des sorciers");
  assert.equal(C.titreNaturel("Château solitaire dans le miroir (Le)"), "Le Château solitaire dans le miroir");
  assert.equal(C.titreNaturel("Library wars\nLove & War"), "Library wars : Love & War");
});
t("listes de tomes", () => {
  assert.equal(C.listeCompacte([1, 2, 3, 5, 7, 8]), "1-3, 5, 7-8");
  assert.deepEqual(C.lireListe("1-3,5 ; 7"), [1, 2, 3, 5, 7]);
});
t("cellule tome d'Orphée", () => {
  assert.deepEqual(C.parseTome("Tome : 12").nums, [12]);
  assert.deepEqual(C.parseTome("Tome : 1\n1").nums, [1]);
  assert.deepEqual(C.parseTome("Tome : 1-2").nums, [1, 2]);
  assert.deepEqual(C.parseTome("Tome : Tome 4").nums, [4]);
  assert.equal(C.parseTome("Tome : One shot").type, "oneshot");
  assert.equal(C.parseTome("Tome : HS").type, "hs");
  assert.deepEqual(C.parseTome("Tome :", "Blue giant 3").nums, [3]);
  assert.equal(C.parseTome("Tome :", "Erased").type, "inconnu");
});
t("lecture d'un export Orphée", () => {
  const rows = [
    ["Édition Orphée"], [],
    ["Radiant", null, null, null, null, "Tome : 1", null, null, null, "Radiant 1", null, null, null, null, null, null, "Valente", null, null, null, null, null, null, null, "Ankama"],
    ["Servon-sur-Vilaine", null, "M RAD 1", null, null, "Disponible", null, "Ado", null, null, null, "CS1: Manga", null, null, null, null, null, null, null, null, null, null, "Nb prêts total : 12"],
    ["Chateaugiron", null, "M RAD 1", null, null, "Perdu", null, "Ado", null, null, null, null, null, null, null, null, null, null, null, null, null, null, "Nb prêts total : 3"],
    ["Radiant", null, null, null, null, "Tome : 2", null, null, null, "Radiant 2"],
    ["Chateaugiron", null, "M RAD 2", null, null, "Emprunté", null, "Ado", null, null, null, null, null, null, null, null, null, null, null, null, null, null, "Nb prêts total : 5"],
  ];
  const { exemplaires } = C.lireExportOrphee(rows);
  assert.equal(exemplaires.length, 3);
  const series = [{ id: "radiant", titre: "Radiant" }];
  const r = C.construireFonds(exemplaires, series, { date: "2026-10-23" });
  assert.deepEqual(r.fonds.series.radiant.tomes, { "Servon-sur-Vilaine": [1], Chateaugiron: [2] });
  assert.equal(r.fonds.series.radiant.retires.length, 1);
  assert.equal(r.stats.series.radiant.prets["Servon-sur-Vilaine"], 12);
  assert.equal(r.stats.series.radiant.empruntes.Chateaugiron, 1);
  assert.equal(r.nouvelles.length, 0);
});
t("état de parution", () => {
  const s = { titre: "X" };
  const fini = { anilist: { statut: "FINISHED", volumes: 22 }, bnf: { dernier: 22, dateDernier: "2024-05" } };
  assert.equal(C.infosParution(s, fini).etat, "Terminée");
  const enCours = { anilist: { statut: "FINISHED", volumes: 22 }, bnf: { dernier: 18, dateDernier: new Date().toISOString().slice(0, 7) } };
  const i = C.infosParution(s, enCours);
  assert.equal(i.etat, "En cours");
  assert.equal(i.aVenir, 4);
  const arrete = { anilist: { statut: "FINISHED", volumes: 22 }, bnf: { dernier: 12, dateDernier: "2019-01" } };
  assert.equal(C.infosParution(s, arrete).etat, "Arrêtée en France ?");
  assert.equal(C.infosParution({ titre: "X", ancien: { total: 5, etat: "Terminée" } }, null).parus, 5);
  assert.equal(C.infosParution({ titre: "X", manuel: { parus: 9, etat: "En cours" } }, fini).parus, 9);
});
t("statut de la série", () => {
  const info = { parus: 5, etat: "Terminée" };
  assert.equal(C.statutSerie([1, 2, 3, 4, 5], info).cle, "finie");
  assert.equal(C.statutSerie([1, 2], info).cle, "completer");
  assert.equal(C.statutSerie([1, 2], { parus: 5, etat: "En cours" }).cle, "continuer");
  assert.equal(C.statutSerie([1, 2, 3, 4, 5], { parus: 5, etat: "En cours" }).cle, "attente");
  assert.equal(C.statutSerie([1], { parus: null, etat: null }).cle, "verifier");
});

console.log(`${ok} tests réussis${process.exitCode ? ", des échecs ci-dessus" : ""}.`);
