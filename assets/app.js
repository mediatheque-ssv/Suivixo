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
  bib: "Servon-sur-Vilaine", perimetre: "reseau", presence: "moi", tri: "titre",
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
    const info = C.infosParution(s, enr);
    const ici = f?.tomes?.[bib] || [];
    const reseau = C.tomesReseau(f);
    const statut = C.statutSerie(surMoi ? ici : reseau, info);
    const setIci = new Set(ici), setRes = new Set(reseau);
    const manquantsIci = [], manquantsReseau = [];
    if (info.parus !== null) for (let i = 1; i <= info.parus; i++) {
      if (!setIci.has(i)) manquantsIci.push(i);
      if (!setRes.has(i)) manquantsReseau.push(i);
    }
    const st = etat.stats?.series?.[s.id];
    const al = enr?.anilist && !enr.anilist.rejete ? enr.anilist : null;
    return {
      s, f, enr, info, ici, reseau, statut, manquantsIci, manquantsReseau,
      genre: s.genre || al?.demographie || "",
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

function badge(cle) {
  return `<span class="badge s-${cle}">${C.STATUTS[cle]}</span>`;
}

function classeTome(v, i) {
  const setIci = new Set(v.ici), setRes = new Set(v.reseau);
  const parus = v.info.parus;
  if (setIci.has(i)) return ["ici", `Tome ${i} : à ${court(etat.prefs.bib)}`];
  if (setRes.has(i)) return ["reseau", `Tome ${i} : ailleurs dans le réseau`];
  if (parus !== null && i <= parus) return ["manque", `Tome ${i} : absent du réseau`];
  if (parus !== null && i > parus) return ["avenir", `Tome ${i} : pas encore paru en France`];
  return ["inconnu", `Tome ${i}`];
}

function bornes(v) {
  const maxPossede = v.reseau.length ? v.reseau[v.reseau.length - 1] : 0;
  const n = Math.max(v.info.parus || 0, maxPossede);
  const vo = v.info.totalVO || 0;
  const avenir = vo > n ? Math.min(vo - n, 60) : 0;
  return { n, total: n + avenir };
}

/** Rangée de tranches en SVG (liste). */
function etagere(v, largeur = 300) {
  const { total } = bornes(v);
  if (!total) return `<span class="discret">${v.f ? "Pas de tome numéroté" : "Aucun exemplaire au dernier import"}</span>`;
  const pas = Math.max(2.5, Math.min(10, largeur / total));
  const w = pas >= 6 ? pas - 2 : pas >= 4 ? pas - 1.2 : pas - 0.8;
  let rects = "";
  for (let i = 1; i <= total; i++) {
    const [c, titre] = classeTome(v, i);
    const x = ((i - 1) * pas).toFixed(2);
    const fill = c === "reseau" ? ' fill="url(#trame)"' : "";
    const cls = { ici: "t-ici", reseau: "t-reseau", manque: "t-manque", avenir: "t-avenir", inconnu: "t-avenir" }[c];
    rects += `<rect x="${x}" y="1" width="${w.toFixed(2)}" height="20" rx="${w > 4 ? 1 : 0.5}" class="${cls}"${fill}><title>${h(titre)}</title></rect>`;
  }
  const larg = (total * pas).toFixed(1);
  return `<svg class="etagere" width="${larg}" height="22" viewBox="0 0 ${larg} 22" role="img" aria-label="${h(resumeTomes(v))}">${rects}</svg>`;
}

function resumeTomes(v) {
  const bib = court(etat.prefs.bib);
  const ici = v.ici.length ? C.listeCompacte(v.ici) : "aucun";
  const res = v.reseau.length ? C.listeCompacte(v.reseau) : "aucun";
  return `${bib} : ${ici}. Réseau : ${res}.`;
}

function texteParution(info) {
  if (info.parus === null) return `<span class="discret">Parution inconnue</span>`;
  const l1 = `${pluriel(info.parus, "tome paru", "tomes parus")}`;
  let l2 = info.etat || "";
  const arretee = /arr[eê]t/i.test(l2);
  if (info.aVenir && !arretee) l2 += `${l2 ? ", " : ""}${info.aVenir} à venir`;
  if (info.doute && !arretee) l2 += " ?";
  return `${l1}<small>${h(l2)}</small>`;
}

function legende() {
  const t = (cls, fill = "") => `<svg viewBox="0 0 8 16" aria-hidden="true"><rect x="0.5" y="0.5" width="7" height="15" rx="1" class="${cls}" ${fill}/></svg>`;
  return `<p class="legende">
    <span>${t("t-ici")} À ${h(court(etat.prefs.bib))}</span>
    <span>${t("t-reseau", 'fill="url(#trame)"')} Ailleurs dans le réseau</span>
    <span>${t("t-manque")} Paru, absent du réseau</span>
    <span>${t("t-avenir")} Pas encore paru en France</span>
  </p>`;
}

// ---------------------------------------------------------------------------
// Vue : séries
// ---------------------------------------------------------------------------

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
  const seg = (nom, val, lib) => `<button type="button" data-pref="${nom}" data-val="${val}" aria-pressed="${p[nom] === val}">${lib}</button>`;
  const entete = (cle, lib) => `<button type="button" data-tri="${cle}" ${p.tri === cle ? 'aria-sort="ascending"' : ""}>${lib}</button>`;

  $("#vue").innerHTML = `
    <div class="filtres">
      <input class="recherche" type="search" id="q" placeholder="Chercher une série, un éditeur…" value="${h(p.q)}" aria-label="Chercher une série">
      <div class="groupe-filtre"><span>Séries</span>
        <div class="segment" role="group" aria-label="Séries affichées">
          ${seg("presence", "moi", `à ${h(bib)}`)}${seg("presence", "reseau", "du réseau")}${seg("presence", "toutes", "toutes")}
        </div>
      </div>
      <div class="groupe-filtre"><span>Complète sur</span>
        <div class="segment" role="group" aria-label="Calcul du statut">
          ${seg("perimetre", "moi", h(bib))}${seg("perimetre", "reseau", "le réseau")}
        </div>
      </div>
      <select id="f-public" aria-label="Public"><option value="">Tous publics</option>${publics.map((x) => `<option ${p.public === x ? "selected" : ""}>${h(x)}</option>`).join("")}</select>
      <select id="f-genre" aria-label="Genre"><option value="">Tous genres</option>${genres.map((x) => `<option ${p.genre === x ? "selected" : ""}>${h(x)}</option>`).join("")}</select>
    </div>
    <div class="statuts" role="group" aria-label="Filtrer par statut">
      ${ORDRE_STATUT.filter((k) => comptes[k]).map((k) => `
        <button type="button" class="statut-filtre" data-statut="${k}" aria-pressed="${p.statut === k}">
          <span class="point s-${k}"></span>${C.STATUTS[k]} <strong>${nf.format(comptes[k])}</strong>
        </button>`).join("")}
    </div>
    ${legende()}
    <div class="liste" role="table" aria-label="Séries">
      <div class="liste-entete" role="row">
        <span role="columnheader">${entete("titre", "Série")}</span>
        <span role="columnheader">${entete("manquants", "Tomes")}</span>
        <span role="columnheader">${entete("parution", "Parution en France")}</span>
        <span role="columnheader">${entete("statut", "Où ça en est")}</span>
        <span role="columnheader">${avecPrets ? entete("prets", "Prêts") : ""}</span>
      </div>
      ${liste.slice(0, etat.limite).map(ligneSerie).join("") || `<p class="vide">Aucune série ne correspond. Essaie d'élargir les filtres.</p>`}
    </div>
    ${liste.length > etat.limite ? `<button class="btn plus" data-action="plus">Afficher les ${nf.format(liste.length - etat.limite)} autres séries</button>` : ""}
  `;
}

function ligneSerie(v) {
  const meta = [v.f?.editeur, v.s.public, v.genre].filter(Boolean).join(", ");
  const prets = v.prets === null ? "" : `${nf.format(v.pretsIci)}<small>${nf.format(v.prets)} réseau</small>`;
  return `<button type="button" class="ligne" role="row" data-serie="${h(v.s.id)}">
    <span role="cell"><span class="ligne-titre">${h(v.s.titre)}</span>${meta ? `<span class="ligne-meta">${h(meta)}</span>` : ""}</span>
    <span role="cell" class="ligne-tomes">${etagere(v)}<span class="resume">${h(resumeTomes(v))}</span></span>
    <span role="cell" class="ligne-parution">${texteParution(v.info)}</span>
    <span role="cell">${badge(v.statut.cle)}</span>
    <span role="cell" class="ligne-prets">${prets}</span>
  </button>`;
}

// ---------------------------------------------------------------------------
// Fiche série
// ---------------------------------------------------------------------------

const ETATS_AL = { FINISHED: "terminée", RELEASING: "en cours", HIATUS: "en pause", CANCELLED: "annulée", NOT_YET_RELEASED: "pas encore commencée" };

function phraseStatut(v) {
  const { info } = v;
  const bib = court(etat.prefs.bib);
  const al = v.enr?.anilist;
  const morceaux = [];
  if (al && !al.rejete && al.statut) {
    morceaux.push(`Au Japon, la série est ${ETATS_AL[al.statut] || al.statut}${info.totalVO ? ` (${pluriel(info.totalVO, "tome")})` : ""}.`);
  }
  if (info.parus !== null) {
    morceaux.push(`${pluriel(info.parus, "tome paru", "tomes parus")} en France${info.dateDernier ? `, le dernier en ${moisFr(info.dateDernier)}` : ""}${info.aVenir ? `, ${info.aVenir} encore à venir` : ""}.`);
  } else morceaux.push("Le nombre de tomes parus en France est inconnu.");
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
  const lignesBibs = bibliotheques().map((b) => {
    const l = f?.tomes?.[b] || [];
    const hs = f?.hs?.[b];
    if (!l.length && !hs && b !== bib) return "";
    return `<tr class="${b === bib ? "moi" : ""}"><th>${h(b)}</th><td>${l.length ? h(C.listeCompacte(l)) : "Aucun tome"}${hs ? ` <span class="discret">+ ${pluriel(hs, "hors-série")}</span>` : ""}</td></tr>`;
  }).join("");
  const retires = (f?.retires || []);
  const al = v.enr?.anilist;
  const bnf = v.enr?.bnf;
  const st = etat.stats?.series?.[s.id];
  const L = s.liens || {};
  const urlMN = L.mangaNews ? (L.mangaNews.startsWith("http") ? L.mangaNews : "https://www.manga-news.com/" + L.mangaNews) : null;
  const urlBD = L.bedetheque ? (L.bedetheque.startsWith("http") ? L.bedetheque : "https://www.bedetheque.com/" + L.bedetheque) : null;
  const urlBnf = `https://catalogue.bnf.fr/rechercher.do?motRecherche=${encodeURIComponent(s.titre)}`;
  const meta = [f?.editeur, s.public, v.genre, s.age, s.type === "One shot" ? "One shot" : ""].filter(Boolean).join(", ");
  const src = { manuel: "saisie manuelle", bnf: "BnF", excel: "ancien Excel (Manga-News)", anilist: "AniList", type: "one shot" };

  $("#fiche-contenu").innerHTML = `
    <h1 id="fiche-titre">${h(s.titre)}</h1>
    ${meta ? `<p class="sous-titre">${h(meta)}</p>` : ""}
    ${badge(v.statut.cle)}
    <p class="resume-statut">${h(phraseStatut(v))}</p>
    ${total ? `${legende()}<div class="rayon-complet">${tranches.join("")}</div>` : ""}

    <h2>Par médiathèque</h2>
    <table class="grille-bibs"><tbody>${lignesBibs}</tbody></table>
    ${retires.length ? `<h3>Exemplaires retirés</h3><ul>${retires.map((r) => `<li>${h(court(r.bib))}, tome ${r.tome ?? "?"} : ${h(r.statut)}</li>`).join("")}</ul>` : ""}
    ${s.commande ? `<p><strong>En commande :</strong> ${h(s.commande)}</p>` : ""}
    ${s.commentaire ? `<p><strong>Commentaire :</strong> ${h(s.commentaire)}</p>` : ""}

    ${st ? `<h2>Prêts</h2><p>${pluriel(st.prets?.[bib] || 0, "prêt")} à ${h(court(bib))}, ${pluriel(somme(st.prets), "prêt")} dans le réseau.
      ${somme(st.empruntes) ? `${pluriel(somme(st.empruntes), "exemplaire emprunté", "exemplaires empruntés")} et ` : ""}${pluriel(somme(st.reserves), "réservation")} au moment de l'export.</p>` : ""}

    <h2>D'où viennent ces infos</h2>
    <div class="sources">
      ${al && !al.rejete ? `<div class="source">${al.image ? `<img src="${h(al.image)}" alt="" loading="lazy">` : ""}
        <p><strong>AniList</strong> : <a href="https://anilist.co/manga/${h(al.id)}" target="_blank" rel="noopener">${h(al.titre)}</a>
        <span class="discret">Au Japon : ${h(ETATS_AL[al.statut] || al.statut || "?")}${al.volumes ? `, ${pluriel(al.volumes, "tome")}` : ""}${al.auto ? ". Reliée automatiquement, vérifie que c'est la bonne série." : "."}</span></p></div>`
        : `<div class="source"><p><strong>AniList</strong> : ${al?.rejete ? "lien rejeté." : "pas encore reliée."} <span class="discret">Colle l'adresse de la série AniList dans « Modifier » pour la relier.</span></p></div>`}
      <div class="source"><p><strong>Parution en France</strong> : ${info.parus !== null ? `${pluriel(info.parus, "tome")}, d'après ${src[info.sourceParus] || info.sourceParus}` : "inconnue"}.
        <span class="discret">${bnf?.dernier ? `BnF : jusqu'au tome ${bnf.dernier}${bnf.editeur ? ` chez ${h(bnf.editeur)}` : ""}${bnf.dateDernier ? `, déposé en ${moisFr(bnf.dateDernier)}` : ""}.${bnf.plusieursEditions ? " Plusieurs éditions françaises existent, seule celle qui correspond à la VO est comptée." : ""}${bnf.autresEditeurs?.length ? ` Autres éditeurs : ${h(bnf.autresEditeurs.join(", "))}.` : ""} ` : bnf ? "Pas trouvée à la BnF sous ce titre. " : ""}<a href="${urlBnf}" target="_blank" rel="noopener">Chercher dans le catalogue BnF</a></span></p></div>
      ${s.ancien && (s.ancien.total || s.ancien.etat) ? `<div class="source"><p><strong>Ancien Excel</strong> : <span class="discret">${s.ancien.total ? `${pluriel(s.ancien.total, "tome")}` : ""}${s.ancien.etat ? `, ${h(s.ancien.etat.toLowerCase())}` : ""}${s.ancien.annee ? `, dernière parution ${s.ancien.annee}` : ""}.</span></p></div>` : ""}
    </div>
    <div class="liens">
      ${urlMN ? `<a class="btn" href="${h(urlMN)}" target="_blank" rel="noopener">Manga-News</a>` : ""}
      ${urlBD ? `<a class="btn" href="${h(urlBD)}" target="_blank" rel="noopener">Bédéthèque</a>` : ""}
    </div>

    <details class="repli" id="modifier"><summary>Modifier la série</summary>${formulaire(s)}</details>
  `;
  const fiche = $("#fiche");
  fiche.hidden = false;
  fiche.dataset.id = id;
  document.body.style.overflow = "hidden";
  $(".fiche-panneau").scrollTop = 0;
  $(".fiche-fermer").focus();
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

function itemAchat(v, tomes, detail) {
  const prets = v.prets === null ? "" : `<span class="discret">${pluriel(v.pretsIci, "prêt")} ici, ${nf.format(v.prets)} réseau${v.reserves ? `, ${pluriel(v.reserves, "réservation")}` : ""}</span>`;
  return `<li>
    <span class="item-titre">${h(v.s.titre)}<small>${h([v.f?.editeur, detail].filter(Boolean).join(", "))}</small></span>
    <span class="tomes-liste">${h(tomes)}</span>
    ${prets}
    <span class="item-actions"><button class="btn" data-serie="${h(v.s.id)}">Fiche</button></span>
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
  const nbTomes = (l, f) => l.reduce((a, x) => a + f(x), 0);
  const section = (titre, compte, texte, items, vide) => `
    <section class="section">
      <header><h2>${titre}</h2><span class="compte">${compte}</span></header>
      <p>${texte}</p>
      ${items.length ? `<ul class="items">${items.join("")}</ul>` : `<p class="vide">${vide}</p>`}
    </section>`;
  $("#vue").innerHTML = `
    <h1>À acheter</h1>
    <p class="chapo">Pour les séries présentes à ${h(bib)}, d'après le dernier import Orphée${etat.stats ? ". Les séries les plus empruntées à " + h(bib) + " passent en premier" : ""}.</p>
    <div class="actions"><button class="btn" data-action="csv">Exporter en tableur (CSV)</button><button class="btn" data-action="imprimer">Imprimer</button></div>
    ${section("Absents de tout le réseau", pluriel(nbTomes(absentsReseau, (v) => v.manquantsReseau.length), "tome"),
      "Parus en France, mais aucune médiathèque du réseau ne les a.",
      absentsReseau.map((v) => itemAchat(v, C.listeCompacte(v.manquantsReseau), v.info.etat)), "Rien à signaler : tous les tomes parus sont dans le réseau.")}
    ${section(`Absents de ${h(bib)}, disponibles ailleurs`, pluriel(nbTomes(absentsIci, (x) => x.t.length), "tome"),
      "Les lecteurs peuvent les réserver dans une autre médiathèque. À acheter si la série sort beaucoup.",
      absentsIci.map((x) => itemAchat(x.v, C.listeCompacte(x.t), "ailleurs : " + x.t.length)), "Aucun.")}
    ${section(`Exemplaires à remplacer à ${h(bib)}`, pluriel(aRemplacer.reduce((a, x) => a + x.r.length, 0), "exemplaire"),
      "Perdus, hors service, à pilonner ou marqués pour rachat dans Orphée.",
      aRemplacer.map((x) => itemAchat(x.v, x.r.map((r) => r.tome ?? "?").join(", "), x.r.map((r) => r.statut).join(", "))), "Aucun.")}
    ${section("À paraître en France", pluriel(nbTomes(avenir, (v) => v.info.aVenir), "tome"),
      "Tomes déjà sortis au Japon mais pas encore en France (d'après AniList et la BnF).",
      avenir.map((v) => itemAchat(v, `${v.info.aVenir} à venir`, v.info.etat)), "Rien pour l'instant. Cette liste se remplit après la vérification automatique des parutions.")}
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
  const auDela = etat.vues.filter((v) => v.info.parus !== null && v.info.sourceParus !== "manuel" && v.reseau.length && v.reseau[v.reseau.length - 1] > v.info.parus);
  const anomalies = (etat.fonds.anomalies || []);
  const aRelier = mes.filter((v) => !v.s.liens?.anilist && (!v.enr?.anilist || v.enr.anilist.auto && (v.enr.anilist.score ?? 1) < 0.9) && v.s.genre !== "Comics" && v.s.type !== "One shot");
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
  const section = (titre, items, texte, vide, ouvert = true) => `
    <section class="section">
      <header><h2>${titre}</h2><span class="compte">${nf.format(items.length)}</span></header>
      <p>${texte}</p>
      ${items.length ? (ouvert ? `<ul class="items">${items.join("")}</ul>` : `<details class="repli"><summary>Voir la liste</summary><ul class="items">${items.join("")}</ul></details>`) : `<p class="vide">${vide}</p>`}
    </section>`;
  const fiche = (id) => `<button class="btn" data-serie="${h(id)}">Fiche</button>`;

  $("#vue").innerHTML = `
    <h1>Contrôles</h1>
    <p class="chapo">Ce qui mérite un coup d'œil après chaque import. Les corrections restent sur ce poste jusqu'à ce que tu publies.</p>
    ${section("Commandes arrivées", c.commandesRecues.map((v) => `<li><span class="item-titre">${h(v.s.titre)}<small>En commande : ${h(v.s.commande)}, tous présents à ${h(bib)}</small></span>
      <span class="item-actions"><button class="btn" data-action="vider-commande" data-id="${h(v.s.id)}">Vider la commande</button>${fiche(v.s.id)}</span></li>`),
      `Tous les tomes notés en commande sont maintenant à ${h(bib)}.`, "Aucune commande en attente de vidage.")}
    ${section("Nouvelles séries", c.nouvelles.map((v) => `<li><span class="item-titre">${h(v.s.titre)}<small>Ajoutée par l'import${v.s.ajout ? ` du ${dateFr(v.s.ajout)}` : ""}${v.s.genre ? "" : ", genre à compléter"}</small></span>
      <span class="item-actions"><button class="btn" data-action="vu" data-id="${h(v.s.id)}">C'est bon</button>${fiche(v.s.id)}</span></li>`),
      "Séries trouvées dans Orphée qui n'existaient pas encore. Vérifie le titre et complète le genre. Si c'est une série déjà connue sous un autre nom, relie-la depuis la liste « Sans exemplaire » ci-dessous.", "Aucune nouvelle série.")}
    ${section("Exemplaires sans numéro de tome", c.anomalies.map((a) => `<li><span class="item-titre">${h(a.titre)}<small>${h(court(a.bib))}, cote ${h(a.cote || "?")}, album « ${h(a.album)} »</small></span>
      <span class="item-actions">${fiche(a.serie)}</span></li>`),
      "Le champ tome est vide dans Orphée : ces exemplaires ne sont pas comptés. À corriger dans Orphée.", "Aucun.")}
    ${section("Plus de tomes que de tomes parus", c.auDela.map((v) => `<li><span class="item-titre">${h(v.s.titre)}<small>Le réseau a jusqu'au tome ${v.reseau[v.reseau.length - 1]}, mais la source indique ${pluriel(v.info.parus, "tome paru", "tomes parus")}</small></span>
      <span class="item-actions">${fiche(v.s.id)}</span></li>`),
      "Le nombre de tomes parus n'est plus à jour. La vérification automatique le corrigera ; sinon, saisis-le dans la fiche.", "Aucune incohérence.", false)}
    ${section(`Séries de ${h(bib)} à relier à AniList`, c.aRelier.map((v) => `<li><span class="item-titre">${h(v.s.titre)}<small>${v.enr?.anilist ? `Proposition : ${h(v.enr.anilist.titre)}` : "Pas trouvée automatiquement"}</small></span>
      <span class="item-actions">${fiche(v.s.id)}</span></li>`),
      "Sans lien AniList, Suivixo ne sait pas si la série est terminée au Japon. Ouvre la fiche, cherche la série sur anilist.co et colle son adresse dans « Modifier ».",
      etat.enrich.maj ? "Toutes les séries sont reliées." : "La vérification automatique n'a pas encore tourné.", false)}
    ${section("Sans exemplaire au dernier import", c.sansExemplaire.map((v) => {
      const sug = suggestions(v);
      return `<li><span class="item-titre">${h(v.s.titre)}<small>${sug.length ? `Peut-être : ${sug.map((o) => h(o.s.titre)).join(", ")}` : (v.s.genre === "Comics" ? "Comics : sans doute hors de l'export manga" : "Désherbée, renommée dans Orphée, ou pas encore reçue")}</small></span>
      <span class="item-actions">
        <select data-relier="${h(v.s.id)}" aria-label="Relier ${h(v.s.titre)} à une autre série">
          <option value="">Relier à…</option>
          ${sug.map((o) => `<option value="${h(o.s.id)}">${h(o.s.titre)}</option>`).join("")}
          ${sug.length ? `<option disabled>──────────</option>` : ""}${optionsSeries}
        </select>
        <button class="btn btn-alerte" data-action="supprimer" data-id="${h(v.s.id)}">Supprimer</button>
      </span></li>`;
    }), "Séries de l'ancien Excel qu'aucune médiathèque n'a dans le dernier import. Relie-les à la bonne série si elles ont été renommées, ou supprime-les si elles ont été désherbées.", "Aucune.", false)}
    ${section(`Séries de ${h(bib)} sans genre ou sans public`, c.incomplet.map((v) => `<li><span class="item-titre">${h(v.s.titre)}<small>${[!v.genre && "genre", !v.s.public && "public"].filter(Boolean).join(" et ")} à compléter</small></span><span class="item-actions">${fiche(v.s.id)}</span></li>`),
      "Utile pour les filtres.", "Tout est renseigné.", false)}
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
      <p class="chapo">Fais l'édition des mangas du réseau dans Orphée comme d'habitude, enregistre le fichier Excel, puis dépose-le ici. Le fichier est lu sur ce poste : il n'est envoyé nulle part.</p>
      <label class="depot" id="depot">
        <input type="file" id="fichier" accept=".xlsx,.xls,.xlsm,.ods" hidden>
        <strong>Déposer le fichier ici</strong>
        <span class="discret">ou cliquer pour le choisir (.xlsx, .xls). L'ancien classeur MangaV2-3.xlsm marche aussi.</span>
      </label>
      <p class="note">Ce qui est publié : quels tomes sont dans quelle médiathèque, et les exemplaires perdus ou à remplacer. Ce qui reste dans ce navigateur : les prêts, les emprunts en cours et les réservations.</p>
      <p class="note">Dernier import publié : ${etat.fonds.import?.date ? dateFr(etat.fonds.import.date) : "aucun"}${etat.fonds.import?.exemplaires ? `, ${pluriel(etat.fonds.import.exemplaires, "exemplaire")}` : ""}.</p>`;
    return;
  }
  const d = ip.diff;
  const liste = (arr, f) => arr.length ? `<ul class="items">${arr.slice(0, 200).map(f).join("")}</ul>${arr.length > 200 ? `<p class="discret">… et ${arr.length - 200} autres.</p>` : ""}` : `<p class="vide">Aucun.</p>`;
  $("#vue").innerHTML = `
    <h1>Vérifier l'import</h1>
    <p class="chapo">Fichier « ${h(ip.nom)} ». Rien n'est encore modifié.</p>
    <div class="chiffres">
      <div class="chiffre"><strong>${nf.format(ip.nbExemplaires)}</strong><span>exemplaires lus</span></div>
      <div class="chiffre"><strong>${nf.format(Object.keys(ip.res.fonds.series).length)}</strong><span>séries dans le réseau</span></div>
      ${ip.parBib.map(([b, n]) => `<div class="chiffre"><strong>${nf.format(n)}</strong><span>exemplaires à ${h(court(b))}</span></div>`).join("")}
    </div>
    ${ip.nbExemplaires === 0 ? `<p class="bandeau">Aucun exemplaire reconnu dans ce fichier. Vérifie que c'est bien l'édition des mangas d'Orphée (une ligne par tome, suivie d'une ligne par exemplaire).</p>` : ""}
    <label class="champ" style="max-width:260px"><span>Date de l'export</span><input type="date" id="date-import" value="${h(ip.date)}"></label>
    <section class="section"><header><h2>Nouveaux tomes à ${h(bib)}</h2><span class="compte">${nf.format(d.ajouts.reduce((a, x) => a + x.tomes.length, 0))}</span></header>
      ${liste(d.ajouts, (x) => `<li><span class="item-titre">${h(x.titre)}</span><span class="tomes-liste" style="color:var(--encre)">${h(C.listeCompacte(x.tomes))}</span></li>`)}</section>
    <section class="section"><header><h2>Tomes qui ne sont plus à ${h(bib)}</h2><span class="compte">${nf.format(d.retraits.reduce((a, x) => a + x.tomes.length, 0))}</span></header>
      <p>Désherbés, perdus ou déplacés depuis le dernier import.</p>
      ${liste(d.retraits, (x) => `<li><span class="item-titre">${h(x.titre)}</span><span class="tomes-liste">${h(C.listeCompacte(x.tomes))}</span></li>`)}</section>
    <section class="section"><header><h2>Nouvelles séries dans le réseau</h2><span class="compte">${nf.format(ip.res.nouvelles.length)}</span></header>
      ${liste(ip.res.nouvelles, (s) => `<li><span class="item-titre">${h(s.titre)}<small>${h(ip.res.fonds.series[s.id]?.editeur || "")}</small></span></li>`)}</section>
    ${ip.res.fonds.anomalies.length ? `<section class="section"><header><h2>Exemplaires sans numéro de tome</h2><span class="compte">${ip.res.fonds.anomalies.length}</span></header>
      ${liste(ip.res.fonds.anomalies, (a) => `<li><span class="item-titre">${h(a.titre)}<small>${h(court(a.bib))}, cote ${h(a.cote)}</small></span></li>`)}</section>` : ""}
    <div class="actions">
      <button class="btn btn-fort" data-action="appliquer-import" ${ip.nbExemplaires ? "" : "disabled"}>Appliquer cet import</button>
      <button class="btn" data-action="annuler-import">Annuler</button>
    </div>`;
}

async function lireFichier(fichier) {
  if (!window.XLSX) { toast("Le lecteur de fichiers Excel n'est pas chargé. Recharge la page.", true); return; }
  toast("Lecture du fichier…");
  try {
    const wb = window.XLSX.read(await fichier.arrayBuffer(), { type: "array" });
    const nomFeuille = wb.SheetNames.includes("MajReseau") ? "MajReseau" : wb.SheetNames[0];
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[nomFeuille], { header: 1, defval: null, raw: false });
    const { exemplaires } = C.lireExportOrphee(rows, bibliotheques());
    const dateDefaut = nomFeuille === "MajReseau" ? (etat.fonds.import?.date || new Date().toISOString().slice(0, 10)) : new Date(fichier.lastModified || Date.now()).toISOString().slice(0, 10);
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
      nom: fichier.name, date: dateDefaut, res, nbExemplaires: exemplaires.length,
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
  const btn = $("#btn-publier");
  btn.disabled = true;
  btn.textContent = "Publication…";
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
    btn.disabled = false;
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
  const imp = etat.fonds.import?.date ? `Import Orphée du ${dateFr(etat.fonds.import.date)}` : "Aucun import";
  const enr = etat.enrich.maj ? `parutions vérifiées le ${dateFr(etat.enrich.maj)}` : "parutions pas encore vérifiées";
  $("#infos-donnees").textContent = `${imp}, ${enr}`;
  const btn = $("#btn-publier");
  btn.hidden = !etat.modifie.size;
  if (!btn.disabled) btn.textContent = "Publier les modifications";
  const ban = $("#bandeau");
  if (etat.modifie.size) {
    ban.hidden = false;
    ban.innerHTML = `<p>Des modifications sont enregistrées sur ce poste mais pas encore publiées${etat.brouillonDate ? ` (depuis le ${dateFr(etat.brouillonDate)})` : ""}. Le reste de l'équipe ne les voit pas encore.</p>
      <button class="btn btn-fort" data-action="publier">Publier</button>
      <button class="btn" data-action="abandonner">Abandonner</button>`;
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
  const sel = $("#bib");
  sel.innerHTML = bibliotheques().map((b) => `<option ${b === etat.prefs.bib ? "selected" : ""}>${h(b)}</option>`).join("");
  sel.addEventListener("change", () => { etat.prefs.bib = sel.value; sauverPrefs(); calculer(); rendre(); });

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
    if (t.dataset.pref) { etat.prefs[t.dataset.pref] = t.dataset.val; etat.prefs.statut = null; sauverPrefs(); calculer(); rendre(); return; }
    if (t.dataset.statut) { etat.prefs.statut = etat.prefs.statut === t.dataset.statut ? null : t.dataset.statut; rendre(); return; }
    if (t.dataset.tri) { etat.prefs.tri = t.dataset.tri; sauverPrefs(); rendre(); return; }
    if (t.dataset.serie) { ouvrirFiche(t.dataset.serie); return; }
    const a = t.dataset.action;
    if (a === "plus") { etat.limite += 300; rendre(); }
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
  $("#btn-publier").addEventListener("click", lancerPublication);
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
