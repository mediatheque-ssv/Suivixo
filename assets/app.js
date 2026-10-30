// Suivixo — interface
import * as C from "./core.js?v=26";
import { publier, verifierCle, lancerVerification, lireFichier as lireFichierDepot, executionsDepuis, etatExecution } from "./github.js?v=5";

// ---------------------------------------------------------------------------
// État et stockage local
// ---------------------------------------------------------------------------

/**
 * Collections suivies. Chacune a ses fichiers (séries, fonds, vérifications), ses couvertures,
 * son brouillon et ses prêts. Les mangas couvrent tout le réseau ; la BD et les romans jeunesse
 * seulement la médiathèque (exports de Servon).
 */
const COLLECTIONS = {
  mangas: { nom: "Mangas", des: "des mangas du réseau", titre: "Les mangas", dossier: "data/", couv: "couvertures/", reseau: true, mangas: true },
  bd: { nom: "BD jeunesse", des: "des BD jeunesse", titre: "Les BD jeunesse", dossier: "data/bd/", couv: "couvertures/bd/", reseau: false, intercalaires: true },
  romans: { nom: "Romans jeunesse", des: "des romans jeunesse", titre: "Les romans jeunesse", dossier: "data/romans/", couv: "couvertures/romans/", reseau: false },
};
const COL_ID = (() => {
  try {
    const u = new URLSearchParams(location.search).get("collection");
    if (u && COLLECTIONS[u]) return u;
    const p = JSON.parse(localStorage.getItem("suivixo.prefs") || "{}");
    return COLLECTIONS[p.collection] ? p.collection : "mangas";
  } catch { return "mangas"; }
})();
const COL = COLLECTIONS[COL_ID];
const suffixe = COL_ID === "mangas" ? "" : `.${COL_ID}`; // les mangas gardent les clés d'origine
const LS = { prefs: "suivixo.prefs", brouillon: "suivixo.brouillon" + suffixe, stats: "suivixo.stats" + suffixe, token: "suivixo.token", publie: "suivixo.publie" + suffixe };
const lsGet = (k, def) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } };
const lsSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };

const PREFS_DEFAUT = {
  bib: "Servon-sur-Vilaine", perimetre: "reseau", presence: "moi", tri: "titre", affichage: "couvertures",
  statut: null, public: "", genre: "", q: "", depot: "mediatheque-ssv/Suivixo",
  pretsPortee: "ici", pretsTri: "total",
};

const etat = {
  series: [], fonds: { series: {}, bibliotheques: [], anomalies: [] }, enrich: { series: {} },
  stats: lsGet(LS.stats, null),
  modifie: new Set(),
  brouillonDate: null,
  prefs: { ...PREFS_DEFAUT, ...lsGet(LS.prefs, {}), q: "", statut: null, collection: COL_ID },
  token: lsGet(LS.token, ""),
  vues: [], parId: new Map(),
  limite: 150,
  importPrevu: null,
  vue: "series",
  filtresOuverts: false,
  ongletAchat: "reseau",
  publication: false,
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = new Intl.NumberFormat("fr-FR");
const somme = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
const dateFr = (d) => { if (!d) return ""; const x = new Date(d); return isNaN(x) ? String(d) : x.toLocaleDateString("fr-FR"); };
const moisFr = (d) => { if (!d) return ""; const x = new Date(d); return isNaN(x) ? String(d) : (String(d).length <= 4 ? String(d) : x.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })); };
const COURT = { "Servon-sur-Vilaine": "Servon", "Noyal-sur-Vilaine": "Noyal", "St-Aubin du Pavail": "St-Aubin", "Piré-Chancé": "Piré" };
const court = (b) => COURT[b] || b;
const pluriel = (n, s, p = s + "s") => `${nf.format(n)} ${n > 1 ? p : s}`;

function sauverPrefs() {
  const { q, statut, ...reste } = etat.prefs;
  lsSet(LS.prefs, reste);
}

function sauverBrouillon() {
  if (!etat.modifie.size) { lsSet(LS.brouillon, null); return; }
  etat.brouillonDate = etat.brouillonDate || new Date().toISOString();
  lsSet(LS.brouillon, {
    date: etat.brouillonDate,
    modifie: [...etat.modifie],
    series: etat.modifie.has("series") ? etat.series : undefined,
    base: etat.modifie.has("series") ? etat.baseSeries : undefined,
    fonds: etat.modifie.has("fonds") ? etat.fonds : undefined,
  });
}

/** Une modification : gardée sur ce poste tout de suite, puis enregistrée pour l'équipe quelques secondes après. */
function marquer(quoi) {
  etat.modifie.add(quoi);
  if (etat.publication) (etat.modifieDepuis ||= new Set()).add(quoi); // pendant un enregistrement : pour le suivant
  sauverBrouillon();
  programmerEnregistrement();
  majEntete();
}

// Enregistrement automatique : on attend une courte pause (plusieurs clics d'affilée → un seul enregistrement)
let minuteurEnregistrement;
function programmerEnregistrement(delai = 2500) {
  clearTimeout(minuteurEnregistrement);
  if (!etat.modifie.size) return;
  if (!etat.token) { etat.erreurEnregistrement = "cle"; majEntete(); return; }
  minuteurEnregistrement = setTimeout(() => lancerPublication({ auto: true }), delai);
}

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------

async function charger() {
  const get = (f, vide) => fetch(`${COL.dossier}${f}?t=${Date.now()}`, { cache: "no-store" }).then((r) => {
    if (r.status === 404 && vide) return vide; // collection pas encore importée
    if (!r.ok) throw new Error(`Fichier ${COL.dossier}${f} introuvable (${r.status}).`);
    return r.json();
  });
  const [series, fonds, enrich] = await Promise.all([
    get("series.json", { series: [] }), get("fonds.json", { series: {}, bibliotheques: [], anomalies: [] }), get("enrich.json", { series: {} }).catch(() => ({ series: {} })),
  ]);
  etat.series = series.series || [];
  etat.fonds = fonds;
  etat.enrich = enrich && enrich.series ? enrich : { series: {} };
  // Juste après une publication, le site met une minute ou deux à se mettre à jour :
  // en attendant, on garde la version publiée depuis ce poste.
  const pub = lsGet(LS.publie, null);
  if (pub) {
    let encore = false;
    if (pub.series && (series.publie || "") < pub.date) { etat.series = pub.series; encore = true; }
    if (pub.fonds && (fonds.publie || "") < pub.date) { etat.fonds = pub.fonds; encore = true; }
    if (!encore || Date.now() - Date.parse(pub.date) > 6 * 3600 * 1000) lsSet(LS.publie, null);
  }
  etat.baseSeries = structuredClone(etat.series); // copie : les fiches modifiées ensuite ne doivent pas la toucher
  const b = lsGet(LS.brouillon, null);
  if (b && b.modifie?.length) {
    if (b.series) { etat.series = b.series; if (b.base) etat.baseSeries = b.base; }
    if (b.fonds) etat.fonds = b.fonds;
    b.modifie.forEach((m) => etat.modifie.add(m));
    etat.brouillonDate = b.date;
  }
}

function bibliotheques() {
  return [...new Set([...C.BIBLIOTHEQUES, ...(etat.fonds.bibliotheques || [])])].sort((a, b) => a.localeCompare(b, "fr"));
}

// ---------------------------------------------------------------------------
// Calculs
// ---------------------------------------------------------------------------

function calculer() {
  const bib = etat.prefs.bib;
  const surMoi = etat.prefs.perimetre === "moi";
  etat.vues = etat.series.map((s) => {
    const f = etat.fonds.series?.[s.id] || null;
    const enr = etat.enrich.series?.[s.id] || null;
    const ici = f?.tomes?.[bib] || [];
    const reseau = C.tomesReseau(f);
    const info = C.infosParution(s, enr, Date.now(), C.maxPlausible(reseau), { presumer: !COL.mangas });
    const statut = C.statutSerie(surMoi ? ici : reseau, info);
    const setIci = new Set(ici), setRes = new Set(reseau);
    const manquantsIci = [], manquantsReseau = [];
    if (info.parus !== null) for (let i = 1; i <= info.parus; i++) {
      if (!setIci.has(i)) manquantsIci.push(i);
      if (!setRes.has(i)) manquantsReseau.push(i);
    }
    const st = etat.stats?.series?.[s.id];
    const al = enr?.anilist && !enr.anilist.rejete && !enr.anilist.auteurDifferent ? enr.anilist : null;
    return {
      s, f, enr, info, ici, reseau, statut, manquantsIci, manquantsReseau,
      genre: s.genre || (f?.webtoon ? "Webtoon" : "") || (COL.mangas ? al?.demographie || f?.genreOrphee : f?.genreOrphee) || "",
      genreAuto: !s.genre && !!(al?.demographie || f?.genreOrphee),
      sansNumero: Object.values(f?.sansNumero || {}).flat().length,
      presence: C.presence(f, bib),
      prets: st ? somme(st.prets) : null,
      pretsIci: st ? st.prets?.[bib] || 0 : null,
      reserves: st ? somme(st.reserves) : 0,
      cle: C.cleTri(s.titre),
      texte: C.sansAccents([s.titre, ...(s.alias || []), f?.editeur, f?.titreOrphee].join(" ")).toLowerCase().replace(/&/g, " et "),
    };
  });
  etat.parId = new Map(etat.vues.map((v) => [v.s.id, v]));
}

const ORDRE_STATUT = ["completer", "continuer", "attente", "finie", "abandonnee", "verifier"];

function filtrer({ ignorerStatut = false, ignorerPresence = false } = {}) {
  const p = etat.prefs;
  // « Boule et Bill » trouve aussi « Boule & Bill », et inversement
  const q = C.sansAccents(p.q).toLowerCase().replace(/&/g, " et ").replace(/\s+/g, " ").trim();
  return etat.vues.filter((v) => {
    if (!ignorerPresence && p.presence === "moi" && !(v.presence === "ici" || v.presence === "partagee")) return false;
    if (!ignorerPresence && p.presence === "reseau" && v.presence === "aucune") return false;
    if (p.sansUniques && v.s.type === "One shot") return false;
    // intercalaire en rayon (BD) : seulement pour les séries, pas les titres uniques
    if (COL.intercalaires && p.intercalaire && (v.s.type === "One shot" || !!v.s.intercalaire !== (p.intercalaire === "avec"))) return false;
    if (p.public && (v.s.public || "") !== p.public) return false;
    if (p.genre && v.genre !== p.genre) return false;
    if (!ignorerStatut && p.statut && v.statut.cle !== p.statut) return false;
    if (q && !q.split(/\s+/).every((m) => v.texte.includes(m))) return false;
    return true;
  });
}

function trier(liste) {
  const t = etat.prefs.tri;
  const parTitre = (a, b) => a.cle.localeCompare(b.cle, "fr");
  const nbManq = (v) => (etat.prefs.perimetre === "moi" ? v.manquantsIci : v.manquantsReseau).length;
  const f = {
    titre: parTitre,
    manquants: (a, b) => nbManq(b) - nbManq(a) || parTitre(a, b),
    statut: (a, b) => ORDRE_STATUT.indexOf(a.statut.cle) - ORDRE_STATUT.indexOf(b.statut.cle) || parTitre(a, b),
    prets: (a, b) => (b.pretsIci ?? -1) - (a.pretsIci ?? -1) || (b.prets ?? -1) - (a.prets ?? -1) || parTitre(a, b),
    parution: (a, b) => (b.info.parus ?? -1) - (a.info.parus ?? -1) || parTitre(a, b),
  }[t] || parTitre;
  return liste.sort(f);
}

// ---------------------------------------------------------------------------
// Petits rendus réutilisables
// ---------------------------------------------------------------------------

// fausses couvertures : couleurs vives de dos de mangas, toutes lisibles en blanc
const TEINTES = ["#D93A63", "#2D6FE0", "#11876A", "#5536D6", "#B1399B", "#0C7F8D", "#C2410C", "#3F4BB8", "#8A3BC9", "#D63A2F"];
function teinte(t) {
  // FNV-1a : des titres proches (« Agents… », « Aria… ») tombent sur des couleurs différentes
  let x = 0x811c9dc5;
  for (const c of String(t)) x = Math.imul(x ^ c.charCodeAt(0), 0x01000193) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return TEINTES[(x >>> 0) % TEINTES.length];
}

function fausseCouv(titre, editeur) {
  return `<span class="couv couv-faux" style="background:${teinte(titre)}"><b>${h(titre)}</b><small>${h(editeur || "")}</small></span>`;
}

function urlsCouv(v) {
  // couverture française (Manga-News, Decitre, BnF, ePagine ou Open Library), réduite et rangée dans le dépôt
  const fr = v.enr?.couvFR;
  if (fr) { const u = `${COL.couv}${encodeURIComponent(v.s.id)}.jpg?v=${fr.maj || ""}`; return { petite: u, grande: u, fr: true }; }
  const al = v.enr?.anilist && !v.enr.anilist.rejete && !v.enr.anilist.auteurDifferent ? v.enr.anilist : null;
  if (!al?.image) return null;
  return { petite: al.image, grande: al.imageGrande || al.image.replace("/cover/small/", "/cover/medium/") };
}

/** Couverture AniList, ou fausse couverture colorée avec le titre. */
function couverture(v, grande = false) {
  const u = urlsCouv(v);
  if (!u) return fausseCouv(v.s.titre, v.f?.editeur);
  return `<img class="couv" src="${h(grande ? u.grande : u.petite)}" alt="" loading="lazy" referrerpolicy="no-referrer"
    data-petite="${h(u.petite)}" data-titre="${h(v.s.titre)}" data-editeur="${h(v.f?.editeur || "")}">`;
}

function statut(cle) {
  return `<span class="st st-${cle}">${C.STATUTS[cle]}</span>`;
}

/** Médiathèques (autres que la mienne) qui ont le tome i. */
function ailleurs(v, i) {
  const bib = etat.prefs.bib;
  return Object.entries(v.f?.tomes || {}).filter(([b, l]) => b !== bib && l.includes(i)).map(([b]) => court(b));
}

function classeTome(v, i) {
  const setIci = new Set(v.ici), setRes = new Set(v.reseau);
  const parus = v.info.parus;
  if (setIci.has(i)) {
    const autres = ailleurs(v, i);
    return autres.length ? ["double", `Tome ${i} : à ${court(etat.prefs.bib)} et à ${autres.join(", ")}`] : ["ici", `Tome ${i} : à ${court(etat.prefs.bib)} seulement`];
  }
  if (setRes.has(i)) return ["reseau", `Tome ${i} : à ${ailleurs(v, i).join(", ")}`];
  if (parus !== null && i <= parus) return ["manque", `Tome ${i} : absent du réseau`];
  if (parus !== null && i > parus) return ["avenir", `Tome ${i} : pas encore paru en France`];
  return ["inconnu", `Tome ${i}`];
}

function bornes(v) {
  const maxPossede = v.reseau.length ? v.reseau[v.reseau.length - 1] : 0;
  const n = Math.max(v.info.parus || 0, maxPossede);
  const vo = v.info.totalVO || 0;
  // Tranches « pas encore parues en VF » jusqu'au total de la VO, sauf si l'édition française est
  // découpée autrement (plusieurs éditions) ou déclarée terminée à la main.
  const decoupageDifferent = v.enr?.bnf?.plusieursEditions || /termin/i.test(v.s.manuel?.etat || "");
  const avenir = !decoupageDifferent && vo > n ? Math.min(vo - n, 60) : 0;
  return { n, total: n + avenir };
}

// Portail public des médiathèques : recherche par ISBN (l'adresse d'une recherche ordinaire ne change pas)
const PORTAIL_ISBN = "https://mediatheques.pcc.bzh/recherche-simple/simple/I.s.b.n./0/{isbn}/ligne";

