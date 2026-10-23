// Suivixo — interface
import * as C from "./core.js";
import { publier, verifierCle } from "./github.js";

// ---------------------------------------------------------------------------
// État et stockage local
// ---------------------------------------------------------------------------

const LS = { prefs: "suivixo.prefs", brouillon: "suivixo.brouillon", stats: "suivixo.stats", token: "suivixo.token", publie: "suivixo.publie" };
const lsGet = (k, def) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } };
const lsSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };

const PREFS_DEFAUT = {
  bib: "Servon-sur-Vilaine", perimetre: "reseau", presence: "moi", tri: "titre", affichage: "couvertures",
  statut: null, public: "", genre: "", q: "", depot: "mediatheque-ssv/Suivixo",
};

const etat = {
  series: [], fonds: { series: {}, bibliotheques: [], anomalies: [] }, enrich: { series: {} },
  stats: lsGet(LS.stats, null),
  modifie: new Set(),
  brouillonDate: null,
  prefs: { ...PREFS_DEFAUT, ...lsGet(LS.prefs, {}), q: "", statut: null },
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
    fonds: etat.modifie.has("fonds") ? etat.fonds : undefined,
  });
}

function marquer(quoi) {
  etat.modifie.add(quoi);
  sauverBrouillon();
  majEntete();
}

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------

async function charger() {
  const get = (f) => fetch(`data/${f}?t=${Date.now()}`, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`Fichier data/${f} introuvable (${r.status}).`);
    return r.json();
  });
  const [series, fonds, enrich] = await Promise.all([
    get("series.json"), get("fonds.json"), get("enrich.json").catch(() => ({ series: {} })),
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
  const b = lsGet(LS.brouillon, null);
  if (b && b.modifie?.length) {
    if (b.series) etat.series = b.series;
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
    const info = C.infosParution(s, enr, Date.now(), reseau.length ? reseau[reseau.length - 1] : 0);
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
      genre: s.genre || (f?.webtoon ? "Webtoon" : "") || al?.demographie || "",
      genreAuto: !s.genre && !!al?.demographie,
      presence: C.presence(f, bib),
      prets: st ? somme(st.prets) : null,
      pretsIci: st ? st.prets?.[bib] || 0 : null,
      reserves: st ? somme(st.reserves) : 0,
      cle: C.cleTri(s.titre),
      texte: C.sansAccents([s.titre, ...(s.alias || []), f?.editeur, f?.titreOrphee].join(" ")).toLowerCase(),
    };
  });
  etat.parId = new Map(etat.vues.map((v) => [v.s.id, v]));
}

const ORDRE_STATUT = ["completer", "continuer", "attente", "finie", "abandonnee", "verifier"];

