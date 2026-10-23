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
t("export Orphée avec lignes vides et sauts de page", () => {
  const vide = Array(27).fill(null);
  const rows = [
    [null, "Séries romans jeunesse et ados"], vide, ["Pour effectuer une recherche : CTRL+F"],
    [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, "Nombre de notices bibliographiques: 1\nNombre de documents: 3"],
    ["Dog Signal", null, null, null, null, "Tome : 1", null, null, null, "Dog Signal 1"], vide,
    ["Servon-sur-Vilaine", null, "M DOG 1", null, null, "Disponible", null, "Ado", null, null, null, null, null, null, null, null, null, null, null, null, null, null, "Nb prêts total : 2"], vide,
    [null, null, null, "Page 1 of 2"], vide,
    ["Noyal-sur-Vilaine", null, "M DOG 1", null, null, "Emprunté", null, "Ado", null, null, null, null, null, null, null, null, null, null, null, null, null, null, "Nb prêts total : 4"], vide,
    ["Dog Signal", null, null, null, null, "Tome :", null, null, null, "Dog Signal"], vide,
    ["Servon-sur-Vilaine", null, "M DOG 4", null, null, "Disponible", null, "Ado", null, null, null, null, null, null, null, null, null, null, null, null, null, null, "Nb prêts total : 1"],
  ];
  const { exemplaires, annonce } = C.lireExportOrphee(rows);
  assert.equal(exemplaires.length, 3);
  assert.equal(annonce, 3);
  assert.equal(C.dateFrancaise("Le 23 octobre 2026"), "2026-10-23");
  assert.equal(C.dateFrancaise("Le 1er août 2025"), "2025-08-01");
  const r = C.construireFonds(exemplaires, [{ id: "dog-signal", titre: "Dog Signal" }]);
  assert.deepEqual(r.fonds.series["dog-signal"].tomes, { "Servon-sur-Vilaine": [1, 4], "Noyal-sur-Vilaine": [1] });
  assert.equal(r.fonds.anomalies.length, 0);
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
  // Manga-News plus à jour que la BnF
  assert.equal(C.infosParution({ titre: "X" }, { bnf: { dernier: 8, tomes: "1-8" }, mangaNews: { tomes: 12 } }).parus, 12);
  assert.equal(C.infosParution({ titre: "X" }, { bnf: { dernier: 8, tomes: "1-8" }, mangaNews: { tomes: 12 } }).sourceParus, "mangaNews");
  // le réseau a le tome 10 alors que la BnF s'arrête à 8 : 10 tomes sont parus
  const monaLisa = { anilist: { statut: "FINISHED", volumes: 10 }, bnf: { dernier: 8, tomes: "1-8", dateDernier: "2024-09" } };
  const i2 = C.infosParution({ titre: "X" }, monaLisa, Date.now(), 10);
  assert.equal(i2.parus, 10);
  assert.equal(i2.sourceParus, "reseau");
  assert.equal(i2.etat, "Terminée");
  // numéro aberrant (« 202 » lu dans « 2024 ») écarté
  assert.equal(C.dernierBnf({ dernier: 202, tomes: "1-8,202" }), 8);
  assert.equal(C.dernierBnf({ dernier: 35, tomes: "35" }), 35);
  assert.equal(C.dernierBnf({ dernier: 17, tomes: "1-3,9,17" }), 17);
});
t("fiche Manga-News", () => {
  const s = { titre: "Boruto" };
  const maintenant = Date.parse("2026-10-23");
  // Boruto : la BnF n'a que 18 tomes, la fiche dit VF 20 (Terminé), VO 20 (Terminé)
  const boruto = { anilist: { statut: "FINISHED", volumes: 20 }, bnf: { dernier: 18, tomes: "1-18", dateDernier: "2023-01" },
    mangaNews: { tomes: 20, editeur: "Kana", url: "u" }, mangaNewsFiche: { url: "u", vf: 20, vfStatut: "Terminé", vo: 20, voStatut: "Terminé" } };
  const b = C.infosParution(s, boruto, maintenant);
  assert.equal(b.parus, 20); assert.equal(b.etat, "Terminée"); assert.equal(b.sourceEtat, "mangaNews"); assert.equal(b.doute, false);
  assert.equal(C.statutSerie([...Array(20)].map((_, i) => i + 1), b).cle, "finie");
  // Spy x Family : 16 parus, 17 annoncé le 12/11, 17 au Japon
  const spy = { anilist: { statut: "RELEASING" }, bnf: { dernier: 16, dateDernier: "2026-05" }, mangaNews: { tomes: 16, url: "u" },
    mangaNewsFiche: { url: "u", vf: 16, vfStatut: "En cours", vo: 17, voStatut: "En cours", vfDernier: 16, vfDernierDate: "2026-06-04", vfProchain: 17, vfProchainDate: "2026-11-12" } };
  const sp = C.infosParution(s, spy, maintenant);
  assert.equal(sp.parus, 16); assert.equal(sp.totalVO, 17); assert.equal(sp.aVenir, 1); assert.equal(sp.etat, "En cours");
  assert.deepEqual(sp.prochain, { tome: 17, date: "2026-11-12" });
  // une fois la date passée, le tome 17 compte comme paru sans attendre la prochaine lecture
  const apres = C.infosParution(s, spy, Date.parse("2026-11-20"));
  assert.equal(apres.parus, 17); assert.equal(apres.prochain, null);
  // le compte VF inclut un tome annoncé : on prend le dernier paru
  const annonce = { mangaNewsFiche: { url: "u", vf: 9, vfStatut: "En cours", vfDernier: 8 }, mangaNews: { tomes: 9, url: "u" } };
  assert.equal(C.infosParution(s, annonce, maintenant).parus, 8);
  // fiche d'une autre édition (autre éditeur) : ignorée
  const autre = { anilist: { statut: "FINISHED", volumes: 20 }, mangaNews: { tomes: 10, editeurDifferent: true, url: "u" },
    mangaNewsFiche: { url: "u", vf: 10, vfStatut: "Terminé" }, bnf: { dernier: 20, dateDernier: "2024-01" } };
  assert.equal(C.infosParution(s, autre, maintenant).parus, 20);
  // abandonnée en France
  const stop = { mangaNews: { tomes: 6, url: "u" }, mangaNewsFiche: { url: "u", vf: 6, vfStatut: "Abandonné", vo: 14, voStatut: "Terminé" } };
  assert.equal(C.statutSerie([1, 2, 3, 4, 5, 6], C.infosParution(s, stop, maintenant)).cle, "abandonnee");
  assert.equal(C.etatMangaNews("Stoppé"), "Abandonnée");
  // page indiquée à la main (ancien Excel) : seule sa fiche compte, sauf si elle a disparu
  const lien = { titre: "X", liens: { mangaNews: "index.php/serie/X-Kana" } };
  const fl = { mangaNews: { tomes: 3, url: "https://www.manga-news.com/index.php/serie/X" }, mangaNewsFiche: { url: "https://www.manga-news.com/index.php/serie/X-Kana", vf: 7, vfStatut: "En cours" } };
  assert.equal(C.infosParution(lien, fl, maintenant).parus, 7);
  fl.mangaNewsFiche = { url: "https://www.manga-news.com/index.php/serie/X", vf: 5, vfStatut: "En cours" };
  assert.equal(C.ficheMangaNews(lien, fl), null);
  fl.mangaNewsFiche.secours = true;
  assert.equal(C.infosParution(lien, fl, maintenant).parus, 5);
  assert.equal(C.etatMangaNews("En pause"), "En pause");
});
t("statut de la série", () => {
  const info = { parus: 5, etat: "Terminée" };
  assert.equal(C.statutSerie([1, 2, 3, 4, 5], info).cle, "finie");
  assert.equal(C.statutSerie([1, 2], info).cle, "completer");
  assert.equal(C.statutSerie([1, 2], { parus: 5, etat: "En cours" }).cle, "continuer");
  assert.equal(C.statutSerie([1, 2, 3, 4, 5], { parus: 5, etat: "En cours" }).cle, "attente");
  assert.equal(C.statutSerie([1], { parus: null, etat: null }).cle, "verifier");
  assert.equal(C.statutSerie([1, 2, 3, 4, 5, 6, 7, 8], { parus: 8, etat: "Arrêtée en France ?", doute: true }).cle, "verifier");
});

console.log(`${ok} tests réussis${process.exitCode ? ", des échecs ci-dessus" : ""}.`);