/** Fiche : exemplaires en rayon, avec de quoi les retrouver dans Orphée (copier) et sur le portail. */
function blocExemplaires(v, bib) {
  const l = v.f?.exemplaires?.[bib] || [];
  if (!l.length) return "";
  const copier = (val, quoi) => `<button type="button" class="btn-copier" data-copier="${h(val)}" aria-label="Copier ${quoi} ${h(val)}">copier</button>`;
  const lignes = l.map((x) => `<li>
      <strong class="ex-tome">${typeof x.t === "number" ? (v.s.type === "One shot" ? "Titre unique" : `Tome ${x.t}`) : h(x.t)}${x.k ? ` <span class="discret">· ${h(x.k)}</span>` : ""}</strong>
      ${x.i ? `<a class="ex-portail" href="${h(PORTAIL_ISBN.replace("{isbn}", encodeURIComponent(x.i)))}" target="_blank" rel="noopener">Voir sur le portail</a>` : "<span></span>"}
      <span class="ex-champs">
        ${x.c ? `<span class="ex-champ"><span class="discret">Code-barre</span> <span class="code">${h(x.c)}</span>${copier(x.c, "le code-barre")}</span>` : ""}
        ${x.i ? `<span class="ex-champ"><span class="discret">ISBN</span> <span class="code">${h(x.i)}</span>${copier(x.i, "l'ISBN")}</span>` : ""}
      </span>
    </li>`).join("");
  return `<details class="repli">
      <summary>Exemplaires à ${h(court(bib))} <span class="discret">(${nf.format(l.length)})</span></summary>
      <p class="discret petit">Pour retrouver un exemplaire dans Orphée, copie son code-barre ou son ISBN et colle-le dans la recherche.</p>
      <ul class="exemplaires">${lignes}</ul>
    </details>`;
}

async function copierTexte(val) {
  try {
    await navigator.clipboard.writeText(val);
  } catch {
    const t = document.createElement("textarea");
    t.value = val; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
    document.body.append(t); t.select();
    try { document.execCommand("copy"); } catch { /* rien */ }
    t.remove();
  }
  toast(`« ${val} » copié : colle-le dans la recherche d'Orphée.`);
}

/** Rangée de tranches en SVG (liste). */
function etagere(v, largeur = 340, haut = 22, pasMin = 2.5) {
  const { total } = bornes(v);
  if (!total) return `<span class="ligne-meta">${v.f ? "Pas de tome numéroté" : "Aucun exemplaire"}</span>`;
  const pas = Math.max(pasMin, Math.min(10, largeur / total));
  const w = pas >= 6 ? pas - 2 : pas >= 4 ? pas - 1.2 : pas - 0.8;
  let rects = "";
  for (let i = 1; i <= total; i++) {
    const [c, titre] = classeTome(v, i);
    const x = ((i - 1) * pas).toFixed(2);
    const fill = c === "reseau" ? ' fill="url(#trame)"' : "";
    const cls = { ici: "t-ici", double: "t-ici", reseau: "t-reseau", manque: "t-manque", avenir: "t-avenir", inconnu: "t-avenir" }[c];
    const rx = w > 4 ? 1 : 0.5;
    if (c === "double") {
      // présent ici ET ailleurs : tranche pleine, coiffée d'une bande tramée
      const coiffe = Math.max(4, Math.round((haut - 2) * 0.38));
      rects += `<g><title>${h(titre)}</title><rect x="${x}" y="1" width="${w.toFixed(2)}" height="${haut - 2}" rx="${rx}" class="t-ici"/><rect x="${x}" y="1" width="${w.toFixed(2)}" height="${coiffe}" rx="${rx}" fill="url(#trame)" class="t-coiffe"/></g>`;
      continue;
    }
    rects += `<rect x="${x}" y="1" width="${w.toFixed(2)}" height="${haut - 2}" rx="${rx}" class="${cls}"${fill}><title>${h(titre)}</title></rect>`;
  }
  const larg = (total * pas).toFixed(1);
  return `<svg class="etagere" width="${larg}" height="${haut}" viewBox="0 0 ${larg} ${haut}" style="height:${haut}px" role="img" aria-label="${h(resumeTomes(v))}">${rects}</svg>`;
}

function resumeTomes(v) {
  const bib = court(etat.prefs.bib);
  const ici = v.ici.length ? C.listeCompacte(v.ici) : "aucun";
  const res = v.reseau.length ? C.listeCompacte(v.reseau) : "aucun";
  return `Tomes à ${bib} : ${ici}. Dans le réseau : ${res}.`;
}

/** « 8 sur 10 parus en VF » : tomes de ma médiathèque sur tomes parus en France. */
/** « 7 sur 9 parus en VF, 12 au Japon » : tomes de ma médiathèque, parus en France, total de la VO. */
const enVF = () => (COL.mangas ? "en VF" : ""); // pas de VO à distinguer pour la BD et les romans
const libParus = (n) => `${n > 1 ? "parus" : "paru"}${COL.mangas ? " en VF" : ""}`;

function compteVF(v) {
  const ici = v.ici.length;
  const p = v.info.parus;
  const vo = v.info.totalVO;
  // Aucune source n'a encore donné le nombre de tomes parus (série toute nouvelle) : on ne l'invente pas
  const nonVerifie = !v.enr || (v.info.sourceParus === "reseau" && !v.info.sourceEnRetard);
  if (v.s.type === "One shot") return ici ? "Titre unique" : `Titre unique, pas à ${h(court(etat.prefs.bib))}`;
  const sansNum = v.sansNumero;
  if (!ici && sansNum) {
    // tous les exemplaires sont sans numéro dans Orphée
    let t = `<strong>${nf.format(sansNum)}</strong> ${sansNum > 1 ? "titres" : "titre"} sans numéro`;
    if (p !== null && !nonVerifie) t += `, ${nf.format(p)} ${libParus(p)}`;
    return t;
  }
  let t = p === null || nonVerifie ? `<strong>${nf.format(ici)}</strong> ${ici > 1 ? "tomes" : "tome"}, parution ${v.enr ? "inconnue" : "pas encore vérifiée"}`
    : `<strong>${nf.format(ici)}</strong> sur ${nf.format(p)} ${libParus(p)}`;
  if (sansNum) t += `, + ${pluriel(sansNum, "titre")} sans numéro`;
  if (vo && (p === null || vo > p)) t += `, ${nf.format(vo)} ${enVO(v.info)}`;
  else if (v.info.etatVO === "En cours" || v.info.etatVO === "En pause") t += `, en cours ${enVO(v.info)}`;
  return t;
}

function legende() {
  const t = (cls, fill = "") => `<svg viewBox="0 0 7 14" aria-hidden="true"><rect x="0.5" y="0.5" width="6" height="13" rx="1" class="${cls}" ${fill}/></svg>`;
  const double = `<svg viewBox="0 0 7 14" aria-hidden="true"><rect x="0.5" y="0.5" width="6" height="13" rx="1" class="t-ici"/><rect x="0.5" y="0.5" width="6" height="5" rx="1" fill="url(#trame)" class="t-coiffe"/></svg>`;
  if (!COL.reseau) return `<p class="legende">
    <span>${t("t-ici")} À ${h(court(etat.prefs.bib))}</span>
    <span>${t("t-manque")} Manquant</span>
  </p>`;
  return `<p class="legende">
    <span>${t("t-ici")} À ${h(court(etat.prefs.bib))} seulement</span>
    <span>${double} À ${h(court(etat.prefs.bib))} et ailleurs</span>
    <span>${t("t-reseau", 'fill="url(#trame)"')} Ailleurs dans le réseau</span>
    <span>${t("t-manque")} Absent du réseau</span>
    <span>${t("t-avenir")} Pas encore paru en France</span>
  </p>`;
}

// ---------------------------------------------------------------------------
// Vue : séries
// ---------------------------------------------------------------------------

function nbFiltres() {
  const p = etat.prefs;
  return [p.presence !== "moi", COL.reseau && p.perimetre !== "reseau", !!p.public, !!p.genre, p.tri !== "titre", !!p.sansUniques, COL.intercalaires && !!p.intercalaire].filter(Boolean).length;
}