function filtrer({ ignorerStatut = false } = {}) {
  const p = etat.prefs;
  const q = C.sansAccents(p.q).toLowerCase().trim();
  return etat.vues.filter((v) => {
    if (p.presence === "moi" && !(v.presence === "ici" || v.presence === "partagee")) return false;
    if (p.presence === "reseau" && v.presence === "aucune") return false;
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

const TEINTES = ["#3E5C76", "#7A4E6B", "#4F6F52", "#8A5A3B", "#575D93", "#2C6E8A", "#9A4A4A", "#6A6845", "#4B4E6D", "#7C5C2E"];
function teinte(t) {
  let x = 0;
  for (const c of String(t)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return TEINTES[x % TEINTES.length];
}

function fausseCouv(titre, editeur) {
  return `<span class="couv couv-faux" style="background:${teinte(titre)}"><b>${h(titre)}</b><small>${h(editeur || "")}</small></span>`;
}

function urlsCouv(v) {
  // couverture française (BnF ou Open Library), réduite et rangée dans le dépôt
  const fr = v.enr?.couvFR;
  if (fr) { const u = `couvertures/${encodeURIComponent(v.s.id)}.jpg?v=${fr.maj || ""}`; return { petite: u, grande: u, fr: true }; }
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
function compteVF(v) {
  const ici = v.ici.length;
  const p = v.info.parus;
  const vo = v.info.totalVO;
  const al = v.enr?.anilist && !v.enr.anilist.rejete && !v.enr.anilist.auteurDifferent ? v.enr.anilist : null;
  // Aucune source n'a encore donné le nombre de tomes parus (série toute nouvelle) : on ne l'invente pas
  const nonVerifie = !v.enr || (v.info.sourceParus === "reseau" && !v.info.sourceEnRetard);
  let t = p === null || nonVerifie ? `<strong>${nf.format(ici)}</strong> ${ici > 1 ? "tomes" : "tome"}, parution VF ${v.enr ? "inconnue" : "pas encore vérifiée"}`
    : `<strong>${nf.format(ici)}</strong> sur ${nf.format(p)} parus en VF`;
  if (vo && (p === null || vo > p)) t += `, ${nf.format(vo)} ${enVO(al)}`;
  else if (al && (al.statut === "RELEASING" || al.statut === "HIATUS")) t += `, en cours ${enVO(al)}`;
  return t;
}

function legende() {
  const t = (cls, fill = "") => `<svg viewBox="0 0 7 14" aria-hidden="true"><rect x="0.5" y="0.5" width="6" height="13" rx="1" class="${cls}" ${fill}/></svg>`;
  const double = `<svg viewBox="0 0 7 14" aria-hidden="true"><rect x="0.5" y="0.5" width="6" height="13" rx="1" class="t-ici"/><rect x="0.5" y="0.5" width="6" height="5" rx="1" fill="url(#trame)" class="t-coiffe"/></svg>`;
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
  return [p.presence !== "moi", p.perimetre !== "reseau", !!p.public, !!p.genre, p.tri !== "titre"].filter(Boolean).length;
}

function rendreSeries() {
  const p = etat.prefs;
  const base = filtrer({ ignorerStatut: true });
  const comptes = {};
  base.forEach((v) => { comptes[v.statut.cle] = (comptes[v.statut.cle] || 0) + 1; });
  const liste = trier(filtrer());
  const publics = [...new Set(etat.series.map((s) => s.public).filter(Boolean))].sort();
  const genres = [...new Set(etat.vues.map((v) => v.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
  const bib = court(p.bib);
  const avecPrets = !!etat.stats;
  const n = nbFiltres();
  const radio = (nom, val, lib) => `<label class="choix"><input type="radio" name="${nom}" value="${val}" ${p[nom] === val ? "checked" : ""}>${lib}</label>`;
  const options = (l, val) => `<option value="">Tous</option>` + l.map((x) => `<option ${val === x ? "selected" : ""}>${h(x)}</option>`).join("");
  const tris = [["titre", "Titre"], ["manquants", "Nombre de tomes manquants"], ["statut", "Où ça en est"], ...(avecPrets ? [["prets", "Prêts"]] : [])];

  const titre = p.presence === "moi" ? `Les mangas de ${h(bib)}` : p.presence === "reseau" ? "Les mangas du réseau" : "Toutes les séries";
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
        ${radio("presence", "moi", `Présentes à ${h(bib)}`)}${radio("presence", "reseau", "Tout le réseau")}${radio("presence", "toutes", "Toutes, même sans exemplaire")}
      </fieldset>
      <fieldset><legend>Une série est complète si elle l'est</legend>
        ${radio("perimetre", "reseau", "dans le réseau")}${radio("perimetre", "moi", `à ${h(bib)}`)}
      </fieldset>
      <div style="display:grid;gap:12px;align-content:start">
        <label class="champ"><span>Public</span><select id="f-public">${options(publics, p.public)}</select></label>
        <label class="champ"><span>Genre</span><select id="f-genre">${options(genres, p.genre)}</select></label>
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
    ${!liste.length ? `<p class="vide">Aucune série ne correspond. Essaie d'élargir les filtres.</p>`
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
    <span class="compte-vf" title="Tomes à ${h(court(etat.prefs.bib))}, tomes parus en France, total de la série en VO">${compteVF(v)}</span>
    ${etagere(v, 160, 16, 1.4)}
    ${statut(v.statut.cle)}
  </button>`;
}

function ligneSerie(v) {
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
const enVO = (al) => PAYS[al?.pays] || "en version originale";
const ETATS_AL = { FINISHED: "terminée", RELEASING: "en cours", HIATUS: "en pause", CANCELLED: "annulée", NOT_YET_RELEASED: "pas encore commencée" };

function phraseStatut(v) {
  const { info } = v;
  const bib = court(etat.prefs.bib);
  const al = v.enr?.anilist;
  const morceaux = [];
  if (al && !al.rejete && !al.auteurDifferent && al.statut) {
    const ou = enVO(al);
    morceaux.push(`${ou.charAt(0).toUpperCase() + ou.slice(1)}, la série est ${ETATS_AL[al.statut] || al.statut}${info.totalVO ? ` (${pluriel(info.totalVO, "tome")})` : al.pays === "KR" || al.pays === "CN" ? " (publication en ligne)" : ""}.`);
  }
  if (info.parus !== null) {
    const date = info.sourceParus === "bnf" && info.dateDernier ? `, le dernier en ${moisFr(info.dateDernier)}` : "";
    const venir = info.aVenir && /en cours/i.test(info.etat || "") && !info.doute ? `, ${info.aVenir} encore à venir` : "";
    morceaux.push(`${pluriel(info.parus, "tome paru", "tomes parus")} en France${date}${venir}.`);
    if (info.sourceParus === "reseau") morceaux.push(`Ce nombre vient des exemplaires du réseau${info.sourceEnRetard === "bnf" ? " : la BnF ne recense pas encore les derniers tomes" : ""}.`);
  } else morceaux.push("Le nombre de tomes parus en France est inconnu.");
  if (/arr[eê]t/i.test(info.etat || "")) morceaux.push(`Plus rien n'est paru en France depuis ${moisFr(info.dateDernier) || "longtemps"} : la série a peut-être été arrêtée par l'éditeur, ou l'édition française est différente. Si tu sais ce qu'il en est, indique-le dans « Modifier la série ».`);
  if (info.parus !== null) {
    const dispoAilleurs = v.manquantsIci.filter((i) => !v.manquantsReseau.includes(i));
    if (!v.ici.length) morceaux.push(`${bib} n'a aucun tome.`);
    else if (!v.manquantsIci.length) morceaux.push(`${bib} a tous les tomes parus.`);
    else morceaux.push(`Il manque à ${bib} : ${C.listeCompacte(v.manquantsIci)}${dispoAilleurs.length && v.manquantsReseau.length ? `, dont ${C.listeCompacte(dispoAilleurs)} disponibles ailleurs dans le réseau` : dispoAilleurs.length ? ", tous disponibles ailleurs dans le réseau" : ""}.`);
    if (v.manquantsReseau.length) morceaux.push(`Absents de tout le réseau : ${C.listeCompacte(v.manquantsReseau)}.`);
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
  const urlMN = L.mangaNews ? (L.mangaNews.startsWith("http") ? L.mangaNews : "https://www.manga-news.com/" + L.mangaNews) : null;
  const urlBD = L.bedetheque ? (L.bedetheque.startsWith("http") ? L.bedetheque : "https://www.bedetheque.com/" + L.bedetheque) : null;
  const urlBnf = `https://catalogue.bnf.fr/rechercher.do?motRecherche=${encodeURIComponent(s.titre)}`;
  const meta = [f?.editeur, s.public, v.genre, s.age, s.type === "One shot" ? "One shot" : ""].filter(Boolean).join(", ");
  const src = { manuel: "ta saisie", bnf: "la BnF", mangaNews: "Manga-News", excel: "l'ancien Excel", type: "le type one shot", reseau: "les exemplaires du réseau" };
  const lien = (url, texte) => `<a href="${h(url)}" target="_blank" rel="noopener">${texte}</a>`;

  const notes = [];
  for (const r of f?.retires || []) notes.push(`Tome ${r.tome ?? "?"} retiré à ${court(r.bib)} (${r.statut.toLowerCase()})`);
  if (s.commande) notes.push(`En commande : ${s.commande}`);
  if (s.commentaire) notes.push(s.commentaire);
  if (st) notes.push(`${pluriel(st.prets?.[bib] || 0, "prêt")} à ${court(bib)}, ${pluriel(somme(st.prets), "prêt")} dans le réseau${somme(st.reserves) ? `, ${pluriel(somme(st.reserves), "réservation")}` : ""}`);

  const liens = [urlMN && lien(urlMN, "Manga-News"), urlBD && lien(urlBD, "Bédéthèque"), lien(urlBnf, "le catalogue BnF"), al && lien(`https://anilist.co/manga/${al.id}`, "AniList")].filter(Boolean);

  const u = urlsCouv(v);
  $("#fiche-contenu").innerHTML = `
    <div class="fiche-tete">
      <div class="fiche-fond-couv" style="${u ? `background-image:url('${h(u.grande)}')` : `background:${teinte(s.titre)}`}"></div>
      <div class="grande">${couverture(v, true)}</div>
      <div>
        <h1 id="fiche-titre">${h(s.titre)}</h1>
        ${meta ? `<p class="sous-titre">${h(meta)}</p>` : ""}
        ${statut(v.statut.cle)}
      </div>
    </div>
    <div class="fiche-corps">
    <div class="chiffres-serie">
      <div><strong>${nf.format(v.ici.length)}</strong><span>à ${h(court(bib))}</span></div>
      <div><strong>${info.parus !== null && v.enr && !(info.sourceParus === "reseau" && !info.sourceEnRetard) ? nf.format(info.parus) : "?"}</strong><span>${v.enr ? "parus en VF" : "parus en VF, pas encore vérifié"}</span></div>
      ${info.totalVO ? `<div><strong>${nf.format(info.totalVO)}</strong><span>${h(enVO(v.enr?.anilist))}</span></div>` : v.enr?.anilist?.statut === "RELEASING" && !v.enr.anilist.auteurDifferent ? `<div><strong>…</strong><span>en cours ${h(enVO(v.enr.anilist))}</span></div>` : ""}
    </div>
    <p class="resume">${h(phraseStatut(v))}</p>
    ${total ? `<div class="rayon-complet">${tranches.join("")}</div>${legende()}` : ""}

    <h2>Dans le réseau</h2>
    ${bibs}
    ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${h(n)}</li>`).join("")}</ul>` : ""}

    <details class="repli">
      <summary>Sources et liens</summary>
      <div class="sources">
        <p><strong>VO</strong> : ${al ? `${h(enVO(al))}, série ${h(ETATS_AL[al.statut] || "?")}${al.volumes ? ` en ${pluriel(al.volumes, "tome")}` : ""}, d'après AniList (« ${h(al.titre)} »)${al.auto ? ", reliée automatiquement" : ""}.` : "série pas encore reliée à AniList. Colle son adresse dans « Modifier la série »."}</p>
        <p><strong>France</strong> : ${info.parus !== null ? `${pluriel(info.parus, "tome paru", "tomes parus")}, d'après ${src[info.sourceParus] || info.sourceParus}` : "nombre de tomes parus inconnu"}.${bnf?.dernier ? ` À la BnF : tome ${C.dernierBnf(bnf)}${bnf.editeur ? ` chez ${h(bnf.editeur)}` : ""}${bnf.dateDernier ? `, déposé en ${moisFr(bnf.dateDernier)}` : ""}.${bnf.plusieursEditions ? " Plusieurs éditions existent, seule celle qui suit la VO est comptée." : ""}` : ""}${v.enr?.mangaNews ? ` Sur Manga-News : ${pluriel(v.enr.mangaNews.tomes, "tome")}${v.enr.mangaNews.editeur ? ` chez ${h(v.enr.mangaNews.editeur)}` : ""} (données du ${dateFr(v.enr.mangaNews.date)}).` : ""}</p>
        ${s.ancien && (s.ancien.total || s.ancien.etat) ? `<p><strong>Ancien Excel</strong> : ${s.ancien.total ? pluriel(s.ancien.total, "tome") : ""}${s.ancien.etat ? `, ${h(s.ancien.etat.toLowerCase())}` : ""}${s.ancien.annee ? `, dernière parution en ${s.ancien.annee}` : ""}.</p>` : ""}
        <p><strong>Couverture</strong> : ${v.enr?.couvFR ? `édition française, tome ${v.enr.couvFR.tome}, d'après ${v.enr.couvFR.source === "BnF" ? "la BnF" : "Open Library"}.` : urlsCouv(v) ? "édition japonaise, d'après AniList (pas de couverture française trouvée)." : "aucune trouvée."}</p>
        <p>Voir sur ${liens.join(", ")}.</p>
      </div>
    </details>
    <details class="repli" id="modifier"><summary>Modifier la série</summary>${formulaire(s)}</details>
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
  const genres = ["", "Shonen", "Seinen", "Shojo", "Josei", "Kodomo", "Manhwa", "Manhua", "Global-Manga", "Comics", "Autre Manga", "Autre"];
  if (s.genre && !genres.includes(s.genre)) genres.push(s.genre);
  const m = s.manuel || {};
  const L = s.liens || {};
  return `<form class="formulaire" data-form="serie" data-id="${h(s.id)}">
    <label class="champ large"><span>Titre</span><input name="titre" value="${h(s.titre)}" required></label>
    <label class="champ"><span>Genre</span><select name="genre">${opt(genres, s.genre)}</select></label>
    <label class="champ"><span>Public</span><select name="public">${opt(["", "Jeunesse", "Ado", "Adulte"], s.public)}</select></label>
    <label class="champ"><span>Âge conseillé</span><input name="age" value="${h(s.age)}" placeholder="12+"></label>
    <label class="champ"><span>Type</span><select name="type">${opt(["Série", "One shot"], s.type || "Série")}</select></label>
    <label class="champ"><span>Tomes en commande</span><input name="commande" value="${h(s.commande)}" placeholder="12, 13"></label>
    <label class="champ"><span>Tomes parus en France (si les sources se trompent)</span><input name="parus" type="number" min="0" value="${Number.isFinite(m.parus) ? m.parus : ""}" placeholder="automatique"></label>
    <label class="champ"><span>État en France (si les sources se trompent)</span><select name="etat">${opt(["", "En cours", "Terminée", "En pause", "Abandonnée"], m.etat)}</select></label>
    <label class="champ"><span>Série AniList (adresse ou numéro)</span><input name="anilist" value="${h(L.anilist ?? "")}" placeholder="automatique"></label>
    <label class="champ large"><span>Page Manga-News</span><input name="mangaNews" value="${h(L.mangaNews)}" placeholder="https://www.manga-news.com/index.php/serie/…"></label>
    <label class="champ large"><span>Page Bédéthèque</span><input name="bedetheque" value="${h(L.bedetheque)}" placeholder="https://www.bedetheque.com/serie-…html"></label>
    <label class="champ large"><span>Autres titres (un par ligne, pour retrouver la série dans Orphée)</span><textarea name="alias">${h((s.alias || []).join("\n"))}</textarea></label>
    <label class="champ large"><span>Commentaire</span><textarea name="commentaire">${h(s.commentaire)}</textarea></label>
    <div class="actions large">
      <button class="btn btn-fort" type="submit">Enregistrer</button>
      <span class="discret">Les modifications restent sur ce poste jusqu'à ce que tu publies.</span>
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
  toast("Série enregistrée sur ce poste. Publie pour la partager.");
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
  const absentsReseau = mes.filter((v) => v.manquantsReseau.length).sort(triPriorite);
  const absentsIci = mes.map((v) => ({ v, t: v.manquantsIci.filter((i) => !v.manquantsReseau.includes(i)) }))
    .filter((x) => x.t.length).sort((a, b) => triPriorite(a.v, b.v));
  const aRemplacer = [];
  for (const v of mes) {
    const r = (v.f?.retires || []).filter((x) => x.bib === bib && !(x.tome && v.ici.includes(x.tome)));
    if (r.length) aRemplacer.push({ v, r });
  }
  const avenir = mes.filter((v) => v.info.aVenir > 0).sort((a, b) => b.info.aVenir - a.info.aVenir || a.cle.localeCompare(b.cle, "fr"));
  return { absentsReseau, absentsIci, aRemplacer, avenir };
}

function rendreAcheter() {
  const bib = court(etat.prefs.bib);
  const { absentsReseau, absentsIci, aRemplacer, avenir } = listeAchats();
  const nb = (l, f) => l.reduce((a, x) => a + f(x), 0);
  const onglets = [
    { cle: "reseau", titre: "Absents du réseau", n: nb(absentsReseau, (v) => v.manquantsReseau.length),
      texte: "Tomes parus en France qu'aucune médiathèque du réseau n'a.",
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
    { cle: "avenir", titre: "À paraître", n: nb(avenir, (v) => v.info.aVenir),
      texte: "Tomes déjà sortis au Japon mais pas encore en France.",
      items: avenir.map((v) => itemAchat(v, `${v.info.aVenir} à venir`, v.info.etat)),
      vide: "Rien pour l'instant." },
  ];
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
  const csv = "﻿" + lignes.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `suivixo-a-acheter-${court(bib).toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
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
  const nouvelles = etat.vues.filter((v) => v.s.ajout || v.s.nouvelle);
  const auDela = etat.vues.filter((v) => v.info.parus !== null && v.info.sourceParus === "manuel" && v.reseau.length && v.reseau[v.reseau.length - 1] > v.info.parus);
  const anomalies = (etat.fonds.anomalies || []);
  const aRelier = mes.filter((v) => !v.s.liens?.anilist && (!v.enr?.anilist || v.enr.anilist.auteurDifferent || v.enr.anilist.auto && (v.enr.anilist.score ?? 1) < 0.9) && v.s.genre !== "Comics" && v.s.type !== "One shot");
  const incomplet = mes.filter((v) => !v.genre || !v.s.public);
  return { commandesRecues, sansExemplaire, nouvelles, auDela, anomalies, aRelier, incomplet, bib };
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
    bloc("Nouvelles séries", c.nouvelles.map((v) => li(v.s.id, v.s.titre, `Ajoutée par l'import${v.s.ajout ? ` du ${dateFr(v.s.ajout)}` : ""}`,
      `<button class="btn" data-action="vu" data-id="${h(v.s.id)}">C'est bon</button>`)),
      "Trouvées dans Orphée lors d'un import. Vérifie le titre et complète le genre. Si c'est une série déjà connue sous un autre nom, relie-la depuis « Sans exemplaire au dernier import ».", true),
    bloc("Exemplaires sans numéro de tome", c.anomalies.map((a) => li(a.serie, a.titre, `${court(a.bib)}, cote ${a.cote || "?"}`)),
      "Ils ne sont pas comptés, car le champ tome est vide dans Orphée.", true),
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
    bloc(`Séries de ${h(bib)} sans genre ou sans public`, c.incomplet.map((v) => li(v.s.id, v.s.titre, `${[!v.genre && "genre", !v.s.public && "public"].filter(Boolean).join(" et ")} à compléter`)),
      "Utile pour les filtres de la liste des séries."),
  ].join("");

  $("#vue").innerHTML = `
    <h1>Contrôles</h1>
    <p class="chapo">Ce qui mérite un coup d'œil après un import.</p>
    ${blocs || `<p class="vide">Rien à vérifier.</p>`}
  `;
}

function nbControles() {
  const c = controles();
  return c.commandesRecues.length + c.nouvelles.length + c.anomalies.length;
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
      <p class="chapo">Fais l'édition des mangas du réseau dans Orphée, enregistre le fichier, puis dépose-le ici. Il est lu sur ce poste et n'est envoyé nulle part.</p>
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
    ${ip.annonce && ip.nbExemplaires && ip.annonce !== ip.nbExemplaires ? `<p class="explication"><strong>Attention :</strong> Orphée annonce ${pluriel(ip.annonce, "document")}, mais Suivixo n'en a reconnu que ${nf.format(ip.nbExemplaires)}. Les autres ont une forme inattendue.</p>` : ""}
    ${ip.nbExemplaires === 0 ? `<p class="explication">Aucun exemplaire reconnu. Vérifie que c'est bien l'édition des mangas d'Orphée : une ligne par tome, suivie d'une ligne par exemplaire.</p>` : ""}
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
      nom: fichier.name, date: dateDefaut, res, nbExemplaires: exemplaires.length, annonce,
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
  for (const s of ip.res.nouvelles) {
    delete s.nouvelle;
    s.ajout = date;
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
  toast("Import appliqué sur ce poste. Publie pour le partager avec l'équipe.");
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

async function lancerPublication() {
  if (!etat.token) {
    ouvrirReglages("Ajoute d'abord une clé d'accès GitHub pour publier.");
    return;
  }
  const fichiers = [];
  const quand = new Date().toISOString();
  const instantane = { date: quand };
  if (etat.modifie.has("series")) {
    const series = [...etat.series].sort((a, b) => a.titre.localeCompare(b.titre, "fr", { sensitivity: "base" }));
    fichiers.push({ chemin: "data/series.json", contenu: JSON.stringify({ version: 1, publie: quand, series }, null, 1) + "\n" });
    instantane.series = series;
  }
  if (etat.modifie.has("fonds")) {
    etat.fonds.publie = quand;
    fichiers.push({ chemin: "data/fonds.json", contenu: JSON.stringify(etat.fonds, null, 1) + "\n" });
    instantane.fonds = etat.fonds;
  }
  if (!fichiers.length) return;
  const quoi = [etat.modifie.has("fonds") && `import Orphée du ${dateFr(etat.fonds.import?.date)}`, etat.modifie.has("series") && "fiches séries"].filter(Boolean).join(" et ");
  etat.publication = true;
  majEntete();
  try {
    await publier({ token: etat.token, depot: etat.prefs.depot, fichiers, message: `Mise à jour depuis Suivixo : ${quoi}` });
    lsSet(LS.publie, instantane);
    etat.modifie.clear();
    etat.brouillonDate = null;
    sauverBrouillon();
    toast("Publié. Le site sera à jour pour toute l'équipe d'ici une minute ou deux.");
  } catch (e) {
    toast(e.message, true);
  } finally {
    etat.publication = false;
    majEntete();
  }
}

function abandonnerModifs() {
  if (!confirmerSimple("Abandonner les modifications non publiées ?")) return;
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
    ? `Les prêts de l'import du ${dateFr(etat.stats.date)} sont enregistrés dans ce navigateur. Ils ne sont pas publiés.`
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
      try { await verifierCle(token, depot); toast("Clé vérifiée : tu peux publier."); }
      catch (err) { toast(err.message, true); }
    }
  }
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
  if (etat.modifie.size) {
    const off = etat.publication ? "disabled" : "";
    ban.hidden = false;
    ban.innerHTML = `<div class="bandeau-ligne">
      <p>${etat.publication ? "Publication en cours…" : "Modifications pas encore publiées : le reste de l'équipe ne les voit pas."}</p>
      <button class="btn" data-action="abandonner" ${off}>Abandonner</button>
      <button class="btn btn-fort" data-action="publier" ${off}>Publier</button>
    </div>`;
  } else ban.hidden = true;
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
  etat.vue = ["series", "acheter", "controles", "import"].includes(vue) ? vue : "series";
  $$(".onglets a").forEach((a) => { if (a.dataset.vue === etat.vue) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  ({ series: rendreSeries, acheter: rendreAcheter, controles: rendreControles, import: rendreImport })[etat.vue]();
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
    else if (t.id === "f-tri") { etat.prefs.tri = t.value; sauverPrefs(); rendre(); }
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
    if (t.dataset.affichage) { etat.prefs.affichage = t.dataset.affichage; sauverPrefs(); rendre(); return; }
    if (t.dataset.serie) { ouvrirFiche(t.dataset.serie); return; }
    const a = t.dataset.action;
    if (a === "plus") { etat.limite += 300; rendre(); }
    else if (a === "filtres") { etat.filtresOuverts = !etat.filtresOuverts; rendre(); $(".btn-filtres")?.focus(); }
    else if (a === "reinit") {
      Object.assign(etat.prefs, { presence: PREFS_DEFAUT.presence, perimetre: PREFS_DEFAUT.perimetre, public: "", genre: "", tri: "titre", statut: null });
      sauverPrefs(); calculer(); rendre();
    }
    else if (a === "csv") exporterCSV();
    else if (a === "imprimer") window.print();
    else if (a === "appliquer-import") appliquerImport();
    else if (a === "annuler-import") { etat.importPrevu = null; rendre(); }
    else if (a === "vider-commande") { const s = etat.series.find((x) => x.id === t.dataset.id); if (s) { delete s.commande; marquer("series"); calculer(); rendre(); } }
    else if (a === "vu") { const s = etat.series.find((x) => x.id === t.dataset.id); if (s) { delete s.ajout; delete s.nouvelle; marquer("series"); calculer(); rendre(); } }
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
  $("#fiche").addEventListener("click", (e) => { if (e.target.closest("[data-fermer]")) fermerFiche(); });
  $("#fiche").addEventListener("submit", (e) => { if (e.target.dataset.form === "serie") { e.preventDefault(); enregistrerFormulaire(e.target); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#fiche").hidden) fermerFiche(); });

  // en-tête et bandeau
  $("#btn-reglages").addEventListener("click", () => ouvrirReglages());
  $("#dlg-reglages").addEventListener("close", fermerReglages);
  $("#btn-oublier-stats").addEventListener("click", () => { lsSet(LS.stats, null); etat.stats = null; calculer(); rendre(); $("#dlg-reglages").close(); toast("Statistiques de prêt effacées de ce navigateur."); });
  $("#bandeau").addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.action;
    if (a === "publier") lancerPublication();
    if (a === "abandonner") abandonnerModifs();
  });
}

(async function demarrer() {
  try {
    await charger();
  } catch (e) {
    $("#vue").innerHTML = `<p class="vide">Impossible de charger les données : ${h(e.message)}</p>`;
    return;
  }
  calculer();
  brancher();
  rendre();
})();