function rendreSeries() {
  const p = etat.prefs;
  const base = filtrer({ ignorerStatut: true });
  const comptes = {};
  base.forEach((v) => { comptes[v.statut.cle] = (comptes[v.statut.cle] || 0) + 1; });
  const liste = trier(filtrer());
  // une recherche qui trouve des séries absentes de ma médiathèque : on le dit au lieu de les cacher
  const ailleurs = p.q.trim() && p.presence !== "toutes" ? filtrer({ ignorerPresence: true }).filter((v) => !liste.includes(v)) : [];
  const publics = [...new Set(etat.series.map((s) => s.public).filter(Boolean))].sort();
  const genres = [...new Set(etat.vues.map((v) => v.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
  const bib = court(p.bib);
  const avecPrets = !!etat.stats;
  const n = nbFiltres();
  const radio = (nom, val, lib) => `<label class="choix"><input type="radio" name="${nom}" value="${val}" ${p[nom] === val ? "checked" : ""}>${lib}</label>`;
  const options = (l, val) => `<option value="">Tous</option>` + l.map((x) => `<option ${val === x ? "selected" : ""}>${h(x)}</option>`).join("");
  const tris = [["titre", "Titre"], ["manquants", "Nombre de tomes manquants"], ["statut", "Où ça en est"], ...(avecPrets ? [["prets", "Prêts"]] : [])];

  const titre = p.presence === "moi" ? `${COL.titre} de ${h(bib)}` : p.presence === "reseau" ? `${COL.titre} du réseau` : "Toutes les séries";
  const tomesIci = base.reduce((a, v) => a + v.ici.length, 0);
  const total = base.length || 1;
  const grille = p.affichage !== "liste";

  $("#vue").innerHTML = `
    <div class="accueil">
      <div class="accueil-texte">
        <h1>${titre}</h1>
        <p class="chapo"><strong>${nf.format(base.length)}</strong> séries${p.presence === "moi" ? `, <strong>${nf.format(tomesIci)}</strong> tomes en rayon` : ""}${p.q || p.public || p.genre ? " pour cette recherche" : ""}.</p>
      </div>
      <div class="vues" role="group" aria-label="Affichage">
        <button type="button" data-affichage="couvertures" aria-pressed="${grille}">Couvertures</button>
        <button type="button" data-affichage="liste" aria-pressed="${!grille}">Liste</button>
      </div>
    </div>
    <div class="barre">
      <input class="recherche" type="search" id="q" placeholder="Chercher une série ou un éditeur" value="${h(p.q)}" aria-label="Chercher une série">
      <button type="button" class="btn btn-filtres" data-action="filtres" aria-expanded="${etat.filtresOuverts}" aria-controls="panneau-filtres">Filtres${n ? ` <span class="nb">${n}</span>` : ""}</button>
    </div>
    <div class="panneau-filtres" id="panneau-filtres" ${etat.filtresOuverts ? "" : "hidden"}>
      <fieldset><legend>Séries affichées</legend>
        ${radio("presence", "moi", `Présentes à ${h(bib)}`)}${COL.reseau ? radio("presence", "reseau", "Tout le réseau") : ""}${radio("presence", "toutes", "Toutes, même sans exemplaire")}
        <label class="choix"><input type="checkbox" id="f-uniques" ${p.sansUniques ? "checked" : ""}>Masquer les titres uniques</label>
      </fieldset>
      ${COL.reseau ? `<fieldset><legend>Une série est complète si elle l'est</legend>
        ${radio("perimetre", "reseau", "dans le réseau")}${radio("perimetre", "moi", `à ${h(bib)}`)}
      </fieldset>` : ""}
      <div style="display:grid;gap:12px;align-content:start">
        <label class="champ"><span>Public</span><select id="f-public">${options(publics, p.public)}</select></label>
        <label class="champ"><span>Genre</span><select id="f-genre">${options(genres, p.genre)}</select></label>
        ${COL.intercalaires ? `<label class="champ"><span>Intercalaire en rayon</span><select id="f-intercalaire">
          <option value="" ${!p.intercalaire ? "selected" : ""}>Toutes les séries</option>
          <option value="sans" ${p.intercalaire === "sans" ? "selected" : ""}>Séries sans intercalaire</option>
          <option value="avec" ${p.intercalaire === "avec" ? "selected" : ""}>Séries avec intercalaire</option>
        </select></label>` : ""}
      </div>
      <label class="champ" style="align-content:start"><span>Trier par</span><select id="f-tri">${tris.map(([k, l]) => `<option value="${k}" ${p.tri === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      ${n ? `<button type="button" class="btn-lien reinit" data-action="reinit">Réinitialiser les filtres</button>` : ""}
    </div>
    ${base.length ? `<div class="repartition${p.statut ? " filtree" : ""}" role="group" aria-label="Répartition par statut">
      ${ORDRE_STATUT.filter((k) => comptes[k]).map((k) => `<button type="button" class="r-${k}" style="flex:${comptes[k]}" data-statut="${k}" aria-pressed="${p.statut === k}" title="${C.STATUTS[k]} : ${comptes[k]} séries (${Math.round(comptes[k] * 100 / total)} %)" aria-label="${C.STATUTS[k]} : ${comptes[k]} séries"></button>`).join("")}
    </div>` : ""}
    <div class="statuts" role="group" aria-label="Filtrer par statut">
      <button type="button" data-statut="" aria-pressed="${!p.statut}"><span class="pt pt-tout"></span>Toutes <span class="nb">${nf.format(base.length)}</span></button>
      ${ORDRE_STATUT.filter((k) => comptes[k]).map((k) => `<button type="button" data-statut="${k}" aria-pressed="${p.statut === k}"><span class="pt pt-${k}"></span>${C.STATUTS[k]} <span class="nb">${nf.format(comptes[k])}</span></button>`).join("")}
    </div>
    ${ailleurs.length ? `<p class="note-recherche">${liste.length ? "Aussi" : `Aucune série présente à ${h(bib)} ne correspond, mais`} ${pluriel(ailleurs.length, "série")} ${COL.reseau ? "ailleurs dans le réseau" : "sans exemplaire"} : ${ailleurs.slice(0, 5).map((v) => `<button type="button" class="btn-lien" data-serie="${h(v.s.id)}">${h(v.s.titre)}</button>${v.presence === "reseau" ? ` <span class="discret">(${h(Object.keys(v.f?.tomes || {}).filter((b) => (v.f.tomes[b] || []).length).map(court).join(", "))})</span>` : ""}`).join(", ")}${ailleurs.length > 5 ? "…" : ""}
      <button type="button" class="btn-lien" data-action="voir-partout">Les afficher dans la liste</button></p>` : ""}
    ${!liste.length && !ailleurs.length ? `<p class="vide">Aucune série ne correspond. Essaie d'élargir les filtres.</p>` : !liste.length ? ""
      : grille ? `<div class="grille">${liste.slice(0, etat.limite).map(carteSerie).join("")}</div>`
      : `<div class="liste${avecPrets ? " avec-prets" : ""}">${liste.slice(0, etat.limite).map(ligneSerie).join("")}</div>`}
    ${liste.length > etat.limite ? `<button class="btn plus" data-action="plus">Afficher les ${nf.format(liste.length - etat.limite)} autres séries</button>` : ""}
    ${liste.length ? legende() : ""}
  `;
}

function carteSerie(v) {
  return `<button type="button" class="carte" data-serie="${h(v.s.id)}">
    ${couverture(v, true)}
    <span class="carte-titre">${h(v.s.titre)}</span>
    ${v.f?.editeur ? `<span class="carte-meta">${h(v.f.editeur)}</span>` : ""}
    <span class="compte-vf" title="Tomes à ${h(court(etat.prefs.bib))}, tomes parus en France${COL.mangas ? ", total de la série en VO" : ""}">${compteVF(v)}</span>
    ${etagere(v, 160, 16, 1.4)}
    ${statut(v.statut.cle)}
  </button>`;
}

function boutonIntercalaire(v, classe = "btn-intercalaire") {
  if (!COL.intercalaires || v.s.type === "One shot") return "";
  const oui = !!v.s.intercalaire;
  return `<button type="button" class="${classe}" data-intercalaire="${h(v.s.id)}" aria-pressed="${oui}"
    title="${oui ? "Intercalaire en rayon (cliquer pour l'enlever)" : "Pas d'intercalaire en rayon (cliquer si on en a un)"}">${oui ? "Intercalaire ✓" : "Sans intercalaire"}</button>`;
}

function basculerIntercalaire(id) {
  const s = etat.series.find((x) => x.id === id);
  if (!s) return;
  if (s.intercalaire) delete s.intercalaire; else s.intercalaire = true;
  marquer("series");
  calculer();
}

function ligneSerie(v) {
  const btn = boutonIntercalaire(v);
  return btn ? `<div class="ligne-avec-action">${ligneSerieSeule(v)}${btn}</div>` : ligneSerieSeule(v);
}

function ligneSerieSeule(v) {
  const meta = v.f?.editeur || "";
  return `<button type="button" class="ligne" data-serie="${h(v.s.id)}">
    <span class="vignette">${couverture(v)}</span>
    <span><span class="ligne-titre">${h(v.s.titre)}</span>${meta ? `<span class="ligne-meta">${h(meta)}</span>` : ""}</span>
    <span>${etagere(v)}<span class="compte-vf">${compteVF(v)}</span></span>
    <span>${statut(v.statut.cle)}</span>
    ${v.prets === null ? "" : `<span class="ligne-prets">${pluriel(v.pretsIci, "prêt")}</span>`}
  </button>`;
}

// ---------------------------------------------------------------------------
// Fiche série
// ---------------------------------------------------------------------------

const PAYS = { JP: "au Japon", KR: "en Corée", CN: "en Chine", TW: "à Taïwan" };
const enVO = (x) => PAYS[x?.pays] || "en version originale";
const jourMois = (d) => { const x = new Date(d); return isNaN(x) ? String(d) : x.toLocaleDateString("fr-FR", { day: "numeric", month: "long", ...(x.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }); };
const ETATS_FR = { "Terminée": "terminée", "En cours": "en cours", "En pause": "en pause", "Abandonnée": "abandonnée" };
const ETATS_AL = { FINISHED: "terminée", RELEASING: "en cours", HIATUS: "en pause", CANCELLED: "annulée", NOT_YET_RELEASED: "pas encore commencée" };

function phraseStatut(v) {
  const { info } = v;
  const bib = court(etat.prefs.bib);
  const morceaux = [];
  if (info.etatVO) {
    const ou = enVO(info);
    morceaux.push(`${ou.charAt(0).toUpperCase() + ou.slice(1)}, la série est ${ETATS_FR[info.etatVO] || info.etatVO.toLowerCase()}${info.totalVO ? ` (${pluriel(info.totalVO, "tome")}${info.etatVO === "Terminée" ? "" : " à ce jour"})` : info.pays === "KR" || info.pays === "CN" ? " (publication en ligne)" : ""}.`);
  }
  if (info.parus !== null) {
    const fiche = v.enr?.mangaNewsFiche;
    const dateSure = info.sourceParus === "bnf" || (info.sourceParus === "mangaNews" && fiche && (fiche.vfDernier ?? fiche.vf) === info.parus);
    const date = dateSure && info.dateDernier ? `, le dernier sorti ${String(info.dateDernier).length > 7 ? `le ${jourMois(info.dateDernier)}` : `en ${moisFr(info.dateDernier)}`}` : "";
    const venir = info.aVenir && /en cours/i.test(info.etat || "") && !info.doute ? `, ${info.aVenir} encore à venir` : "";
    const fin = info.sourceEtat === "mangaNews" && info.etat === "Terminée" ? " : l'édition française est terminée"
      : info.sourceEtat === "mangaNews" && info.etat === "Abandonnée" ? " : l'éditeur français a arrêté la série" : "";
    morceaux.push(`${pluriel(info.parus, "tome paru", "tomes parus")} en France${date}${venir}${fin}.`);
    if (info.sourceEtat === "recent") morceaux.push(COL.mangas ? "Aucune source ne dit où en est la série, mais un tome est sorti en France il y a moins d'un an : elle continue sans doute."
      : "Un tome est sorti récemment : la série continue sans doute. Si elle est finie, indique-le dans « Modifier la série ».");
    if (info.sourceEtat === "presume") morceaux.push("La BnF ne recense pas tous les tomes de cette série : elle est considérée en cours. Si elle est finie, indique-le dans « Modifier la série ».");
    if (info.sourceEtat === "ancien") morceaux.push(`Plus aucun tome depuis ${moisFr(info.dateDernier)} : la série est sans doute terminée. Si elle continue, indique-le dans « Modifier la série ».`);
    if (info.prochain) morceaux.push(`Prochain tome${info.prochain.tome ? ` (${info.prochain.tome})` : ""} annoncé pour le ${jourMois(info.prochain.date)}.`);
    if (info.sourceParus === "reseau") morceaux.push(`Ce nombre vient des exemplaires ${COL.reseau ? "du réseau" : `de ${bib}`}${info.sourceEnRetard === "bnf" ? " : la BnF ne recense pas encore les derniers tomes" : ""}.`);
  } else morceaux.push("Le nombre de tomes parus en France est inconnu.");
  if (/arr[eê]t/i.test(info.etat || "")) morceaux.push(`Plus rien n'est paru en France depuis ${moisFr(info.dateDernier) || "longtemps"} : la série a peut-être été arrêtée par l'éditeur, ou l'édition française est différente. Si tu sais ce qu'il en est, indique-le dans « Modifier la série ».`);
  if (info.parus !== null) {
    const dispoAilleurs = v.manquantsIci.filter((i) => !v.manquantsReseau.includes(i));
    if (!v.ici.length) morceaux.push(`${bib} n'a aucun tome.`);
    else if (!v.manquantsIci.length) morceaux.push(`${bib} a tous les tomes parus.`);
    else morceaux.push(`Il manque à ${bib} : ${C.listeCompacte(v.manquantsIci)}${dispoAilleurs.length && v.manquantsReseau.length ? `, dont ${C.listeCompacte(dispoAilleurs)} disponibles ailleurs dans le réseau` : dispoAilleurs.length ? ", tous disponibles ailleurs dans le réseau" : ""}.`);
    if (COL.reseau && v.manquantsReseau.length) morceaux.push(`Absents de tout le réseau : ${C.listeCompacte(v.manquantsReseau)}.`);
  }
  return morceaux.join(" ");
}

function ouvrirFiche(id) {
  const v = etat.parId.get(id);
  if (!v) return;
  const { s, f, info } = v;
  const bib = etat.prefs.bib;
  const { total } = bornes(v);
  const tranches = [];
  for (let i = 1; i <= total; i++) {
    const [c, titre] = classeTome(v, i);
    tranches.push(`<span class="tranche ${c}" title="${h(titre)}"><span>${i}</span></span>`);
  }
  const bibs = repartition(v);
  const al = v.enr?.anilist && !v.enr.anilist.rejete && !v.enr.anilist.auteurDifferent ? v.enr.anilist : null;
  const bnf = v.enr?.bnf;
  const st = etat.stats?.series?.[s.id];
  const L = s.liens || {};
  const fmn = C.ficheMangaNews(s, v.enr);
  const urlMN = L.mangaNews ? (L.mangaNews.startsWith("http") ? L.mangaNews : "https://www.manga-news.com/" + L.mangaNews) : fmn?.url || v.enr?.mangaNews?.url || null;
  const urlBD = L.bedetheque ? (L.bedetheque.startsWith("http") ? L.bedetheque : "https://www.bedetheque.com/" + L.bedetheque) : null;
  const urlBnf = `https://catalogue.bnf.fr/rechercher.do?motRecherche=${encodeURIComponent(v.enr?.bnf?.titreBnf || s.titre)}`;
  const meta = [f?.editeur, s.public, v.genre, s.age, s.type === "One shot" ? "One shot" : ""].filter(Boolean).join(", ");
  const src = { manuel: "ta saisie", bnf: "la BnF", mangaNews: "Manga-News", excel: "l'ancien Excel", type: "le type one shot", reseau: "les exemplaires du réseau" };
  const lien = (url, texte) => `<a href="${h(url)}" target="_blank" rel="noopener">${texte}</a>`;

  const notes = [];
  for (const r of f?.retires || []) notes.push(`Tome ${r.tome ?? "?"} retiré à ${court(r.bib)} (${r.statut.toLowerCase()})`);
  if (s.commande) notes.push(`En commande : ${s.commande}`);
  if (s.commentaire) notes.push(s.commentaire);
  if (st) notes.push(`${pluriel(st.prets?.[bib] || 0, "prêt")} à ${court(bib)}${COL.reseau ? `, ${pluriel(somme(st.prets), "prêt")} dans le réseau` : ""}${somme(st.reserves) ? `, ${pluriel(somme(st.reserves), "réservation")}` : ""}`);

  const liens = [urlMN && lien(urlMN, "Manga-News"), urlBD && lien(urlBD, "Bédéthèque"), lien(urlBnf, "le catalogue BnF"), al && lien(`https://anilist.co/manga/${al.id}`, "AniList")].filter(Boolean);

  const u = urlsCouv(v);
  $("#fiche-contenu").innerHTML = `
    <div class="fiche-tete">
      <div class="fiche-fond-couv" style="${u ? `background-image:url('${h(u.grande)}')` : `background:${teinte(s.titre)}`}"></div>
      <div class="grande">${couverture(v, true)}</div>
      <div>
        <h1 id="fiche-titre">${h(s.titre)}</h1>
        ${meta ? `<p class="sous-titre">${h(meta)}</p>` : ""}
        ${statut(v.statut.cle)} ${boutonIntercalaire(v, "btn-intercalaire fiche-intercalaire")}
      </div>
    </div>
    <div class="fiche-corps">
    <div class="chiffres-serie">
      <div><strong>${nf.format(v.ici.length)}</strong><span>à ${h(court(bib))}</span></div>
      <div><strong>${info.parus !== null && v.enr && !(info.sourceParus === "reseau" && !info.sourceEnRetard) ? nf.format(info.parus) : "?"}</strong><span>${v.enr ? libParus(2) : `${libParus(2)}, pas encore vérifié`}</span></div>
      ${info.totalVO ? `<div><strong>${nf.format(info.totalVO)}</strong><span>${h(enVO(info))}</span></div>` : info.etatVO === "En cours" ? `<div><strong>…</strong><span>en cours ${h(enVO(info))}</span></div>` : ""}
    </div>
    <p class="resume">${h(phraseStatut(v))}</p>
    ${total ? `<div class="rayon-complet">${tranches.join("")}</div>${legende()}` : ""}

    ${COL.reseau ? `<h2>Dans le réseau</h2>
    ${bibs}` : ""}
    ${v.f?.sansNumero ? `<h2>Titres sans numéro dans Orphée</h2><p class="explication">${h(Object.values(v.f.sansNumero).flat().join(", "))}. Ils ne sont pas comptés comme tomes : ajoute le numéro dans Orphée s'ils font partie d'une série numérotée.</p>` : ""}
    ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${h(n)}</li>`).join("")}</ul>` : ""}

    ${blocExemplaires(v, bib)}

    <details class="repli">
      <summary>Sources et liens</summary>
      <div class="sources">
        ${COL.mangas ? `<p><strong>VO</strong> : ${al ? `${h(enVO(al))}, série ${h(ETATS_AL[al.statut] || "?")}${al.volumes ? ` en ${pluriel(al.volumes, "tome")}` : ""}, d'après AniList (« ${h(al.titre)} »)${al.auto ? ", reliée automatiquement" : ""}.` : "série pas encore reliée à AniList. Colle son adresse dans « Modifier la série »."}</p>` : ""}
        <p><strong>France</strong> : ${info.parus !== null ? `${pluriel(info.parus, "tome paru", "tomes parus")}, d'après ${src[info.sourceParus] || info.sourceParus}` : "nombre de tomes parus inconnu"}.${bnf?.dernier ? ` À la BnF${bnf.titreBnf ? ` (sous le titre « ${h(bnf.titreBnf)} », retrouvé grâce à l'ISBN)` : ""} : tome ${C.dernierBnf(bnf)}${bnf.editeur ? ` chez ${h(bnf.editeur)}` : ""}${bnf.dateDernier ? `, déposé en ${moisFr(bnf.dateDernier)}` : ""}.${bnf.plusieursEditions ? " Plusieurs éditions existent, seule celle qui suit la VO est comptée." : ""}` : bnf?.ecartee ? ` La BnF ne connaît sous ce titre qu'une autre série (${h(bnf.ecartee)}), sans aucun de nos ISBN : elle n'est pas comptée.` : ""}${v.enr?.mangaNews && !fmn ? ` Sur Manga-News : ${pluriel(v.enr.mangaNews.tomes, "tome")}${v.enr.mangaNews.editeur ? ` chez ${h(v.enr.mangaNews.editeur)}` : ""} (données du ${dateFr(v.enr.mangaNews.date)}).` : ""}</p>
        ${fmn ? `<p><strong>Manga-News</strong> : ${[Number.isFinite(fmn.vf) ? `VF ${nf.format(fmn.vf)} ${fmn.vf > 1 ? "tomes" : "tome"} (${h((fmn.vfStatut || "").toLowerCase())})` : "", Number.isFinite(fmn.vo) ? `VO ${nf.format(fmn.vo)} (${h((fmn.voStatut || "").toLowerCase())})` : "", fmn.vfDernierDate ? `dernier paru le ${dateFr(fmn.vfDernierDate)}` : "", fmn.vfProchainDate ? `prochain le ${dateFr(fmn.vfProchainDate)}` : ""].filter(Boolean).join(", ")}${v.enr?.mangaNews?.editeur ? `, chez ${h(v.enr.mangaNews.editeur)}` : ""}. Fiche lue le ${dateFr(fmn.verifie)}.</p>` : ""}
        ${s.ancien && (s.ancien.total || s.ancien.etat) ? `<p><strong>Ancien Excel</strong> : ${s.ancien.total ? pluriel(s.ancien.total, "tome") : ""}${s.ancien.etat ? `, ${h(s.ancien.etat.toLowerCase())}` : ""}${s.ancien.annee ? `, dernière parution en ${s.ancien.annee}` : ""}.</p>` : ""}
        <p><strong>Couverture</strong> : ${v.enr?.couvFR ? `${v.enr.couvFR.orphee ? "notre édition (ISBN des exemplaires)" : "édition française"}${v.enr.couvFR.tome ? `, tome ${v.enr.couvFR.tome}` : ""}, d'après ${({ BnF: "la BnF", "Manga-News": "Manga-News", Decitre: "Decitre", ePagine: "ePagine" })[v.enr.couvFR.source] || "Open Library"}.` : urlsCouv(v) ? "édition japonaise, d'après AniList (pas de couverture française trouvée)." : "aucune trouvée."}</p>
        <p>Voir sur ${liens.join(", ")}.</p>
        <p class="actions-sources"><button type="button" class="btn" data-action="reverifier" data-id="${h(s.id)}">Revérifier maintenant</button>
          <span class="discret petit">${COL.mangas ? "AniList, BnF, Manga-News et couverture" : "BnF et couverture"}, sans attendre lundi.</span></p>
      </div>
    </details>
    <details class="repli" id="modifier"><summary>Modifier la série</summary>${formulaire(s)}
      <div class="rattacher">
        <label class="champ large"><span>C'est en fait la même série qu'une autre (titre différent dans Orphée) : la rattacher à…</span>
          <select data-relier="${h(s.id)}"><option value="">Choisir la série…</option>${etat.series.filter((o) => o !== s).sort((a, b) => a.titre.localeCompare(b.titre, "fr")).map((o) => `<option value="${h(o.id)}">${h(o.titre)}</option>`).join("")}</select>
        </label>
        <p class="discret petit">Ses exemplaires rejoignent l'autre série, et « ${h(s.titre)} » devient un autre titre de celle-ci pour les prochains imports.</p>
      </div>
    </details>
    </div>
  `;
  const fiche = $("#fiche");
  fiche.hidden = false;
  fiche.dataset.id = id;
  document.body.style.overflow = "hidden";
  $(".fiche-panneau").scrollTop = 0;
  $(".fiche-fermer").focus();
}

/** Tableau tomes × médiathèques : les doublons se lisent en colonne. */
function repartition(v) {
  const bib = etat.prefs.bib;
  const f = v.f;
  const { n } = bornes(v);
  const lignes = bibliotheques().filter((b) => (f?.tomes?.[b] || []).length || f?.hs?.[b] || b === bib)
    .sort((a, b) => (a === bib ? -1 : b === bib ? 1 : a.localeCompare(b, "fr")));
  if (!n) return `<p class="discret">Aucun tome numéroté dans le réseau.</p>`;
  const taille = n <= 25 ? 16 : n <= 40 ? 10 : n <= 60 ? 7 : 5;
  const pasNum = taille >= 16 ? 1 : taille >= 10 ? 5 : 10;
  const parus = v.info.parus ?? n;
  const entete = Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    const montre = pasNum === 1 || i === 1 || i % pasNum === 0;
    return `<span class="rp-num${i > parus ? " avenir" : ""}">${montre ? i : ""}</span>`;
  }).join("");
  const rangees = lignes.map((b) => {
    const l = new Set(f?.tomes?.[b] || []);
    const hs = f?.hs?.[b];
    const cases = Array.from({ length: n }, (_, k) => {
      const i = k + 1;
      if (!l.has(i)) return `<span class="rp-case"></span>`;
      const autres = Object.entries(f.tomes).filter(([x, t]) => x !== b && t.includes(i)).length;
      return `<span class="rp-case pleine${b === bib && autres ? " double" : ""}" title="${h(`${court(b)} : tome ${i}${autres ? `, aussi dans ${pluriel(autres, "autre médiathèque", "autres médiathèques")}` : ""}`)}"></span>`;
    }).join("");
    return `<div class="rp-ligne${b === bib ? " moi" : ""}"><span class="rp-nom">${h(court(b))}</span><span class="rp-cases">${cases}</span><span class="rp-total">${l.size}${hs ? ` + ${hs} HS` : ""}</span></div>`;
  }).join("");
  const doubles = v.ici.filter((i) => ailleurs(v, i).length);
  const seuls = v.ici.filter((i) => !ailleurs(v, i).length);
  const resume = !v.ici.length ? "" : doubles.length === 0
    ? `Tous les tomes de ${court(bib)} sont les seuls exemplaires du réseau.`
    : `${seuls.length ? `Seul exemplaire du réseau à ${court(bib)} : ${C.listeCompacte(seuls)}. ` : ""}Aussi présents ailleurs : ${C.listeCompacte(doubles)}.`;
  return `<div class="rp" style="--rp:${taille}px">
      <div class="rp-ligne rp-tete"><span class="rp-nom"></span><span class="rp-cases">${entete}</span><span class="rp-total">tomes</span></div>
      ${rangees}
    </div>
    ${resume ? `<p class="discret petit rp-resume">${h(resume)}</p>` : ""}`;
}

function fermerFiche() {
  const fiche = $("#fiche");
  if (fiche.hidden) return;
  fiche.hidden = true;
  document.body.style.overflow = "";
  const id = fiche.dataset.id;
  const ligne = id && $(`[data-serie="${CSS.escape(id)}"]`);
  if (ligne) ligne.focus();
}

function formulaire(s) {
  const opt = (liste, val) => liste.map((x) => `<option ${x === (val || "") ? "selected" : ""} value="${h(x)}">${h(x || "—")}</option>`).join("");
  const genres = COL.mangas ? ["", "Shonen", "Seinen", "Shojo", "Josei", "Kodomo", "Manhwa", "Manhua", "Global-Manga", "Comics", "Autre Manga", "Autre"]
    : ["", ...new Set(etat.vues.map((v) => v.genre).filter(Boolean).sort((a, b) => a.localeCompare(b, "fr")))];
  if (s.genre && !genres.includes(s.genre)) genres.push(s.genre);
  const m = s.manuel || {};
  const L = s.liens || {};
  return `<form class="formulaire" data-form="serie" data-id="${h(s.id)}">
    <label class="champ large"><span>Titre</span><input name="titre" value="${h(s.titre)}" required></label>
    <label class="champ"><span>Genre</span><select name="genre">${opt(genres, s.genre)}</select></label>
    <label class="champ"><span>Public</span><select name="public">${opt(["", "Jeunesse", "Ado", "Adulte"], s.public)}</select></label>
    <label class="champ"><span>Âge conseillé</span><input name="age" value="${h(s.age)}" placeholder="12+"></label>
    <label class="champ"><span>Type</span><select name="type">${opt(["Série", "One shot"], s.type || "Série")}</select></label>
    ${COL.intercalaires ? `<label class="choix large"><input type="checkbox" name="intercalaire" ${s.intercalaire ? "checked" : ""}> Intercalaire en rayon pour cette série</label>` : ""}
    <label class="champ"><span>Tomes en commande</span><input name="commande" value="${h(s.commande)}" placeholder="12, 13"></label>
    <label class="champ"><span>Tomes parus en France (si les sources se trompent)</span><input name="parus" type="number" min="0" value="${Number.isFinite(m.parus) ? m.parus : ""}" placeholder="automatique"></label>
    <label class="champ"><span>État en France (si les sources se trompent)</span><select name="etat">${opt(["", "En cours", "Terminée", "En pause", "Abandonnée"], m.etat)}</select></label>
    ${COL.mangas ? `<label class="champ"><span>Série AniList (adresse ou numéro)</span><input name="anilist" value="${h(L.anilist ?? "")}" placeholder="automatique"></label>
    <label class="champ large"><span>Page Manga-News</span><input name="mangaNews" value="${h(L.mangaNews)}" placeholder="https://www.manga-news.com/index.php/serie/…"></label>` : ""}
    <label class="champ large"><span>Page Bédéthèque</span><input name="bedetheque" value="${h(L.bedetheque)}" placeholder="https://www.bedetheque.com/serie-…html"></label>
    <label class="champ large"><span>Autres titres (un par ligne, pour retrouver la série dans Orphée)</span><textarea name="alias">${h((s.alias || []).join("\n"))}</textarea></label>
    <label class="champ large"><span>Commentaire</span><textarea name="commentaire">${h(s.commentaire)}</textarea></label>
    <div class="actions large">
      <button class="btn btn-fort" type="submit">Enregistrer</button>
      <span class="discret">Enregistré automatiquement pour toute l'équipe.</span>
    </div>
  </form>`;
}

function enregistrerFormulaire(form) {
  const s = etat.series.find((x) => x.id === form.dataset.id);
  if (!s) return;
  const d = Object.fromEntries(new FormData(form));
  const t = (x) => String(x ?? "").trim();
  s.titre = t(d.titre) || s.titre;
  for (const k of ["genre", "public", "age", "commande", "commentaire"]) { if (t(d[k])) s[k] = t(d[k]); else delete s[k]; }
  s.type = d.type === "One shot" ? "One shot" : "Série";
  if (COL.intercalaires) { if (d.intercalaire) s.intercalaire = true; else delete s.intercalaire; }
  const alias = t(d.alias).split("\n").map(t).filter(Boolean);
  if (alias.length) s.alias = alias; else delete s.alias;
  const liens = { ...(s.liens || {}) };
  const mn = t(d.mangaNews).replace(/^https?:\/\/(www\.)?manga-news\.com\//, "");
  const bd = t(d.bedetheque).replace(/^https?:\/\/(www\.)?bedetheque\.com\//, "");
  if (mn) liens.mangaNews = mn; else delete liens.mangaNews;
  if (bd) liens.bedetheque = bd; else delete liens.bedetheque;
  const al = t(d.anilist).match(/(\d+)/);
  if (al) liens.anilist = +al[1]; else delete liens.anilist;
  if (Object.keys(liens).length) s.liens = liens; else delete s.liens;
  const manuel = {};
  if (t(d.parus) !== "" && Number.isFinite(+d.parus)) manuel.parus = +d.parus;
  if (t(d.etat)) manuel.etat = t(d.etat);
  if (Object.keys(manuel).length) s.manuel = manuel; else delete s.manuel;
  // un lien AniList saisi à la main remplace celui trouvé automatiquement
  const enr = etat.enrich.series?.[s.id];
  if (enr?.anilist && liens.anilist && enr.anilist.id !== liens.anilist) enr.anilist = { id: liens.anilist, titre: "En attente de la prochaine vérification", statut: null };
  marquer("series");
  calculer();
  rendre();
  ouvrirFiche(s.id);
  toast("Série modifiée.");
}

// ---------------------------------------------------------------------------
// Vue : à acheter
// ---------------------------------------------------------------------------

function mesSeries() {
  return etat.vues.filter((v) => v.presence === "ici" || v.presence === "partagee");
}

function triPriorite(a, b) {
  return (b.pretsIci ?? 0) - (a.pretsIci ?? 0) || (b.prets ?? 0) - (a.prets ?? 0) || a.cle.localeCompare(b.cle, "fr");
}

function itemAchat(v, tomes, info) {
  return `<li class="cliquable" data-serie="${h(v.s.id)}">
    <span class="vignette">${couverture(v)}</span>
    <span class="item-titre"><button type="button" class="lien-serie" data-serie="${h(v.s.id)}">${h(v.s.titre)}</button><small>${h([v.f?.editeur, info].filter(Boolean).join(", "))}</small></span>
    ${v.prets === null ? "" : `<span class="item-info">${pluriel(v.pretsIci, "prêt")}</span>`}
    <span class="item-tomes">${h(tomes)}</span>
  </li>`;
}

function listeAchats() {
  const bib = etat.prefs.bib;
  const mes = mesSeries();
  // séries dont tous les exemplaires sont sans numéro dans Orphée : on ne sait pas quels tomes manquent
  const numerotees = mes.filter((v) => v.ici.length);
  const absentsReseau = numerotees.filter((v) => v.manquantsReseau.length).sort(triPriorite);
  const absentsIci = numerotees.map((v) => ({ v, t: v.manquantsIci.filter((i) => !v.manquantsReseau.includes(i)) }))
    .filter((x) => x.t.length).sort((a, b) => triPriorite(a.v, b.v));
  const aRemplacer = [];
  for (const v of mes) {
    const r = (v.f?.retires || []).filter((x) => x.bib === bib && !(x.tome && v.ici.includes(x.tome)));
    if (r.length) aRemplacer.push({ v, r });
  }
  // D'abord les prochaines sorties annoncées en France (par date), puis les tomes sortis au Japon et pas encore traduits
  const avenir = mes.filter((v) => v.info.prochain || v.info.aVenir > 0).sort((a, b) =>
    (a.info.prochain ? 0 : 1) - (b.info.prochain ? 0 : 1)
    || (a.info.prochain && b.info.prochain ? a.info.prochain.date.localeCompare(b.info.prochain.date) : 0)
    || (b.info.aVenir || 0) - (a.info.aVenir || 0) || a.cle.localeCompare(b.cle, "fr"));
  return { absentsReseau, absentsIci, aRemplacer, avenir };
}

function rendreAcheter() {
  const bib = court(etat.prefs.bib);
  const { absentsReseau, absentsIci, aRemplacer, avenir } = listeAchats();
  const nb = (l, f) => l.reduce((a, x) => a + f(x), 0);
  const onglets = [
    { cle: "reseau", titre: COL.reseau ? "Absents du réseau" : "Manquants", n: nb(absentsReseau, (v) => v.manquantsReseau.length),
      texte: COL.reseau ? "Tomes parus en France qu'aucune médiathèque du réseau n'a." : `Tomes parus que ${h(bib)} n'a pas.`,
      items: absentsReseau.map((v) => itemAchat(v, C.listeCompacte(v.manquantsReseau), v.info.etat)),
      vide: "Tous les tomes parus sont dans le réseau." },
    { cle: "ailleurs", titre: `Absents de ${bib}`, n: nb(absentsIci, (x) => x.t.length),
      texte: `Tomes qui manquent à ${h(bib)} mais qu'une autre médiathèque a : les lecteurs peuvent les réserver.`,
      items: absentsIci.map((x) => itemAchat(x.v, C.listeCompacte(x.t), "")),
      vide: "Aucun." },
    { cle: "remplacer", titre: "À remplacer", n: nb(aRemplacer, (x) => x.r.length),
      texte: `Exemplaires de ${h(bib)} perdus, hors service, à pilonner ou marqués pour rachat dans Orphée.`,
      items: aRemplacer.map((x) => itemAchat(x.v, x.r.map((r) => r.tome ?? "?").join(", "), x.r.map((r) => r.statut.toLowerCase()).join(", "))),
      vide: "Aucun exemplaire à remplacer." },
    { cle: "avenir", titre: "À paraître", n: nb(avenir, (v) => Math.max(v.info.aVenir || 0, v.info.prochain ? 1 : 0)),
      texte: "Prochaines sorties annoncées en France (d'après Manga-News), puis tomes déjà sortis en VO mais pas encore traduits.",
      items: avenir.map((v) => {
        const p = v.info.prochain;
        const vo = v.info.aVenir > (p ? 1 : 0) ? `${v.info.aVenir} ${v.info.aVenir > 1 ? "tomes" : "tome"} déjà sortis ${enVO(v.info)}` : v.info.etat;
        return itemAchat(v, p ? `${p.tome ? `T${p.tome}, ` : ""}${jourMois(p.date)}` : `${v.info.aVenir} à venir`, p ? vo : v.info.etat);
      }),
      vide: "Rien pour l'instant." },
  ];
  if (!COL.reseau) onglets.splice(onglets.findIndex((o) => o.cle === "ailleurs"), 1);
  if (!COL.mangas) onglets.splice(onglets.findIndex((o) => o.cle === "avenir"), 1);
  const cur = onglets.find((o) => o.cle === etat.ongletAchat) || onglets[0];
  $("#vue").innerHTML = `
    <div class="entete-vue">
      <h1>À acheter</h1>
      <div class="liens-vue"><button class="btn-lien" data-action="csv">Exporter en tableur</button><button class="btn-lien" data-action="imprimer">Imprimer</button></div>
    </div>
    <p class="chapo">Pour les séries présentes à ${h(bib)}${etat.stats ? ", les plus empruntées en premier" : ""}.</p>
    <div class="onglets-liste" role="group" aria-label="Listes">
      ${onglets.map((o) => `<button type="button" data-onglet-achat="${o.cle}" aria-pressed="${o === cur}">${o.titre}<span>${nf.format(o.n)}</span></button>`).join("")}
    </div>
    <p class="explication">${cur.texte}</p>
    ${cur.items.length ? `<ul class="items">${cur.items.join("")}</ul>` : `<p class="vide">${cur.vide}</p>`}
  `;
}

function exporterCSV() {
  const bib = etat.prefs.bib;
  const { absentsReseau, absentsIci, aRemplacer } = listeAchats();
  const lignes = [["Liste", "Série", "Éditeur", "Tomes", "Prêts " + court(bib), "Prêts réseau"]];
  const p = (v) => [v.pretsIci ?? "", v.prets ?? ""];
  absentsReseau.forEach((v) => lignes.push(["Absent du réseau", v.s.titre, v.f?.editeur || "", C.listeCompacte(v.manquantsReseau), ...p(v)]));
  absentsIci.forEach((x) => lignes.push([`Absent de ${court(bib)}`, x.v.s.titre, x.v.f?.editeur || "", C.listeCompacte(x.t), ...p(x.v)]));
  aRemplacer.forEach((x) => lignes.push(["À remplacer", x.v.s.titre, x.v.f?.editeur || "", x.r.map((r) => r.tome ?? "?").join(", "), ...p(x.v)]));
  telechargerCSV(lignes, `suivixo-a-acheter-${court(bib).toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`);
}

/** Fichier CSV lisible par Excel (point-virgule, BOM UTF-8). */
function telechargerCSV(lignes, nom) {
  const csv = "﻿" + lignes.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = nom;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------------------
// Vue : prêts (chiffres de l'export Orphée, gardés dans ce navigateur, jamais publiés)
// ---------------------------------------------------------------------------

const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 });

/** Chiffres de prêt d'une série, pour ma médiathèque ou pour tout le réseau. */
function chiffresPrets(v, portee) {
  const st = etat.stats?.series?.[v.s.id];
  if (!st) return null;
  const bib = etat.prefs.bib;
  const pris = (o) => (portee === "ici" ? o?.[bib] || 0 : somme(o));
  const ex = pris(st.exemplaires);
  if (!ex) return null;
  const pr = pris(st.prets);
  const tomes = {};
  for (const b of portee === "ici" ? [bib] : Object.keys(st.parTome || {})) {
    for (const [n, [p, e]] of Object.entries(st.parTome?.[b] || {})) {
      const c = (tomes[n] ||= [0, 0]);
      c[0] += p; c[1] += e;
    }
  }
  return { v, ex, pr, parEx: pr / ex, emp: pris(st.empruntes), res: pris(st.reserves), tomes, detailTomes: !!st.parTome };
}

/** Les lecteurs du tome 1 lisent-ils la suite ? On compare aux tomes 2 et 3, arrivés en général en même temps
 *  (les derniers tomes, plus récents, ont forcément moins de prêts). */
function suiteDuTome1(c) {
  const t = c.tomes;
  if (!t[1] || !(t[2] || t[3]) || Object.keys(t).length < 3) return null;
  const r1 = t[1][0] / t[1][1];
  if (r1 < 5) return null; // trop peu de prêts pour conclure
  const suite = [2, 3].filter((n) => t[n]).map((n) => t[n][0] / t[n][1]);
  const rs = suite.reduce((a, b) => a + b, 0) / suite.length;
  return { r1, rs, ratio: rs / r1 };
}

function ligneBarre({ id = "", titre, sous = "", x, texte, attenue = false, couv = "", extra = "" }) {
  return `<li class="bp-ligne${id ? " cliquable" : ""}${attenue ? " attenue" : ""}"${id ? ` data-serie="${h(id)}"` : ""}>
    ${couv ? `<span class="vignette">${couv}</span>` : ""}
    <span class="bp-titre">${id ? `<button type="button" class="lien-serie" data-serie="${h(id)}">${h(titre)}</button>` : `<span>${h(titre)}</span>`}${sous ? `<small>${h(sous)}</small>` : ""}</span>
    ${extra}
    <span class="bp-barre${x === null ? " sans-trait" : ""}" title="${h(titre)} : ${h(texte)}">${x === null ? "" : `<span class="bp-trait" style="--x:${Math.max(0.015, Math.min(1, x)).toFixed(3)}"></span>`}<span class="bp-val">${h(texte)}</span></span>
  </li>`;
}

function colonnesTomes(c) {
  const ns = Object.keys(c.tomes).map(Number).sort((a, b) => a - b).slice(0, 40);
  const vals = ns.map((n) => c.tomes[n][0] / c.tomes[n][1]);
  const max = Math.max(...vals, 1);
  const lu = ns.map((n, i) => `tome ${n} : ${nf1.format(vals[i])}`).join(", ");
  // colonnes plus fines quand la série est longue, pour tenir dans la même largeur
  const larg = Math.max(2, Math.min(6, Math.floor((150 - 2 * ns.length) / ns.length)));
  return `<span class="bp-tomes" role="img" aria-label="Prêts par exemplaire, ${h(lu)}">${ns.map((n, i) =>
    `<span class="${n === 1 ? "t1" : ""}" style="width:${larg}px;height:${Math.max(6, (vals[i] / max) * 100).toFixed(0)}%" title="Tome ${n} : ${nf1.format(vals[i])} prêts par exemplaire"></span>`).join("")}</span>`;
}

function donneesPrets() {
  const portee = COL.reseau && etat.prefs.pretsPortee === "reseau" ? "reseau" : "ici";
  const liste = etat.vues.map((v) => chiffresPrets(v, portee)).filter(Boolean);
  const tot = liste.reduce((a, c) => ({ ex: a.ex + c.ex, pr: a.pr + c.pr, emp: a.emp + c.emp, res: a.res + c.res }), { ex: 0, pr: 0, emp: 0, res: 0 });
  return { portee, liste, tot };
}

function rendrePrets() {
  const bib = court(etat.prefs.bib);
  if (!etat.stats) {
    $("#vue").innerHTML = `
      <h1>Les prêts</h1>
      <p class="chapo">Cette page montre quelles séries sortent le plus, lesquelles sont réservées en ce moment et lesquelles ne sortent plus. Les chiffres viennent de l'export Orphée : importe-le sur ce poste pour les voir.</p>
      <p><a class="btn btn-fort" href="#import">Importer un export Orphée</a></p>
      <p class="explication">Les prêts et les réservations restent dans ce navigateur. Ils ne sont jamais publiés.</p>`;
    return;
  }
  const { portee, liste, tot } = donneesPrets();
  const ou = portee === "ici" ? `à ${bib}` : "dans le réseau";
  const tri = etat.prefs.pretsTri === "parEx" ? "parEx" : "total";

  const top = [...liste].sort((a, b) => (tri === "total" ? b.pr - a.pr || b.parEx - a.parEx : b.parEx - a.parEx || b.pr - a.pr)).slice(0, 15);
  const maxTop = Math.max(...top.map((c) => (tri === "total" ? c.pr : c.parEx)), 1);
  const lignesTop = top.map((c) => ligneBarre({
    id: c.v.s.id, titre: c.v.s.titre, couv: couverture(c.v),
    sous: tri === "total" ? `${pluriel(c.ex, "exemplaire")}, ${nf1.format(c.parEx)} prêts par ex.` : `${pluriel(c.pr, "prêt")} pour ${pluriel(c.ex, "exemplaire")}`,
    x: (tri === "total" ? c.pr : c.parEx) / maxTop,
    texte: tri === "total" ? pluriel(c.pr, "prêt") : `${nf1.format(c.parEx)} / ex.`,
  })).join("");

  const attente = liste.filter((c) => c.res > 0).sort((a, b) => b.res - a.res || b.emp / b.ex - a.emp / a.ex);
  const lignesAttente = attente.slice(0, 12).map((c) => `<li class="cliquable" data-serie="${h(c.v.s.id)}">
      <span class="vignette">${couverture(c.v)}</span>
      <span class="item-titre"><button type="button" class="lien-serie" data-serie="${h(c.v.s.id)}">${h(c.v.s.titre)}</button><small>${c.emp ? `${c.emp} ${c.emp > 1 ? "exemplaires sortis" : "exemplaire sorti"} sur ${c.ex}` : `${pluriel(c.ex, "exemplaire")}, aucun sorti`}</small></span>
      <span class="item-tomes neutre">${pluriel(c.res, "réservation")}</span>
    </li>`).join("");

  const detail = liste.some((c) => c.detailTomes);
  const suites = liste.map((c) => ({ c, s: suiteDuTome1(c) })).filter((x) => x.s);
  const ligneSuite = (x) => ligneBarre({
    id: x.c.v.s.id, titre: x.c.v.s.titre, couv: couverture(x.c.v),
    sous: `tome 1 : ${nf1.format(x.s.r1)} prêts par ex., tomes 2 et 3 : ${nf1.format(x.s.rs)}`,
    x: null, texte: pct.format(Math.min(x.s.ratio, 9.99)),
    extra: colonnesTomes(x.c),
  });
  const arret = suites.filter((x) => x.s.ratio <= 0.5).sort((a, b) => a.s.ratio - b.s.ratio || b.s.r1 - a.s.r1).slice(0, 8);
  const continuent = suites.filter((x) => x.s.ratio >= 0.9).sort((a, b) => b.s.r1 - a.s.r1).slice(0, 8);

  const recente = (v) => (v.s.ajout && Date.now() - Date.parse(v.s.ajout) < 365 * 864e5);
  const calmes = liste.filter((c) => !recente(c.v) && c.emp === 0 && c.res === 0).sort((a, b) => a.parEx - b.parEx || a.pr - b.pr).slice(0, 15);
  const maxCalme = Math.max(...calmes.map((c) => c.parEx), 1);
  const lignesCalmes = calmes.map((c) => ligneBarre({
    id: c.v.s.id, titre: c.v.s.titre, couv: couverture(c.v),
    sous: `${pluriel(c.pr, "prêt")} pour ${pluriel(c.ex, "exemplaire")}`, x: c.parEx / maxCalme, texte: `${nf1.format(c.parEx)} / ex.`, attenue: true,
  })).join("");

  const parGenre = {};
  for (const c of liste) {
    const g = c.v.genre || "Sans genre";
    const o = (parGenre[g] ||= { ex: 0, pr: 0, n: 0 });
    o.ex += c.ex; o.pr += c.pr; o.n += 1;
  }
  const genres = Object.entries(parGenre).sort((a, b) => b[1].pr / b[1].ex - a[1].pr / a[1].ex);
  const maxGenre = Math.max(...genres.map(([, o]) => o.pr / o.ex), 1);
  const lignesGenres = genres.map(([g, o]) => ligneBarre({
    titre: g, sous: `${pluriel(o.n, "série")}, ${pluriel(o.ex, "exemplaire")}`, x: o.pr / o.ex / maxGenre, texte: `${nf1.format(o.pr / o.ex)} / ex.`, attenue: g === "Sans genre",
  })).join("");

  // toutes les médiathèques, quelle que soit la portée choisie
  const parBib = {};
  for (const st of Object.values(etat.stats.series || {})) {
    for (const [b, n] of Object.entries(st.exemplaires || {})) {
      const o = (parBib[b] ||= { ex: 0, pr: 0, emp: 0 });
      o.ex += n; o.pr += st.prets?.[b] || 0; o.emp += st.empruntes?.[b] || 0;
    }
  }
  const bibs = Object.entries(parBib).filter(([, o]) => o.ex).sort((a, b) => b[1].pr / b[1].ex - a[1].pr / a[1].ex);
  const maxBib = Math.max(...bibs.map(([, o]) => o.pr / o.ex), 1);
  const lignesBibs = bibs.map(([b, o]) => ligneBarre({
    titre: court(b), sous: `${pluriel(o.ex, "exemplaire")}, ${pct.format(o.emp / o.ex)} sortis en ce moment`, x: o.pr / o.ex / maxBib,
    texte: `${nf1.format(o.pr / o.ex)} / ex.`, attenue: b !== etat.prefs.bib,
  })).join("");

  const vide = (t) => `<p class="explication">${t}</p>`;
  $("#vue").innerHTML = `
    <div class="entete-vue">
      <h1>Les prêts</h1>
      <div class="liens-vue"><button class="btn-lien" data-action="csv-prets">Exporter en tableur</button></div>
    </div>
    <p class="chapo">D'après l'export Orphée du ${h(dateFr(etat.stats.date))}. Les prêts sont cumulés depuis l'arrivée de chaque exemplaire. Ces chiffres restent dans ce navigateur : ils ne sont jamais publiés.</p>
    ${COL.reseau ? `<div class="vues" role="group" aria-label="Portée">
      <button type="button" data-portee="ici" aria-pressed="${portee === "ici"}">${h(bib)}</button>
      <button type="button" data-portee="reseau" aria-pressed="${portee === "reseau"}">Tout le réseau</button>
    </div>` : ""}

    <div class="kpi">
      <div><strong>${nf.format(tot.pr)}</strong><span>prêts au total</span></div>
      <div><strong>${nf.format(tot.ex)}</strong><span>exemplaires</span></div>
      <div><strong>${tot.ex ? nf1.format(tot.pr / tot.ex) : "0"}</strong><span>prêts par exemplaire</span></div>
      <div><strong>${nf.format(tot.emp)}</strong><span>sortis en ce moment${tot.ex ? `, ${pct.format(tot.emp / tot.ex)} du fonds` : ""}</span></div>
      <div><strong>${nf.format(tot.res)}</strong><span>${tot.res > 1 ? "réservés" : "réservé"} en ce moment</span></div>
    </div>

    <div class="prets-grille">
      <section>
        <div class="titre-section"><h2>Les plus empruntées ${h(ou)}</h2>
          <div class="vues petit" role="group" aria-label="Classer">
            <button type="button" data-tri-prets="total" aria-pressed="${tri === "total"}">Au total</button>
            <button type="button" data-tri-prets="parEx" aria-pressed="${tri === "parEx"}">Par exemplaire</button>
          </div>
        </div>
        <p class="explication">${tri === "total" ? "Une série avec beaucoup de tomes cumule forcément beaucoup de prêts." : "Les prêts divisés par le nombre d'exemplaires : chaque tome compte autant, que la série soit longue ou courte."}</p>
        <ul class="items bp">${lignesTop}</ul>
      </section>
      <section>
        <h2>Réservées en ce moment</h2>
        <p class="explication">Une série souvent réservée mérite peut-être un exemplaire de plus.</p>
        ${attente.length ? `<ul class="items">${lignesAttente}</ul>` : vide("Aucune réservation en cours.")}
      </section>
    </div>

    <section>
      <h2>Après le tome 1, les lecteurs continuent-ils ?</h2>
      <p class="explication">Le pourcentage compare les prêts des tomes 2 et 3 à ceux du tome 1 (achetés en général en même temps ; les derniers tomes, plus récents, ont forcément moins de prêts). Les petites colonnes montrent les prêts de chaque tome, le tome 1 en foncé. Seulement les séries dont le tome 1 sort bien : au moins 5 prêts par exemplaire.</p>
      ${!detail ? vide("Ce détail par tome n'existait pas encore lors de ton dernier import. Refais un import Orphée pour le voir.")
        : `<div class="prets-grille">
        <div><h3>Les lecteurs continuent</h3>${continuent.length ? `<ul class="items bp">${continuent.map(ligneSuite).join("")}</ul>` : vide("Aucune série pour l'instant.")}</div>
        <div><h3>Les lecteurs s'arrêtent</h3>${arret.length ? `<ul class="items bp">${arret.map(ligneSuite).join("")}</ul>` : vide("Aucune série où les lecteurs décrochent nettement.")}</div>
      </div>`}
    </section>

    <div class="prets-grille">
      <section>
        <h2>Celles qui sortent le moins</h2>
        <p class="explication">Les moins de prêts par exemplaire, parmi les séries qui ne sont ni sorties ni réservées en ce moment. Les séries arrivées depuis moins d'un an ne sont pas comptées. À mettre en avant, ou à regarder au moment du désherbage.</p>
        ${calmes.length ? `<ul class="items bp">${lignesCalmes}</ul>` : vide("Aucune.")}
      </section>
      <section>
        <h2>Par genre</h2>
        <p class="explication">Prêts par exemplaire ${h(ou)}, genre par genre.</p>
        <ul class="items bp">${lignesGenres}</ul>
        ${COL.reseau ? `<h2>Dans le réseau</h2>
        <p class="explication">Prêts par exemplaire de mangas, médiathèque par médiathèque.</p>
        <ul class="items bp">${lignesBibs}</ul>` : ""}
      </section>
    </div>
  `;
}

function exporterCSVPrets() {
  const bib = etat.prefs.bib;
  const lignes = [["Série", "Éditeur", "Genre", `Exemplaires ${court(bib)}`, `Prêts ${court(bib)}`, `Prêts par exemplaire ${court(bib)}`, "Exemplaires réseau", "Prêts réseau", "Prêts par exemplaire réseau", "Sortis en ce moment (réseau)", "Réservés en ce moment (réseau)"]];
  const virg = (x) => (Number.isFinite(x) ? String(Math.round(x * 10) / 10).replace(".", ",") : "");
  for (const v of [...etat.vues].sort((a, b) => a.cle.localeCompare(b.cle, "fr"))) {
    const r = chiffresPrets(v, "reseau");
    if (!r) continue;
    const i = chiffresPrets(v, "ici");
    lignes.push([v.s.titre, v.f?.editeur || "", v.genre || "", i?.ex || 0, i?.pr || 0, i ? virg(i.parEx) : "", r.ex, r.pr, virg(r.parEx), r.emp, r.res]);
  }
  telechargerCSV(lignes, `suivixo-prets-${(etat.stats.date || "").slice(0, 10)}.csv`);
}

// ---------------------------------------------------------------------------
// Vue : contrôles
// ---------------------------------------------------------------------------

function controles() {
  const bib = etat.prefs.bib;
  const mes = mesSeries();
  const commandesRecues = mes.filter((v) => {
    const c = C.lireListe(v.s.commande);
    return c.length && c.every((i) => v.ici.includes(i));
  });
  const sansExemplaire = etat.vues.filter((v) => v.presence === "aucune");
  // nouvelles séries : celles du dernier import d'abord (elles seules comptent dans le chiffre de l'onglet)
  const dernierImport = etat.fonds.import?.date || null;
  const aVoir = etat.vues.filter((v) => (v.s.ajout || v.s.nouvelle) && !v.s.vu);
  const estDuDernier = (v) => !v.s.ajout || !dernierImport || v.s.ajout >= dernierImport;
  const nouvelles = aVoir.filter(estDuDernier);
  const anciennesNouvelles = aVoir.filter((v) => !estDuDernier(v));
  const auDela = etat.vues.filter((v) => v.info.parus !== null && v.info.sourceParus === "manuel" && v.reseau.length && v.reseau[v.reseau.length - 1] > v.info.parus);
  // exemplaire sans numéro dans une série dont les autres tomes sont numérotés : champ tome sans doute
  // oublié dans Orphée. Les titres d'une série jamais numérotée (« 100 % bio »…) sont normaux : ils restent
  // dans la fiche de la série (« Titres sans numéro dans Orphée »).
  const numerotee = (id, b) => (etat.fonds.series?.[id]?.tomes?.[b] || []).length > 0
    || ((etat.enrich.series?.[id]?.bnf?.dernier || 0) >= 2 && etat.enrich.series[id].bnf.accordIsbn !== false);
  const anomalies = (etat.fonds.anomalies || []).filter((a) => numerotee(a.serie, a.bib));
  const aRelier = !COL.mangas ? [] : mes.filter((v) => !v.s.liens?.anilist && (!v.enr?.anilist || v.enr.anilist.auteurDifferent || v.enr.anilist.auto && (v.enr.anilist.score ?? 1) < 0.9) && v.s.genre !== "Comics" && v.s.type !== "One shot");
  // les titres uniques (romans isolés…) n'y figurent pas : surtout utile pour les séries
  const incomplet = mes.filter((v) => v.s.type !== "One shot" && (!v.genre || !v.s.public));
  return { commandesRecues, sansExemplaire, nouvelles, anciennesNouvelles, dernierImport, auDela, anomalies, aRelier, incomplet, bib };
}

function suggestions(v) {
  const k = C.cleTitre(v.s.titre);
  if (k.length < 3) return [];
  return etat.vues.filter((o) => o !== v && o.presence !== "aucune").filter((o) => {
    const ko = C.cleTitre(o.s.titre);
    return ko.length >= 3 && (k.startsWith(ko) || ko.startsWith(k));
  }).slice(0, 3);
}

function rendreControles() {
  const c = controles();
  const bib = court(c.bib);
  const autres = [...etat.vues].filter((v) => v.presence !== "aucune").sort((a, b) => a.cle.localeCompare(b.cle, "fr"));
  const optionsSeries = autres.map((o) => `<option value="${h(o.s.id)}">${h(o.s.titre)}</option>`).join("");
  const bloc = (titre, items, explication, ouvert = false) => items.length ? `
    <details class="bloc${ouvert ? " urgent" : ""}" ${ouvert ? "open" : ""}>
      <summary>${titre} <span class="n">${nf.format(items.length)}</span></summary>
      <div class="contenu"><p class="explication">${explication}</p><ul class="items">${items.join("")}</ul></div>
    </details>` : "";
  const li = (id, titre, detail, actions = "") => `<li>
    <span class="item-titre"><button type="button" class="lien-serie" data-serie="${h(id)}">${h(titre)}</button>${detail ? `<small>${h(detail)}</small>` : ""}</span>
    ${actions ? `<span class="item-actions">${actions}</span>` : ""}</li>`;

  const blocs = [
    bloc("Commandes arrivées", c.commandesRecues.map((v) => li(v.s.id, v.s.titre, `En commande : ${v.s.commande}`,
      `<button class="btn" data-action="vider-commande" data-id="${h(v.s.id)}">Vider la commande</button>`)),
      `Tous les tomes notés en commande sont maintenant à ${h(bib)}.`, true),
    bloc(`Nouvelles séries${c.dernierImport ? ` de l'import du ${dateFr(c.dernierImport)}` : ""}`, c.nouvelles.map((v) => li(v.s.id, v.s.titre, `Ajoutée par l'import${v.s.ajout ? ` du ${dateFr(v.s.ajout)}` : ""}`,
      `<button class="btn" data-action="vu" data-id="${h(v.s.id)}">C'est bon</button>`)),
      `Apparues dans Orphée depuis l'import précédent (y compris les titres uniques). Vérifie le titre et complète le genre. Si c'est une série déjà connue sous un autre nom, rattache-la depuis sa fiche.${c.nouvelles.length > 3 ? ` <button class="btn" data-action="tout-vu" data-quand="dernier">Tout marquer comme bon</button>` : ""}`, true),
    bloc("Exemplaires sans numéro dans une série numérotée", c.anomalies.map((a) => li(a.serie, a.titre, `${a.album && a.album !== a.titre ? `« ${a.album} », ` : ""}${court(a.bib)}, cote ${a.cote || "?"}`)),
      "Ces séries sont numérotées (dans Orphée ou à la BnF), mais le champ tome de ces exemplaires est vide dans Orphée : ils ne sont pas comptés. Remplis-le dans Orphée si c'est un oubli. Les titres des séries qui ne sont jamais numérotées sont normaux : ils figurent dans la fiche de leur série."),
    bloc(`Séries de ${h(bib)} à relier à AniList`, c.aRelier.map((v) => li(v.s.id, v.s.titre, v.enr?.anilist ? `Proposition : ${v.enr.anilist.titre}${v.enr.anilist.auteurDifferent ? ", mais l'auteur ne correspond pas" : ""}` : "")),
      "Sans ce lien, Suivixo ne sait pas où en est la série au Japon. Ouvre la fiche, cherche la série sur anilist.co et colle son adresse dans « Modifier la série »."),
    bloc("Nombre de tomes saisi à la main dépassé", c.auDela.map((v) => li(v.s.id, v.s.titre, `Le réseau va jusqu'au tome ${v.reseau[v.reseau.length - 1]}, la fiche dit ${pluriel(v.info.parus, "tome paru", "tomes parus")}`)),
      "Le nombre saisi dans la fiche n'est plus à jour : mets-le à jour ou vide le champ pour revenir au calcul automatique."),
    bloc("Sans exemplaire au dernier import", c.sansExemplaire.map((v) => {
      const sug = suggestions(v);
      return li(v.s.id, v.s.titre, sug.length ? `Peut-être : ${sug.map((o) => o.s.titre).join(", ")}` : "", `
        <select data-relier="${h(v.s.id)}" aria-label="Relier ${h(v.s.titre)} à une autre série">
          <option value="">Relier à…</option>
          ${sug.map((o) => `<option value="${h(o.s.id)}">${h(o.s.titre)}</option>`).join("")}
          ${sug.length ? `<option disabled>──────────</option>` : ""}${optionsSeries}
        </select>
        <button class="btn btn-alerte" data-action="supprimer" data-id="${h(v.s.id)}">Supprimer</button>`);
    }), "Séries de l'ancien Excel qu'aucune médiathèque n'a. Relie-les à la bonne série si elles ont été renommées dans Orphée, sinon supprime-les."),
    bloc("Nouvelles séries des imports précédents, pas encore vues", c.anciennesNouvelles.map((v) => li(v.s.id, v.s.titre, `Ajoutée par l'import du ${dateFr(v.s.ajout)}`,
      `<button class="btn" data-action="vu" data-id="${h(v.s.id)}">C'est bon</button>`)),
      `Elles ne comptent plus dans le chiffre de l'onglet.${c.anciennesNouvelles.length > 3 ? ` <button class="btn" data-action="tout-vu" data-quand="anciennes">Tout marquer comme bon</button>` : ""}`),
    bloc(`Séries de ${h(bib)} sans genre${c.incomplet.some((v) => !v.s.public) ? " ou sans public" : ""}`, c.incomplet.map((v) => li(v.s.id, v.s.titre, `${[!v.genre && "genre", !v.s.public && "public"].filter(Boolean).join(" et ")} à compléter`)),
      `Le genre sert seulement au filtre « Genre » de la liste des séries. ${COL.mangas ? "Il vient d'AniList (relie la série) ou" : "Il vient du champ CS2 d'Orphée : il suffit de le remplir pour un exemplaire de la série (le tome 1, par exemple). Sinon, il vient"} de « Modifier la série ». Les titres uniques ne sont pas listés ici.`),
  ].join("");

  $("#vue").innerHTML = `
    <h1>Contrôles</h1>
    <p class="chapo">Ce qui demande une action après un import. Le chiffre de l'onglet compte les commandes arrivées et les nouvelles séries du dernier import ; le reste peut attendre.</p>
    ${blocs || `<p class="vide">Rien à vérifier.</p>`}
  `;
}

function nbControles() {
  const c = controles();
  return c.commandesRecues.length + c.nouvelles.length;
}

function relier(idSource, idCible) {
  const src = etat.series.find((s) => s.id === idSource);
  const cible = etat.series.find((s) => s.id === idCible);
  if (!src || !cible || src === cible) return;
  cible.alias = [...new Set([...(cible.alias || []), src.titre, ...(src.alias || [])])].filter((t) => t !== cible.titre);
  for (const k of ["genre", "public", "age", "commande", "commentaire"]) if (!cible[k] && src[k]) cible[k] = src[k];
  if (src.liens) cible.liens = { ...src.liens, ...(cible.liens || {}) };
  if (src.ancien && !cible.ancien) cible.ancien = src.ancien;
  etat.series = etat.series.filter((s) => s !== src);
  // Exemplaires déjà importés sous l'autre titre : on les range tout de suite dans la bonne série
  const fs = etat.fonds.series?.[idSource];
  if (fs) {
    const fc = (etat.fonds.series[idCible] ||= { titreOrphee: cible.titre, editeur: fs.editeur || "", tomes: {} });
    // un titre unique n'a pas de vrai numéro (« 1 ») : il rejoint les titres sans numéro de la série
    const unique = src.type === "One shot" || fs.oneShot;
    for (const [b, l] of Object.entries(fs.tomes || {})) {
      if (unique) (fc.sansNumero ||= {})[b] = [...new Set([...(fc.sansNumero[b] || []), src.titre])];
      else fc.tomes[b] = [...new Set([...(fc.tomes[b] || []), ...l])].sort((a, b2) => a - b2);
    }
    for (const [b, n] of Object.entries(fs.hs || {})) (fc.hs ||= {})[b] = (fc.hs[b] || 0) + n;
    if (fs.retires?.length) fc.retires = [...(fc.retires || []), ...fs.retires];
    if (fs.sansNumero) for (const [b, l] of Object.entries(fs.sansNumero)) (fc.sansNumero ||= {})[b] = [...new Set([...(fc.sansNumero[b] || []), ...l])];
    delete etat.fonds.series[idSource];
    marquer("fonds");
    const st = etat.stats?.series;
    if (st?.[idSource]) {
      const a = st[idSource], c = (st[idCible] ||= { prets: {}, empruntes: {}, reserves: {}, exemplaires: {}, parTome: {} });
      for (const k of ["prets", "empruntes", "reserves", "exemplaires"]) for (const [b, n] of Object.entries(a[k] || {})) c[k][b] = (c[k][b] || 0) + n;
      for (const [b, t] of Object.entries(a.parTome || {})) for (const [n, [p, e]] of Object.entries(t)) {
        const x = ((c.parTome ||= {})[b] ||= {})[n] ||= [0, 0];
        x[0] += p; x[1] += e;
      }
      delete st[idSource];
      lsSet(LS.stats, etat.stats);
    }
  }
  marquer("series");
  calculer();
  rendre();
  toast(`« ${src.titre} » est maintenant un autre titre de « ${cible.titre} ».`);
}

// ---------------------------------------------------------------------------
// Vue : import
// ---------------------------------------------------------------------------

function rendreImport() {
  const ip = etat.importPrevu;
  const bib = court(etat.prefs.bib);
  if (!ip) {
    $("#vue").innerHTML = `
      <h1>Importer un export Orphée</h1>
      <p class="chapo">Collection : <strong>${h(COL.nom)}</strong>. Fais l'édition ${h(COL.des)}${COL.reseau ? "" : ` de ${h(court(etat.prefs.bib))}`} dans Orphée, enregistre le fichier, puis dépose-le ici. Il est lu sur ce poste et n'est envoyé nulle part. Pour une autre collection, change-la d'abord en haut de la page.</p>
      <label class="depot" id="depot">
        <input type="file" id="fichier" accept=".xlsx,.xls,.xlsm,.ods" hidden>
        <svg viewBox="0 0 64 44" aria-hidden="true">
          <rect x="4" y="4" width="9" height="36" rx="1.5" class="t-ici"/><rect x="15" y="4" width="9" height="36" rx="1.5" class="t-ici"/>
          <rect x="26" y="4" width="9" height="36" rx="1.5" fill="url(#trame)" class="t-reseau"/><rect x="37" y="4" width="9" height="36" rx="1.5" class="t-manque"/>
          <rect x="48.5" y="4.5" width="9" height="35" rx="1.5" class="t-avenir"/>
        </svg>
        <strong>Déposer le fichier ici</strong>
        <span class="discret petit">ou cliquer pour le choisir</span>
      </label>
      <p class="note">Seuls les tomes présents dans chaque médiathèque sont publiés. Les prêts et les réservations restent dans ce navigateur.</p>`;
    return;
  }
  const d = ip.diff;
  const nbT = (l) => l.reduce((a, x) => a + x.tomes.length, 0);
  const bloc = (titre, n, items, ouvert = false) => n ? `
    <details class="bloc" ${ouvert ? "open" : ""}>
      <summary>${titre} <span class="n">${nf.format(n)}</span></summary>
      <div class="contenu"><ul class="items">${items.slice(0, 300).join("")}</ul>${items.length > 300 ? `<p class="discret petit">Et ${items.length - 300} autres.</p>` : ""}</div>
    </details>` : "";
  const ligne = (titre, detail, tomes = "", neutre = false) => `<li><span class="item-titre">${h(titre)}${detail ? `<small>${h(detail)}</small>` : ""}</span>${tomes ? `<span class="item-tomes${neutre ? " neutre" : ""}">${h(tomes)}</span>` : ""}</li>`;
  const parBib = ip.parBib.map(([b, n]) => `${court(b)} ${nf.format(n)}`).join(", ");
  $("#vue").innerHTML = `
    <h1>Vérifier l'import</h1>
    <p class="chapo">« ${h(ip.nom)} » : ${pluriel(ip.nbExemplaires, "exemplaire")}${ip.annonce === ip.nbExemplaires ? " (tous ceux annoncés par Orphée)" : ""} dans ${pluriel(Object.keys(ip.res.fonds.series).length, "série")}${parBib ? ` (${h(parBib)})` : ""}. Rien n'est encore modifié.</p>
    ${(() => {
      // un fichier d'une autre collection ? (presque aucune série déjà connue ici)
      const nb = Object.keys(ip.res.fonds.series).length;
      return etat.series.length >= 20 && nb && ip.res.nouvelles.length / nb > 0.6
        ? `<p class="explication"><strong>Attention :</strong> ${pluriel(ip.res.nouvelles.length, "série")} sur ${nf.format(nb)} sont inconnues dans la collection « ${h(COL.nom)} ». Ce fichier est peut-être celui d'une autre collection : vérifie la collection choisie en haut de la page avant d'appliquer.</p>` : "";
    })()}
    ${ip.nbIsbn ? `<p class="explication">ISBN lus pour ${pluriel(ip.nbIsbn, "exemplaire")} sur ${nf.format(ip.nbExemplaires)} : ils servent à trouver la couverture de vos propres livres et la bonne série à la BnF.</p>`
      : ip.nbExemplaires && Object.values(etat.fonds.series || {}).some((f) => f.isbn) ? `<p class="explication"><strong>Attention :</strong> cet export ne contient pas les ISBN, contrairement au précédent. Sans eux, les couvertures et les séries retrouvées grâce aux ISBN ne seront plus vérifiées. Refais l'export avec la colonne ISBN si tu peux.</p>` : ""}
    ${ip.annonce && ip.nbExemplaires && ip.annonce !== ip.nbExemplaires ? `<p class="explication"><strong>Attention :</strong> Orphée annonce ${pluriel(ip.annonce, "document")}, mais Suivixo n'en a reconnu que ${nf.format(ip.nbExemplaires)}. Les autres ont une forme inattendue.</p>` : ""}
    ${ip.nbExemplaires === 0 ? `<p class="explication">Aucun exemplaire reconnu. Vérifie que c'est bien l'édition ${h(COL.des)} d'Orphée : une ligne par tome, suivie d'une ligne par exemplaire.</p>` : ""}
    <label class="champ" style="max-width:220px"><span>Date de l'export</span><input type="date" id="date-import" value="${h(ip.date)}"></label>
    <div class="actions" style="margin-bottom:24px">
      <button class="btn btn-fort" data-action="appliquer-import" ${ip.nbExemplaires ? "" : "disabled"}>Appliquer cet import</button>
      <button class="btn" data-action="annuler-import">Annuler</button>
    </div>
    ${bloc(`Nouveaux tomes à ${h(bib)}`, nbT(d.ajouts), d.ajouts.map((x) => ligne(x.titre, "", C.listeCompacte(x.tomes), true)), true)}
    ${bloc(`Tomes qui ne sont plus à ${h(bib)}`, nbT(d.retraits), d.retraits.map((x) => ligne(x.titre, "", C.listeCompacte(x.tomes))))}
    ${bloc("Nouvelles séries dans le réseau", ip.res.nouvelles.length, ip.res.nouvelles.map((s) => ligne(s.titre, ip.res.fonds.series[s.id]?.editeur || "")))}
    ${bloc("Exemplaires sans numéro de tome", ip.res.fonds.anomalies.length, ip.res.fonds.anomalies.map((a) => ligne(a.titre, `${court(a.bib)}, cote ${a.cote}`)))}
    ${!d.ajouts.length && !d.retraits.length && !ip.res.nouvelles.length ? `<p class="vide">Aucun changement à ${h(bib)} depuis le dernier import.</p>` : ""}
  `;
}

async function lireFichier(fichier) {
  if (!window.XLSX) { toast("Le lecteur de fichiers Excel n'est pas chargé. Recharge la page.", true); return; }
  toast("Lecture du fichier…");
  try {
    const wb = window.XLSX.read(await fichier.arrayBuffer(), { type: "array" });
    const nomFeuille = wb.SheetNames.includes("MajReseau") ? "MajReseau" : wb.SheetNames[0];
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[nomFeuille], { header: 1, defval: null, raw: false });
    const { exemplaires, annonce, date } = C.lireExportOrphee(rows, bibliotheques());
    const dateDefaut = date || (nomFeuille === "MajReseau" ? (etat.fonds.import?.date || new Date().toISOString().slice(0, 10)) : new Date(fichier.lastModified || Date.now()).toISOString().slice(0, 10));
    const res = C.construireFonds(exemplaires, etat.series, { date: dateDefaut, source: fichier.name });
    const bib = etat.prefs.bib;
    const titreDe = (id) => etat.series.find((s) => s.id === id)?.titre || res.nouvelles.find((s) => s.id === id)?.titre || id;
    const ajouts = [], retraits = [];
    const ids = new Set([...Object.keys(res.fonds.series), ...Object.keys(etat.fonds.series || {})]);
    for (const id of ids) {
      const avant = new Set(etat.fonds.series?.[id]?.tomes?.[bib] || []);
      const apres = new Set(res.fonds.series[id]?.tomes?.[bib] || []);
      const plus = [...apres].filter((i) => !avant.has(i)), moins = [...avant].filter((i) => !apres.has(i));
      if (plus.length) ajouts.push({ titre: titreDe(id), tomes: plus });
      if (moins.length) retraits.push({ titre: titreDe(id), tomes: moins });
    }
    const tri = (a, b) => C.cleTri(a.titre).localeCompare(C.cleTri(b.titre), "fr");
    const parBib = {};
    exemplaires.forEach((e) => { parBib[e.bib] = (parBib[e.bib] || 0) + 1; });
    etat.importPrevu = {
      nom: fichier.name, date: dateDefaut, res, nbExemplaires: exemplaires.length, annonce, nbIsbn: exemplaires.filter((e) => e.isbn).length,
      parBib: Object.entries(parBib).sort((a, b) => b[1] - a[1]),
      diff: { ajouts: ajouts.sort(tri), retraits: retraits.sort(tri) },
    };
    $("#toast").hidden = true;
    rendre();
  } catch (e) {
    console.error(e);
    toast(`Impossible de lire ce fichier : ${e.message}`, true);
  }
}

function appliquerImport() {
  const ip = etat.importPrevu;
  if (!ip) return;
  const date = $("#date-import")?.value || ip.date;
  ip.res.fonds.import.date = date;
  ip.res.stats.date = date;
  const premierImport = !etat.series.length; // collection vide : rien n'est « nouveau »
  for (const s of ip.res.nouvelles) {
    delete s.nouvelle;
    if (!premierImport) s.ajout = date;
    for (const k of Object.keys(s)) if (s[k] === "" || (Array.isArray(s[k]) && !s[k].length)) delete s[k];
    etat.series.push(s);
  }
  etat.series.sort((a, b) => a.titre.localeCompare(b.titre, "fr", { sensitivity: "base" }));
  etat.fonds = ip.res.fonds;
  etat.stats = ip.res.stats;
  lsSet(LS.stats, etat.stats);
  marquer("fonds");
  if (ip.res.nouvelles.length) marquer("series");
  etat.importPrevu = null;
  calculer();
  location.hash = "#series";
  toast("Import appliqué. Il s'enregistre pour toute l'équipe.");
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

/** Changements de ce poste par rapport à la version de départ : séries modifiées ou ajoutées, séries supprimées. */
function changementsSeries() {
  const base = new Map((etat.baseSeries || []).map((s) => [s.id, JSON.stringify(s)]));
  const ici = new Map(etat.series.map((s) => [s.id, s]));
  const changees = etat.series.filter((s) => base.get(s.id) !== JSON.stringify(s));
  const supprimees = [...base.keys()].filter((id) => !ici.has(id));
  // la vérification des parutions n'est utile que pour une nouvelle série ou des liens modifiés
  const avecLiens = changees.some((s) => {
    const b = base.get(s.id);
    return !b || JSON.stringify(JSON.parse(b).liens || {}) !== JSON.stringify(s.liens || {});
  });
  return { changees, supprimees, avecLiens };
}

/** Enregistre pour toute l'équipe (un commit dans le dépôt), puis lance la vérification des parutions si elle
 *  sert à quelque chose (import, nouvelle série, lien modifié). Les fiches sont fusionnées avec la version
 *  actuelle du dépôt : les changements faits entre-temps sur un autre poste sont gardés.
 *  Renvoie vrai si l'enregistrement a réussi (ou s'il n'y avait rien à enregistrer). */
async function lancerPublication({ verifier = true, auto = false } = {}) {
  clearTimeout(minuteurEnregistrement);
  if (!etat.token) {
    etat.erreurEnregistrement = "cle";
    majEntete();
    if (!auto) toast("Pas de clé d'accès GitHub : les modifications restent sur ce poste. Ajoute-la dans les Réglages.", true);
    return false;
  }
  if (etat.publication) { etat.aRefaire = true; return false; }
  if (!etat.modifie.size) return true;
  const quand = new Date().toISOString();
  const instantane = { date: quand };
  const modifie = new Set(etat.modifie);
  const { changees, supprimees, avecLiens } = changementsSeries();
  // état de chaque fiche au départ, pour reconnaître celles modifiées pendant l'enregistrement
  const auDepart = new Map(etat.series.map((s) => [s.id, JSON.stringify(s)]));
  etat.modifieDepuis = new Set();
  const avecVerification = verifier && (modifie.has("fonds") || avecLiens);
  etat.publication = true;
  etat.erreurEnregistrement = null;
  majEntete();
  try {
    for (let essai = 1; ; essai++) {
      const fichiers = [];
      let series = null;
      if (modifie.has("series")) {
        // fusion avec la version du dépôt : nos fiches modifiées, ajoutées ou supprimées ; le reste tel quel
        const brut = await lireFichierDepot({ token: etat.token, depot: etat.prefs.depot, chemin: `${COL.dossier}series.json` });
        const distant = brut ? JSON.parse(brut).series || [] : [];
        const parId = new Map(distant.map((s) => [s.id, s]));
        supprimees.forEach((id) => parId.delete(id));
        changees.forEach((s) => parId.set(s.id, s));
        series = [...parId.values()].sort((a, b) => a.titre.localeCompare(b.titre, "fr", { sensitivity: "base" }));
        fichiers.push({ chemin: `${COL.dossier}series.json`, contenu: JSON.stringify({ version: 1, publie: quand, series }, null, 1) + "\n" });
        instantane.series = series;
      }
      if (modifie.has("fonds")) {
        etat.fonds.publie = quand;
        fichiers.push({ chemin: `${COL.dossier}fonds.json`, contenu: JSON.stringify(etat.fonds, null, 1) + "\n" });
        instantane.fonds = etat.fonds;
      }
      const quoi = [modifie.has("fonds") && `import Orphée du ${dateFr(etat.fonds.import?.date)}`, modifie.has("series") && "fiches séries"].filter(Boolean).join(" et ");
      try {
        await publier({ token: etat.token, depot: etat.prefs.depot, fichiers, message: `Mise à jour depuis Suivixo (${COL.nom}) : ${quoi}` });
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && essai < 3) { await new Promise((r) => setTimeout(r, 1500 * essai)); continue; }
        throw e;
      }
      lsSet(LS.publie, instantane);
      if (series) {
        // fiches modifiées sur ce poste pendant l'enregistrement : gardées pour le prochain
        const depuis = etat.series.filter((s) => auDepart.get(s.id) !== JSON.stringify(s));
        const supprDepuis = [...auDepart.keys()].filter((id) => !etat.series.some((s) => s.id === id));
        const envoyees = JSON.parse(fichiers[0].contenu).series;
        etat.baseSeries = structuredClone(envoyees);
        const parId = new Map(envoyees.map((s) => [s.id, s]));
        supprDepuis.forEach((id) => parId.delete(id));
        depuis.forEach((s) => parId.set(s.id, s));
        const avant = JSON.stringify(etat.series.map((s) => s.id).sort());
        const fusion = [...parId.values()].sort((a, b) => a.titre.localeCompare(b.titre, "fr", { sensitivity: "base" }));
        // changements faits sur un autre poste : on les affiche
        const autresPostes = avant !== JSON.stringify(fusion.map((s) => s.id).sort()) || envoyees.some((s) => !changees.some((c) => c.id === s.id) && auDepart.get(s.id) !== undefined && auDepart.get(s.id) !== JSON.stringify(s));
        etat.series = fusion;
        if (autresPostes) { calculer(); rendre(); }
      }
      etat.modifie = new Set(etat.modifieDepuis);
      etat.modifieDepuis = new Set();
      etat.brouillonDate = null;
      sauverBrouillon();
      break;
    }
    etat.enregistreA = new Date();
    if (avecVerification) {
      try {
        await lancerVerification({ token: etat.token, depot: etat.prefs.depot, collection: COL_ID });
        if (!auto || modifie.has("fonds")) toast("Enregistré. La vérification des parutions est lancée : comptes et couvertures arrivent d'ici quelques minutes.");
      } catch (e) {
        if (e.droits) toast("Enregistré. (Pour que la vérification des parutions se lance aussi, ajoute la permission « Actions » à ta clé.)");
      }
    }
    return true;
  } catch (e) {
    etat.erreurEnregistrement = e.message;
    toast(e.message, true);
    return false;
  } finally {
    etat.publication = false;
    majEntete();
    if (etat.aRefaire || (etat.modifie.size && !etat.erreurEnregistrement)) { etat.aRefaire = false; programmerEnregistrement(1000); }
  }
}

/** Bouton « Revérifier » : publie d'abord ce qui attend, puis relance la vérification (une série, ou le passage normal). */
async function verifierMaintenant(ids = []) {
  if (!etat.token) {
    ouvrirReglages("Ajoute d'abord une clé d'accès GitHub (avec la permission « Actions ») pour lancer la vérification.");
    return;
  }
  if (etat.modifie.size && !(await lancerPublication({ verifier: false }))) return; // ce qui attend est enregistré d'abord
  try {
    const depuis = new Date(Date.now() - 5000).toISOString().replace(/\.\d+Z$/, "Z");
    await lancerVerification({ token: etat.token, depot: etat.prefs.depot, series: ids, collection: COL_ID });
    const qui = ids.length === 1 ? `« ${etat.parId.get(ids[0])?.s.titre || ids[0]} »` : "les séries à revoir";
    if (!ids.length) { toast(`Vérification lancée pour ${qui}. Elle peut durer de quelques minutes à une heure selon le nombre de séries.`); return; }
    toast(`Vérification lancée pour ${qui}. La fiche se mettra à jour toute seule d'ici 2 minutes environ.`);
    suivreVerification(ids, qui, depuis);
  } catch (e) {
    toast(e.message, true);
  }
}

/** Suit la vérification d'une série : quand elle est finie et que le site a pris le résultat, on recharge
 *  les vérifications (enrich.json) et la fiche, sans recharger la page. */
async function suivreVerification(ids, qui, depuis) {
  const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
  const lireEnrich = () => fetch(`${COL.dossier}enrich.json?t=${Date.now()}`, { cache: "no-store" }).then((r) => r.json());
  const avant = JSON.stringify(ids.map((id) => etat.enrich.series?.[id] || null));
  etat.verifEnCours = qui;
  majEntete();
  try {
    // 1. la vérification sur GitHub (au plus 10 minutes)
    let execution = null;
    for (let i = 0; i < 60; i++) {
      await attendre(10000);
      try {
        if (!execution) execution = (await executionsDepuis({ token: etat.token, depot: etat.prefs.depot, depuis }))[0] || null;
        if (execution) {
          const e = await etatExecution({ token: etat.token, depot: etat.prefs.depot, id: execution.id });
          if (e.statut === "completed") { execution.conclusion = e.conclusion; break; }
        }
      } catch { /* clé sans la permission « Actions » en lecture : on attend seulement le résultat sur le site */ if (i >= 6) break; }
    }
    if (execution?.conclusion && execution.conclusion !== "success") {
      toast(`La vérification de ${qui} a échoué sur GitHub. Réessaie dans un moment.`, true);
      return;
    }
    // 2. le site mis à jour par GitHub Pages (au plus 3 minutes)
    let enrich = null;
    for (let i = 0; i < 18; i++) {
      try {
        const e = await lireEnrich();
        if (JSON.stringify(ids.map((id) => e.series?.[id] || null)) !== avant) { enrich = e; break; }
      } catch { /* réessai */ }
      await attendre(10000);
    }
    if (!enrich) { toast(`Vérification de ${qui} terminée : rien n'a changé.`); return; }
    etat.enrich = enrich;
    calculer();
    rendre();
    if (!$("#fiche").hidden && ids.includes($("#fiche").dataset.id)) ouvrirFiche($("#fiche").dataset.id);
    toast(`Fiche mise à jour : ${qui}.`);
  } finally {
    etat.verifEnCours = null;
    majEntete();
  }
}

function abandonnerModifs() {
  if (!confirmerSimple("Abandonner les modifications qui n'ont pas pu être enregistrées ?")) return;
  lsSet(LS.brouillon, null);
  location.reload();
}

function confirmerSimple(msg) { return window.confirm(msg); }

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

function ouvrirReglages(message) {
  const d = $("#dlg-reglages");
  $("#in-bib").innerHTML = bibliotheques().map((b) => `<option ${b === etat.prefs.bib ? "selected" : ""}>${h(b)}</option>`).join("");
  $("#in-token").value = etat.token || "";
  $("#in-depot").value = etat.prefs.depot;
  $("#txt-stats").textContent = etat.stats
    ? `Les prêts de l'import du ${dateFr(etat.stats.date)} sont gardés dans ce navigateur. Ils ne sont jamais envoyés sur GitHub.`
    : "Aucune statistique de prêt dans ce navigateur. Importe un export Orphée pour les voir.";
  $("#btn-oublier-stats").hidden = !etat.stats;
  if (message) toast(message);
  d.showModal();
}

async function fermerReglages(e) {
  const d = $("#dlg-reglages");
  if (d.returnValue !== "ok") return;
  const token = $("#in-token").value.trim();
  const depot = $("#in-depot").value.trim() || PREFS_DEFAUT.depot;
  etat.prefs.depot = depot;
  const bib = $("#in-bib").value;
  if (bib && bib !== etat.prefs.bib) { etat.prefs.bib = bib; calculer(); rendre(); }
  sauverPrefs();
  if (token !== etat.token) {
    etat.token = token;
    lsSet(LS.token, token || null);
    if (token) {
      try { await verifierCle(token, depot); toast("Clé vérifiée : les modifications sont enregistrées automatiquement."); }
      catch (err) { toast(err.message, true); }
    }
  }
  if (etat.token && etat.modifie.size) { etat.erreurEnregistrement = null; programmerEnregistrement(300); }
  majEntete();
}

// ---------------------------------------------------------------------------
// En-tête, bandeau, toast
// ---------------------------------------------------------------------------

function majEntete() {
  const imp = etat.fonds.import?.date ? `Dernier import Orphée : ${dateFr(etat.fonds.import.date)}` : "Aucun import Orphée";
  const enr = etat.enrich.maj ? `Parutions vérifiées le ${dateFr(etat.enrich.maj)}` : "Parutions pas encore vérifiées";
  $("#pied").textContent = `${imp}. ${enr}.`;
  const ban = $("#bandeau");
  if (etat.erreurEnregistrement === "cle" && etat.modifie.size) {
    ban.hidden = false;
    ban.className = "bandeau bandeau-erreur";
    ban.innerHTML = `<div class="bandeau-ligne">
      <p><strong>Modifications non enregistrées :</strong> il manque la clé d'accès GitHub. Elles restent sur ce poste en attendant.</p>
      <button class="btn" data-action="abandonner">Abandonner</button>
      <button class="btn btn-fort" data-action="reglages">Ajouter la clé</button>
    </div>`;
  } else if (etat.erreurEnregistrement && etat.modifie.size) {
    ban.hidden = false;
    ban.className = "bandeau bandeau-erreur";
    ban.innerHTML = `<div class="bandeau-ligne">
      <p><strong>Enregistrement impossible :</strong> ${h(etat.erreurEnregistrement)}</p>
      <button class="btn" data-action="abandonner">Abandonner</button>
      <button class="btn btn-fort" data-action="enregistrer">Réessayer</button>
    </div>`;
  } else {
    ban.hidden = true;
    ban.className = "bandeau";
  }
  // petit témoin discret pendant l'enregistrement
  const tem = $("#temoin-enregistrement");
  if (tem) {
    const enregistre = etat.publication || (etat.modifie.size && !etat.erreurEnregistrement);
    tem.hidden = !(enregistre || etat.enregistreA || etat.verifEnCours);
    tem.textContent = enregistre ? "Enregistrement…" : etat.enregistreA ? "Modification enregistrée ✓" : `Vérification de ${etat.verifEnCours}…`;
    tem.classList.toggle("fini", !enregistre && !!etat.enregistreA);
    clearTimeout(etat.minuteurTemoin);
    if (!enregistre && etat.enregistreA) etat.minuteurTemoin = setTimeout(() => { etat.enregistreA = null; majEntete(); }, 2500);
  }
  const n = etat.vues.length ? nbControles() : 0;
  $("#nb-controles").textContent = n ? String(n) : "";
}

let minuteurToast;
function toast(msg, erreur = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("erreur", erreur);
  t.hidden = false;
  clearTimeout(minuteurToast);
  minuteurToast = setTimeout(() => { t.hidden = true; }, erreur ? 9000 : 5000);
}

// ---------------------------------------------------------------------------
// Navigation et événements
// ---------------------------------------------------------------------------

function rendre() {
  const vue = (location.hash.replace("#", "") || "series").split("/")[0];
  etat.vue = ["series", "acheter", "prets", "controles", "import"].includes(vue) ? vue : "series";
  $$(".onglets a").forEach((a) => { if (a.dataset.vue === etat.vue) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  ({ series: rendreSeries, acheter: rendreAcheter, prets: rendrePrets, controles: rendreControles, import: rendreImport })[etat.vue]();
  majEntete();
}

function brancher() {
  window.addEventListener("hashchange", () => { etat.limite = 150; fermerFiche(); rendre(); window.scrollTo(0, 0); $("#vue").focus({ preventScroll: true }); });

  const vue = $("#vue");
  let minuteur;
  vue.addEventListener("input", (e) => {
    if (e.target.id === "q") {
      clearTimeout(minuteur);
      minuteur = setTimeout(() => {
        etat.prefs.q = e.target.value; etat.limite = 150;
        const pos = e.target.selectionStart;
        rendreSeries();
        const q = $("#q"); q.focus(); q.setSelectionRange(pos, pos);
      }, 150);
    }
  });
  vue.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "f-public") { etat.prefs.public = t.value; sauverPrefs(); rendre(); }
    else if (t.id === "f-genre") { etat.prefs.genre = t.value; sauverPrefs(); rendre(); }
    else if (t.id === "f-intercalaire") { etat.prefs.intercalaire = t.value; if (t.value) etat.prefs.affichage = "liste"; sauverPrefs(); rendre(); $("#f-intercalaire")?.focus(); }
    else if (t.id === "f-tri") { etat.prefs.tri = t.value; sauverPrefs(); rendre(); }
    else if (t.id === "f-uniques") { etat.prefs.sansUniques = t.checked; sauverPrefs(); rendre(); $("#f-uniques")?.focus(); }
    else if (t.type === "radio" && (t.name === "presence" || t.name === "perimetre")) {
      etat.prefs[t.name] = t.value; etat.prefs.statut = null; sauverPrefs(); calculer(); rendre();
      $(`input[name="${t.name}"][value="${t.value}"]`)?.focus();
    }
    else if (t.id === "fichier" && t.files[0]) lireFichier(t.files[0]);
    else if (t.dataset.relier && t.value) {
      const cible = etat.series.find((s) => s.id === t.value);
      if (cible && confirmerSimple(`Relier « ${etat.parId.get(t.dataset.relier)?.s.titre} » à « ${cible.titre} » ? L'ancien titre deviendra un autre nom de la série.`)) relier(t.dataset.relier, t.value);
      else t.value = "";
    }
  });
  vue.addEventListener("click", (e) => {
    const t = e.target.closest("button, [data-serie]");
    if (!t) return;
    if ("statut" in t.dataset) { etat.prefs.statut = t.dataset.statut || null; etat.limite = 150; rendre(); return; }
    if (t.dataset.ongletAchat) { etat.ongletAchat = t.dataset.ongletAchat; rendre(); return; }
    if (t.dataset.portee) { etat.prefs.pretsPortee = t.dataset.portee; sauverPrefs(); rendre(); $(`[data-portee="${t.dataset.portee}"]`)?.focus(); return; }
    if (t.dataset.triPrets) { etat.prefs.pretsTri = t.dataset.triPrets; sauverPrefs(); rendre(); $(`[data-tri-prets="${t.dataset.triPrets}"]`)?.focus(); return; }
    if (t.dataset.affichage) { etat.prefs.affichage = t.dataset.affichage; sauverPrefs(); rendre(); return; }
    if (t.dataset.intercalaire) {
      // la série reste affichée jusqu'au prochain changement de filtre, pour pouvoir corriger un clic
      const id = t.dataset.intercalaire;
      basculerIntercalaire(id);
      const oui = !!etat.series.find((x) => x.id === id)?.intercalaire;
      t.setAttribute("aria-pressed", String(oui));
      t.textContent = oui ? "Intercalaire ✓" : "Sans intercalaire";
      return;
    }
    if (t.dataset.serie) { ouvrirFiche(t.dataset.serie); return; }
    const a = t.dataset.action;
    if (a === "plus") { etat.limite += 300; rendre(); }
    else if (a === "filtres") { etat.filtresOuverts = !etat.filtresOuverts; rendre(); $(".btn-filtres")?.focus(); }
    else if (a === "reinit") {
      Object.assign(etat.prefs, { presence: PREFS_DEFAUT.presence, perimetre: PREFS_DEFAUT.perimetre, public: "", genre: "", tri: "titre", statut: null, sansUniques: false, intercalaire: "" });
      sauverPrefs(); calculer(); rendre();
    }
    else if (a === "voir-partout") { etat.prefs.presence = COL.reseau ? "reseau" : "toutes"; etat.prefs.statut = null; sauverPrefs(); calculer(); rendre(); }
    else if (a === "csv") exporterCSV();
    else if (a === "csv-prets") exporterCSVPrets();
    else if (a === "imprimer") window.print();
    else if (a === "appliquer-import") appliquerImport();
    else if (a === "annuler-import") { etat.importPrevu = null; rendre(); }
    else if (a === "vider-commande") { const s = etat.series.find((x) => x.id === t.dataset.id); if (s) { delete s.commande; marquer("series"); calculer(); rendre(); } }
    else if (a === "vu") { const s = etat.series.find((x) => x.id === t.dataset.id); if (s) { s.vu = true; delete s.nouvelle; marquer("series"); calculer(); rendre(); } }
    else if (a === "tout-vu") {
      const c = controles();
      const l = (t.dataset.quand === "anciennes" ? c.anciennesNouvelles : t.dataset.quand === "dernier" ? c.nouvelles : [...c.nouvelles, ...c.anciennesNouvelles]).map((v) => v.s);
      if (l.length && confirmerSimple(`Marquer les ${l.length} nouvelles séries comme vérifiées ?`)) { l.forEach((x) => { x.vu = true; delete x.nouvelle; }); marquer("series"); calculer(); rendre(); }
    }
    else if (a === "supprimer") {
      const s = etat.series.find((x) => x.id === t.dataset.id);
      if (s && confirmerSimple(`Supprimer « ${s.titre} » de Suivixo ?`)) { etat.series = etat.series.filter((x) => x !== s); marquer("series"); calculer(); rendre(); toast(`« ${s.titre} » supprimée.`); }
    }
  });

  // couverture introuvable : petite image, sinon fausse couverture
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName !== "IMG" || !img.classList.contains("couv")) return;
    if (img.dataset.petite && img.getAttribute("src") !== img.dataset.petite) { img.src = img.dataset.petite; return; }
    img.outerHTML = fausseCouv(img.dataset.titre, img.dataset.editeur);
  }, true);

  // dépôt de fichier
  vue.addEventListener("dragover", (e) => { const d = e.target.closest("#depot"); if (d) { e.preventDefault(); d.classList.add("survol"); } });
  vue.addEventListener("dragleave", (e) => { const d = e.target.closest("#depot"); if (d) d.classList.remove("survol"); });
  vue.addEventListener("drop", (e) => {
    const d = e.target.closest("#depot");
    if (!d) return;
    e.preventDefault(); d.classList.remove("survol");
    if (e.dataTransfer.files[0]) lireFichier(e.dataTransfer.files[0]);
  });

  // fiche
  $("#fiche").addEventListener("click", (e) => {
    if (e.target.closest("[data-fermer]")) { fermerFiche(); return; }
    const b = e.target.closest('[data-action="reverifier"]');
    if (b) verifierMaintenant([b.dataset.id]);
    const c = e.target.closest("[data-copier]");
    if (c) copierTexte(c.dataset.copier);
    const i = e.target.closest("[data-intercalaire]");
    if (i) {
      basculerIntercalaire(i.dataset.intercalaire);
      const oui = !!etat.series.find((x) => x.id === i.dataset.intercalaire)?.intercalaire;
      i.setAttribute("aria-pressed", String(oui));
      i.textContent = oui ? "Intercalaire ✓" : "Sans intercalaire";
      const caseForm = $('#fiche input[name="intercalaire"]');
      if (caseForm) caseForm.checked = oui;
      rendre();
    }
  });
  $("#fiche").addEventListener("change", (e) => {
    const t = e.target;
    if (!t.dataset.relier || !t.value) return;
    const cible = etat.series.find((x) => x.id === t.value);
    const src = etat.series.find((x) => x.id === t.dataset.relier);
    if (cible && src && confirmerSimple(`Rattacher « ${src.titre} » à « ${cible.titre} » ? Ses exemplaires rejoindront « ${cible.titre} ».`)) {
      relier(src.id, cible.id);
      ouvrirFiche(cible.id);
    } else t.value = "";
  });
  $("#fiche").addEventListener("submit", (e) => { if (e.target.dataset.form === "serie") { e.preventDefault(); enregistrerFormulaire(e.target); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#fiche").hidden) fermerFiche(); });

  // en-tête et bandeau
  $("#btn-reglages").addEventListener("click", () => ouvrirReglages());
  $("#dlg-reglages").addEventListener("close", fermerReglages);
  $("#btn-verifier-tout").addEventListener("click", () => { $("#dlg-reglages").close(); verifierMaintenant([]); });
  $("#btn-oublier-stats").addEventListener("click", () => { lsSet(LS.stats, null); etat.stats = null; calculer(); rendre(); $("#dlg-reglages").close(); toast("Statistiques de prêt effacées de ce navigateur."); });
  $("#bandeau").addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.action;
    if (a === "enregistrer") lancerPublication();
    if (a === "reglages") ouvrirReglages();
    if (a === "abandonner") abandonnerModifs();
  });
}

/** Hauteur de l'en-tête collant, pour placer la barre de recherche juste dessous (elle change sur téléphone). */
function suivreEntete() {
  const entete = document.querySelector(".entete");
  if (!entete) return;
  const maj = () => document.documentElement.style.setProperty("--haut-entete", `${entete.getBoundingClientRect().height}px`);
  maj();
  if ("ResizeObserver" in window) new ResizeObserver(maj).observe(entete);
  // ombre sous la barre quand elle est collée sous l'en-tête
  window.addEventListener("scroll", () => {
    const barre = document.querySelector("#vue .barre");
    if (barre) barre.classList.toggle("collee", barre.getBoundingClientRect().top <= entete.getBoundingClientRect().height + 1 && window.scrollY > 0);
  }, { passive: true });
}

function brancherCollections() {
  if (COL_ID === "mangas") delete document.documentElement.dataset.collection;
  else document.documentElement.dataset.collection = COL_ID;
  const sel = $("#collection");
  sel.innerHTML = Object.entries(COLLECTIONS).map(([id, c]) => `<option value="${id}" ${id === COL_ID ? "selected" : ""}>${h(c.nom)}</option>`).join("");
  sel.addEventListener("change", () => {
    etat.prefs.collection = sel.value;
    sauverPrefs();
    // nouvelle collection : on recharge la page (données, brouillon et prêts propres à chacune)
    const u = new URL(location.href);
    u.searchParams.set("collection", sel.value);
    location.href = u.pathname + u.search + location.hash;
  });
  document.title = `Suivixo · ${COL.nom}`;
  const txtVerif = $("#txt-verification");
  if (txtVerif) txtVerif.textContent = `Elle passe ${COL.reseau ? "tout le réseau" : "toutes les séries de la collection"} en revue chaque lundi vers 4 h${COL.mangas ? " (AniList, Manga-News et BnF)" : " (BnF et couvertures)"}, et se lance aussi après un import. Tu peux la lancer tout de suite : elle traite les nouvelles séries et celles dont tu as modifié les liens.`;
}

(async function demarrer() {
  brancherCollections();
  suivreEntete();
  try {
    await charger();
  } catch (e) {
    $("#vue").innerHTML = `<p class="vide">Impossible de charger les données : ${h(e.message)}</p>`;
    return;
  }
  calculer();
  brancher();
  rendre();
  // modifications restées sur ce poste (page fermée trop tôt, pas de réseau…) : on les enregistre
  if (etat.modifie.size) programmerEnregistrement(1500);
  majEntete();
})();
