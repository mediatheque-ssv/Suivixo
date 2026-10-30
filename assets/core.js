// Suivixo — logique métier partagée (navigateur + Node).
// Aucune dépendance au DOM : ce module est aussi utilisé par les scripts de /scripts.

export const BIBLIOTHEQUES = [
  "Chateaugiron",
  "Domloup",
  "Noyal-sur-Vilaine",
  "Ossé",
  "Piré-Chancé",
  "Servon-sur-Vilaine",
  "St-Aubin du Pavail",
];

// Statuts d'exemplaire qui veulent dire « plus sur les rayons »
const STATUTS_RETIRES = ["perdu", "hors service", "a pilonner", "remplacement, rachat"];

// ---------------------------------------------------------------------------
// Titres
// ---------------------------------------------------------------------------

export function sansAccents(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const ARTICLE_FIN = /\s*\((l'|l’|le|la|les)\)\s*$/i;
const ARTICLE_DEBUT = /^(l'|l’|le\s+|la\s+|les\s+)/i;

/** Clé de comparaison : sans accents, sans article, sans ponctuation ni espaces. */
export function cleTitre(t) {
  let s = sansAccents(t).toLowerCase().replace(/\s+/g, " ").trim();
  s = s.replace(ARTICLE_FIN, "").replace(ARTICLE_DEBUT, "");
  return s.replace(/[^a-z0-9]/g, "");
}

/** Clé de tri alphabétique (ignore l'article de tête). */
export function cleTri(t) {
  return sansAccents(t).toLowerCase().replace(ARTICLE_DEBUT, "").replace(/[^a-z0-9 ]/g, "").trim();
}

/** « Atelier des sorciers (L') » → « L'Atelier des sorciers » ; retours à la ligne → « : ». */
export function titreNaturel(t) {
  let s = String(t ?? "").replace(/\s*\n\s*/g, " : ").replace(/\s+/g, " ").trim();
  const m = s.match(ARTICLE_FIN);
  if (m) {
    const art = m[1].replace("’", "'");
    const reste = s.replace(ARTICLE_FIN, "").trim();
    const artCap = art.charAt(0).toUpperCase() + art.slice(1).toLowerCase();
    s = artCap.endsWith("'") ? artCap + reste : artCap + " " + reste;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function slug(t) {
  const s = sansAccents(t).toLowerCase().replace(ARTICLE_FIN, "").replace(ARTICLE_DEBUT, "");
  return s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "serie";
}

// ---------------------------------------------------------------------------
// Listes de tomes
// ---------------------------------------------------------------------------

/** [1,2,3,5,7,8] → « 1-3, 5, 7-8 » */
export function listeCompacte(nums, sep = ", ") {
  const t = [...new Set(nums)].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < t.length; i++) {
    let j = i;
    while (j + 1 < t.length && t[j + 1] === t[j] + 1) j++;
    out.push(j > i ? `${t[i]}-${t[j]}` : `${t[i]}`);
    i = j;
  }
  return out.join(sep);
}

/** « 1-3,5 » → [1,2,3,5] (tolère espaces, points-virgules) */
export function lireListe(s) {
  const out = new Set();
  for (const part of String(s ?? "").split(/[,;]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = +m[1], b = +m[2];
      if (b >= a && b - a < 500) for (let i = a; i <= b; i++) out.add(i);
    } else if (/^\d+$/.test(p)) out.add(+p);
  }
  return [...out].sort((a, b) => a - b);
}

/** Interprète la cellule « Tome : … » d'Orphée. */
export function parseTome(brut, album) {
  const s = String(brut ?? "").replace(/^\s*tome\s*:\s*/i, "").split("\n")[0].trim();
  let m;
  if (/^\d+$/.test(s)) return { type: "num", nums: [+s] };
  if ((m = s.match(/^(\d+)\s*-\s*(\d+)$/))) return { type: "num", nums: lireListe(s) };
  if ((m = s.match(/^tome\s*(\d+)$/i))) return { type: "num", nums: [+m[1]] };
  if (/^one\s*-?\s*shot/i.test(s)) return { type: "oneshot", nums: [1] };
  if (/^(hs|hors[\s-]*s[eé]rie)/i.test(s)) return { type: "hs", nums: [] };
  // Numéro absent : on tente le titre de l'album (« Blue giant 3 »)
  const a = String(album ?? "").trim().match(/\s(\d{1,3})$/);
  if (a) return { type: "num", nums: [+a[1]], deduit: true };
  return { type: "inconnu", nums: [] };
}

// ---------------------------------------------------------------------------
// Lecture de l'export Orphée
// ---------------------------------------------------------------------------

const texte = (v) => (v === null || v === undefined ? "" : String(v)).trim();

/** ISBN lisible dans une cellule → ISBN-13 sans tirets ; sinon null.
 *  Clé de contrôle vérifiée (écarte les codes-barres d'exemplaires et autres numéros).
 *  Tolère plusieurs ISBN dans la cellule (le premier valide est pris), un complément « (Poche) »,
 *  et un ISBN-13 noté sans son « 978- » (2-205-00585-1 pour 978-2-205-00585-1), fréquent dans le catalogue. */
export function isbnValide(v) {
  return isbnDe(v)?.isbn || null;
}

/** Comme isbnValide, avec aussi l'ISBN tel qu'il est écrit dans Orphée (« 978-2-205-07276-1 »),
 *  pour la recherche sur le portail des médiathèques. */
export function isbnDe(v) {
  const t = texte(v);
  if (!t) return null;
  for (const m of t.matchAll(/[\dXx][\d -]{8,16}[\dXx]/g)) {
    const isbn = isbnNormalise(m[0]);
    if (isbn) return { isbn, brut: m[0].trim() };
  }
  return null;
}

function isbnNormalise(brut) {
  const ean = (c) => [...c].reduce((acc, ch, i) => acc + +ch * (i % 2 ? 3 : 1), 0) % 10 === 0;
  const c = brut.replace(/[\s-]/g, "").toUpperCase();
  if (c.length === 10 && /^\d{9}[\dX]$/.test(c)) {
    const somme = [...c].reduce((acc, ch, i) => acc + (10 - i) * (ch === "X" ? 10 : +ch), 0);
    if (somme % 11 === 0) {
      const b = "978" + c.slice(0, 9);
      return b + ((10 - ([...b].reduce((acc, ch, i) => acc + +ch * (i % 2 ? 3 : 1), 0) % 10)) % 10);
    }
    if (/^\d{10}$/.test(c) && ean("978" + c)) return "978" + c; // ISBN-13 sans son préfixe
  } else if (c.length === 13 && /^97[89]\d{10}$/.test(c) && ean(c)) {
    return c;
  }
  return null;
}

/**
 * Lit les lignes d'un export Orphée (tableau de tableaux, comme XLSX.utils.sheet_to_json(ws,{header:1})).
 * Structure : une ligne « titre » (A = série, F = « Tome : n », J = album, Q = auteur, Y = éditeur)
 * suivie d'une ou plusieurs lignes « exemplaire » (A = médiathèque, C = cote, F = statut,
 * H = public ou ISBN, W = « Nb prêts total : n », AA = code-barre).
 * L'ISBN est repéré où qu'il soit sur la ligne de l'exemplaire (clé de contrôle vérifiée).
 */
export function lireExportOrphee(rows, bibliotheques = BIBLIOTHEQUES) {
  const bibs = new Map(bibliotheques.map((b) => [cleTitre(b), b]));
  const exemplaires = [];
  let titre = null;
  let lignesTitre = 0;
  let annonce = null; // « Nombre de documents: 4834 » dans l'en-tête de l'édition
  let date = null;    // « Le 23 octobre 2026 »
  for (const row of rows) {
    // les exports Orphée intercalent des lignes vides : on les saute sans perdre le titre en cours
    if (!row || !row.some((v) => texte(v) !== "")) continue;
    if (annonce === null) {
      const m = row.map(texte).join(" ").match(/nombre de documents\s*:\s*(\d+)/i);
      if (m) annonce = +m[1];
    }
    if (date === null && lignesTitre === 0) date = dateFrancaise(row.map(texte).join(" "));
    const a = texte(row[0]);
    const bib = bibs.get(cleTitre(a));
    const celluleTome = row.findIndex((v) => /^\s*tome\s*:/i.test(texte(v)));
    if (bib && titre) {
      const cellPrets = row.map(texte).find((v) => /nb\s*pr[eê]ts/i.test(v)) || "";
      const prets = +(cellPrets.match(/(\d+)/)?.[1] ?? 0);
      // colonne H : le public, ou l'ISBN si l'édition a été modifiée pour l'afficher à sa place
      const lu = isbnDe(row[7]) || row.map(isbnDe).find(Boolean) || null;
      exemplaires.push({
        ...titre,
        bib,
        cote: texte(row[2]),
        statut: texte(row[5]),
        public: isbnDe(row[7]) ? "" : texte(row[7]),
        ...(lu ? { isbn: lu.isbn, isbnBrut: lu.brut } : {}),
        genre: texte(row[14]).replace(/^CS\d*\s*:\s*/i, "").replace(/^non renseign[ée]$/i, ""),
        prets,
        codeBarre: texte(row[26]),
      });
    } else if (celluleTome >= 0) {
      // Ligne de titre. Les œuvres sans série dans Orphée (« Les trois mousquetaires », « Spirale »…)
      // n'ont rien en colonne A : leur titre est celui de l'album. Avant, ces lignes étaient sautées
      // et leurs exemplaires attribués au titre précédent (Zozo zombie, Your name…).
      const album = texte(row[9]);
      if (!a && !album) { titre = null; continue; }
      lignesTitre++;
      titre = {
        titreBrut: a || album,
        tomeBrut: texte(row[celluleTome]),
        album,
        auteur: texte(row[16]),
        editeur: texte(row[24]),
        ...(a ? {} : { sansSerie: true }),
      };
    }
    // Les autres lignes (titre de l'édition, « Page 12 of 360 » aux sauts de page…) sont ignorées
    // sans perdre le tome en cours : ses exemplaires peuvent continuer sur la page suivante.
  }
  return { exemplaires, lignesTitre, annonce, date };
}

const MOIS_FR = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];

/** « Le 23 octobre 2026 » → « 2026-10-23 » */
export function dateFrancaise(txt) {
  const m = sansAccents(txt).toLowerCase().match(/\b(\d{1,2})(?:er)?\s+([a-z]+)\s+(\d{4})\b/);
  if (!m) return null;
  const mois = MOIS_FR.indexOf(m[2]);
  if (mois < 0) return null;
  return `${m[3]}-${String(mois + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

export function estRetire(statut) {
  const s = sansAccents(statut).toLowerCase().trim();
  return STATUTS_RETIRES.some((x) => s.startsWith(x));
}

/** Index cle → id de série (titre + alias). */
export function indexSeries(series) {
  const idx = new Map();
  for (const s of series) {
    for (const t of [s.titre, ...(s.alias || [])]) {
      const k = cleTitre(t);
      if (k && !idx.has(k)) idx.set(k, s.id);
    }
  }
  // Repli : « L'Enfant et le maudit : Siuil, a Run » répond aussi à « L'Enfant et le maudit »,
  // seulement si aucune autre série ne porte déjà ce titre court.
  for (const s of series) {
    for (const t of [s.titre, ...(s.alias || [])]) {
      const court = String(t).split(" : ")[0];
      const k = cleTitre(court);
      if (court !== t && k.length >= 4 && !idx.has(k)) idx.set(k, s.id);
    }
  }
  return idx;
}

/** Titres candidats pour rattacher un exemplaire à une série. */
function candidatsTitre(ex) {
  const lignes = ex.titreBrut.split(/\n/).map((x) => x.trim()).filter(Boolean);
  const albumSansNum = ex.album.replace(/\s+\d{1,3}$/, "").trim();
  return [ex.titreBrut.replace(/\s*\n\s*/g, " "), lignes[0], lignes[1], albumSansNum].filter(Boolean);
}

const numeroDansCote = (cote) => {
  const m = cote.match(/\bT\.?\s*(\d{1,3})\b/i) || cote.match(/^[A-Z]{1,4}\s+[A-Z0-9]{2,6}\s+(\d{1,3})$/i);
  return m ? +m[1] : null;
};

/** Numéro de tome d'un exemplaire : cellule « Tome : », titre de l'album, puis cote.
 *  `seriesSansNom` : titres sans série dans Orphée qui ont plusieurs numéros de cote (« EKEKO » 1, 2, 3). */
function tomeExemplaire(ex, seriesSansNom) {
  const tome = parseTome(ex.tomeBrut, ex.sansSerie ? "" : ex.album);
  if (tome.type === "inconnu") {
    // Œuvre sans série dans Orphée : un one shot, sauf si plusieurs tomes portent ce titre
    // (« Errances d'Emanon », cote « M EMA 2 », est un livre à part, numéroté pour le rangement).
    if (ex.sansSerie && !seriesSansNom.has(cleTitre(ex.titreBrut))) return { type: "oneshot", nums: [1] };
    // dernier recours : le numéro dans la cote (« MA BUG T.1 », « 741.5 SAN T9 », « M EKE 3 »)
    const n = numeroDansCote(ex.cote);
    if (n !== null) return { type: "num", nums: [n], deduit: true };
    if (ex.sansSerie) return { type: "oneshot", nums: [1] };
  }
  return tome;
}

/**
 * Construit le fonds à partir des exemplaires lus dans Orphée.
 * Renvoie : fonds (publiable), stats (prêts, local), nouvelles séries, anomalies.
 */
export function construireFonds(exemplaires, series, meta = {}) {
  const idx = indexSeries(series);
  const parSerie = new Map(series.map((s) => [s.id, s]));
  // numéros indiqués pour des titres rattachés : { "Abominables bonshommes de neige": 38 }
  const numerosDe = (s) => new Map(Object.entries(s.numeros || {}).map(([t, n]) => [cleTitre(t), +n]));
  const ids = new Set(series.map((s) => s.id));
  const nouvelles = new Map(); // cle → série créée
  const fonds = {};
  const stats = {};
  const anomalies = [];
  const bibsVues = new Set();
  // titres sans série dans Orphée présents avec plusieurs numéros de cote : de vraies séries
  const numsSansNom = new Map();
  for (const ex of exemplaires) {
    if (!ex.sansSerie) continue;
    const n = numeroDansCote(ex.cote);
    if (n === null) continue;
    const k = cleTitre(ex.titreBrut);
    if (!numsSansNom.has(k)) numsSansNom.set(k, new Set());
    numsSansNom.get(k).add(n);
  }
  const seriesSansNom = new Set([...numsSansNom].filter(([, ns]) => ns.size > 1).map(([k]) => k));

  const assurer = (id, ex) => {
    if (!fonds[id]) fonds[id] = { titreOrphee: titreNaturel(ex.titreBrut.split("\n")[0]), editeur: "", auteur: "", tomes: {}, hs: {}, retires: [], sansNumero: {}, isbn: {}, isbnSansNumero: [], _genres: {} };
    if (!stats[id]) stats[id] = { prets: {}, empruntes: {}, reserves: {}, exemplaires: {}, parTome: {} };
    return fonds[id];
  };

  for (const ex of exemplaires) {
    bibsVues.add(ex.bib);
    let id = null;
    for (const c of candidatsTitre(ex)) {
      const k = cleTitre(c);
      if (idx.has(k)) { id = idx.get(k); break; }
      if (nouvelles.has(k)) { id = nouvelles.get(k).id; break; }
    }
    const tome = tomeExemplaire(ex, seriesSansNom);
    if (tome.type === "num" && tome.nums.some((n) => n > 200)) Object.assign(tome, { type: "inconnu", nums: [] }); // « 10000 », « 2006 »…
    // titre sans série dans Orphée, rattaché dans Suivixo à une vraie série (« Abominables bonshommes de
    // neige » → Chair de poule) : son numéro s'il a été indiqué, sinon titre sans numéro (pas un « tome 1 »)
    const cible = id ? parSerie.get(id) : null;
    if (cible && ex.sansSerie && cible.type !== "One shot") {
      const n = numerosDe(cible).get(cleTitre(ex.album || ex.titreBrut));
      Object.assign(tome, n ? { type: "num", nums: [n] } : { type: "inconnu", nums: [] });
    }
    if (!id) {
      const titre = titreNaturel(ex.titreBrut.split("\n")[0]);
      let nid = slug(titre), n = 2;
      while (ids.has(nid)) nid = `${slug(titre)}-${n++}`;
      ids.add(nid);
      const s = {
        id: nid,
        titre,
        alias: [],
        public: ex.public || "",
        genre: "",
        type: tome.type === "oneshot" ? "One shot" : "Série",
        nouvelle: meta.date || true,
      };
      nouvelles.set(cleTitre(titre), s);
      id = nid;
    }
    const f = assurer(id, ex);
    if (!f.editeur && ex.editeur) f.editeur = ex.editeur;
    if (!f.auteur && ex.auteur) f.auteur = ex.auteur;
    if (ex.genre) f._genres[ex.genre] = (f._genres[ex.genre] || 0) + 1;
    if (/^WT\b/i.test(ex.cote)) f.webtoon = true; // cote « WT … » : webtoon
    const st = stats[id];
    // ISBN par tome (le premier rencontré ; celui d'un exemplaire en rayon remplace celui d'un retiré)
    if (ex.isbn) {
      const n = tome.type === "oneshot" ? 1 : tome.type === "num" && tome.nums.length ? tome.nums[0] : null;
      if (n !== null) {
        if (!f.isbn[n] || (f._isbnRetire?.[n] && !estRetire(ex.statut))) {
          f.isbn[n] = ex.isbn;
          (f._isbnRetire ||= {})[n] = estRetire(ex.statut);
        }
      } else if (tome.type === "inconnu" && f.isbnSansNumero.length < 5 && !f.isbnSansNumero.includes(ex.isbn)) {
        f.isbnSansNumero.push(ex.isbn);
      }
    }

    if (!estRetire(ex.statut) && (ex.codeBarre || ex.isbnBrut)) {
      // pour la fiche : copier le code-barre ou l'ISBN et chercher dans Orphée, voir le livre sur le portail
      const t = tome.type === "num" && tome.nums.length ? tome.nums[0] : tome.type === "oneshot" ? 1 : titreNaturel(ex.album || ex.titreBrut);
      ((f.exemplaires ||= {})[ex.bib] ||= []).push({ t, ...(ex.isbnBrut ? { i: ex.isbnBrut } : {}), ...(ex.codeBarre ? { c: ex.codeBarre } : {}), ...(ex.cote ? { k: ex.cote } : {}) });
    }

    if (estRetire(ex.statut)) {
      f.retires.push({ bib: ex.bib, tome: tome.nums[0] ?? null, statut: ex.statut, cote: ex.cote });
      continue;
    }
    st.exemplaires[ex.bib] = (st.exemplaires[ex.bib] || 0) + 1;
    st.prets[ex.bib] = (st.prets[ex.bib] || 0) + (ex.prets || 0);
    const sl = sansAccents(ex.statut).toLowerCase();
    if (sl.startsWith("emprunt")) st.empruntes[ex.bib] = (st.empruntes[ex.bib] || 0) + 1;
    if (sl.startsWith("reserv") || sl.includes("transit (reserv")) st.reserves[ex.bib] = (st.reserves[ex.bib] || 0) + 1;

    if (tome.type === "hs") { f.hs[ex.bib] = (f.hs[ex.bib] || 0) + 1; continue; }
    if (tome.type === "inconnu") {
      // gardé dans la fiche de la série : « Titres sans numéro dans Orphée »
      const liste = (f.sansNumero[ex.bib] ||= []);
      const nom = titreNaturel(ex.album || ex.titreBrut);
      if (nom && !liste.includes(nom)) liste.push(nom);
      anomalies.push({ type: "tome-inconnu", serie: id, titre: titreNaturel(ex.titreBrut), album: ex.album, bib: ex.bib, cote: ex.cote, brut: ex.tomeBrut });
      continue;
    }
    if (tome.type === "oneshot") f.oneShot = true;
    // prêts par tome : [prêts cumulés, exemplaires], pour voir si les lecteurs continuent après le tome 1
    if (tome.type === "num" && tome.nums.length) {
      const pt = (st.parTome[ex.bib] ||= {});
      const c = (pt[tome.nums[0]] ||= [0, 0]);
      c[0] += ex.prets || 0; c[1] += 1;
    }
    const liste = new Set(f.tomes[ex.bib] || []);
    tome.nums.forEach((n) => liste.add(n));
    f.tomes[ex.bib] = [...liste].sort((a, b) => a - b);
  }

  // nettoyage : pas de clés vides
  for (const f of Object.values(fonds)) {
    if (!Object.keys(f.hs).length) delete f.hs;
    if (!f.retires.length) delete f.retires;
    if (!Object.keys(f.sansNumero).length) delete f.sansNumero;
    if (!Object.keys(f.isbn).length) delete f.isbn;
    for (const l of Object.values(f.exemplaires || {})) {
      l.sort((a, b) => (typeof a.t === "number" ? 0 : 1) - (typeof b.t === "number" ? 0 : 1) || (typeof a.t === "number" ? a.t - b.t : String(a.t).localeCompare(String(b.t), "fr")));
    }
    if (!f.isbnSansNumero.length) delete f.isbnSansNumero;
    delete f._isbnRetire;
    // genre d'Orphée (champ CS2) le plus fréquent dans la série
    const g = Object.entries(f._genres).sort((a, b) => b[1] - a[1])[0];
    if (g) f.genreOrphee = g[0];
    delete f._genres;
    if (!f.auteur) delete f.auteur;
  }

  return {
    fonds: {
      import: { date: meta.date || null, source: meta.source || null, exemplaires: exemplaires.length },
      bibliotheques: [...bibsVues].sort((a, b) => a.localeCompare(b, "fr")),
      series: fonds,
      anomalies,
    },
    stats: { date: meta.date || null, series: stats },
    nouvelles: [...nouvelles.values()],
  };
}

// ---------------------------------------------------------------------------
// Calculs pour l'affichage
// ---------------------------------------------------------------------------

export function tomesReseau(f) {
  const s = new Set();
  for (const l of Object.values(f?.tomes || {})) l.forEach((n) => s.add(n));
  return [...s].sort((a, b) => a - b);
}

/** Plus haut tome possédé, sans un numéro isolé très loin des autres (« 2006 » lu dans une année). */
export function maxPlausible(tomes) {
  const l = [...tomes];
  while (l.length > 1 && l[l.length - 1] - l[l.length - 2] > 30) l.pop();
  return l.length ? l[l.length - 1] : 0;
}

const MOIS = 30.44 * 24 * 3600 * 1000;

/** Dernier tome paru d'après la BnF, en écartant les numéros aberrants (ex. « 202 » lu dans « 2024 »). */
export function dernierBnf(bnf) {
  if (!bnf || !Number.isFinite(bnf.dernier) || bnf.dernier <= 0) return null;
  const nums = lireListe(bnf.tomes);
  if (!nums.length) return bnf.dernier;
  while (nums.length > 1 && nums[nums.length - 1] - nums[nums.length - 2] > 20) nums.pop();
  return Math.min(bnf.dernier, nums[nums.length - 1]);
}

/**
 * Combien de tomes sont parus en France, et où en est la série ?
 * Ordre de priorité : saisie manuelle > BnF + AniList > ancien Excel (Manga-News).
 */
/**
 * Fiche Manga-News lue par la vérification hebdo, si elle parle bien de l'édition du réseau
 * (même éditeur, ou page indiquée à la main dans « Modifier la série »).
 */
export function ficheMangaNews(serie, enr, memeIllisible = false) {
  const f = enr?.mangaNewsFiche;
  if (!f || (!memeIllisible && (f.lu === false || !(Number.isFinite(f.vf) || Number.isFinite(f.vo))))) return null;
  const manuel = serie.liens?.mangaNews;
  const chemin = (u) => (u || "").replace(/^https?:\/\/(www\.)?manga-news\.com\//, "");
  // f.lien : page d'un tome indiquée à la main, dont la fiche de la série a été lue
  const okManuel = manuel && ((f.url && f.url.endsWith(chemin(manuel))) || (f.lien && chemin(f.lien) === chemin(manuel)));
  // page trouvée dans le jeu de données Manga-News (même éditeur), si aucune page n'est indiquée ou si elle a disparu
  const okJeu = enr.mangaNews && !enr.mangaNews.editeurDifferent && f.url === enr.mangaNews.url && (!manuel || f.secours);
  return okManuel || okJeu ? f : null;
}

/** « Terminé », « En cours », « Abandonné »… de Manga-News, dans le vocabulaire du site. */
export function etatMangaNews(statut) {
  const t = sansAccents(statut || "").toLowerCase();
  if (/termin|fini|complet/.test(t)) return "Terminée";
  if (/abandon|stopp|arret|annul/.test(t)) return "Abandonnée";
  if (/pause|suspen/.test(t)) return "En pause";
  if (/cours/.test(t)) return "En cours";
  return null;
}

export function infosParution(serie, enr, maintenant = Date.now(), maxReseau = 0, { presumer = false } = {}) {
  const man = serie.manuel || {};
  const al = enr?.anilist && !enr.anilist.rejete && !enr.anilist.auteurDifferent ? enr.anilist : null;
  const bnf = enr?.bnf || null;
  const leg = serie.ancien || {};
  const fiche = ficheMangaNews(serie, enr);
  const etatFiche = fiche ? etatMangaNews(fiche.vfStatut) : null;

  // --- parus en France
  let parus = null, sourceParus = null;
  const mn = enr?.mangaNews && Number.isFinite(enr.mangaNews.tomes) && !enr.mangaNews.editeurDifferent ? enr.mangaNews.tomes : null;
  // Sur la fiche, « VF : 20 » pourrait compter un tome annoncé : on se fie d'abord à l'encadré « Dernier paru ».
  // (Si la série est terminée, « VF : 6 » est le total ; et un « dernier paru » bien plus bas que le compte
  // est une réimpression d'un ancien tome, pas le dernier de la série.)
  let fvf = fiche && Number.isFinite(fiche.vf) ? fiche.vf : null;
  if (fvf !== null && etatFiche !== "Terminée" && fiche.vfDernier > 0 && fiche.vfDernier <= fvf && fiche.vfDernier >= fvf - 1) fvf = fiche.vfDernier;
  else if (fvf !== null && etatFiche !== "Terminée" && fiche.vfProchain > 0 && fiche.vfProchain <= fvf
    && !(fiche.vfProchainDate && Date.parse(fiche.vfProchainDate) <= maintenant)) fvf = fiche.vfProchain - 1;
  // le tome annoncé est sorti depuis la lecture de la fiche
  if (fvf !== null && etatFiche !== "Terminée" && fiche.vfProchain > fvf && fiche.vfProchainDate && Date.parse(fiche.vfProchainDate) <= maintenant) fvf = fiche.vfProchain;
  if (Number.isFinite(man.parus)) { parus = man.parus; sourceParus = "manuel"; }
  else if (fvf !== null && etatFiche === "Terminée") { parus = fvf; sourceParus = "mangaNews"; }
  else if (dernierBnf(bnf) || mn || fvf) {
    // BnF et Manga-News : on garde le plus grand (la BnF a du retard, Manga-News date de sa dernière publication)
    const b = dernierBnf(bnf) || 0;
    const m = fvf !== null ? fvf : mn || 0; // la fiche est plus récente que le jeu de données
    if (m > b) { parus = m; sourceParus = "mangaNews"; } else { parus = b; sourceParus = "bnf"; }
  }
  else if (Number.isFinite(leg.total)) { parus = leg.total; sourceParus = "excel"; }
  // Le réseau a déjà un tome plus récent que ce que disent les sources : il est forcément paru
  // (la BnF a parfois plusieurs mois de retard).
  let sourceEnRetard = null;
  if (sourceParus !== "manuel" && maxReseau > 0 && (parus === null || maxReseau > parus)) {
    sourceEnRetard = sourceParus;
    parus = maxReseau;
    sourceParus = "reseau";
  }

  // --- état
  // Nombre de tomes VO : la fiche Manga-News suit l'édition VO traduite (et donne le compte à jour
  // des séries en cours) ; AniList en secours.
  const totalVO = fiche && fiche.vo > 0 ? fiche.vo : al && Number.isFinite(al.volumes) && al.volumes > 0 ? al.volumes : null;
  const etatVO = fiche?.voStatut ? etatMangaNews(fiche.voStatut) : al ? ({ FINISHED: "Terminée", RELEASING: "En cours", HIATUS: "En pause", CANCELLED: "Abandonnée", NOT_YET_RELEASED: "En cours" })[al.statut] || null : null;
  let etat = null, sourceEtat = null, aVenir = null, doute = false;
  if (man.etat) { etat = man.etat; sourceEtat = "manuel"; }
  else if (etatFiche) {
    etat = etatFiche; sourceEtat = "mangaNews";
    // Manga-News a du retard : la VO est finie et la France a déjà tous ses tomes (le réseau a le dernier)
    if (etat === "En cours" && etatVO === "Terminée" && totalVO && parus !== null && parus >= totalVO) etat = "Terminée";
    if (etat !== "Terminée" && totalVO && parus !== null && totalVO > parus) aVenir = totalVO - parus;
  }
  else if (al && al.statut) {
    sourceEtat = "anilist";
    if (al.statut === "FINISHED") {
      if (totalVO && parus !== null && parus >= totalVO) etat = "Terminée";
      else if (totalVO && parus !== null) {
        aVenir = totalVO - parus;
        const dernier = bnf?.dateDernier ? Date.parse(bnf.dateDernier) : NaN;
        if (sourceParus === "bnf" && Number.isFinite(dernier) && maintenant - dernier > 24 * MOIS) {
          etat = "Arrêtée en France ?"; doute = true;
        } else etat = "En cours";
      } else if (!totalVO) {
        // VO terminée sans nombre de tomes connu (fréquent pour les webtoons, publiés en ligne) :
        // si un tome est encore sorti en France ces 18 derniers mois, l'édition française continue sans doute.
        const dernier = bnf?.dateDernier ? Date.parse(bnf.dateDernier) : NaN;
        if (Number.isFinite(dernier) && maintenant - dernier < 18 * MOIS) etat = "En cours";
        else { etat = "Terminée"; doute = parus === null; }
      }
      else { etat = "En cours"; doute = true; }
    } else if (al.statut === "RELEASING") etat = "En cours";
    else if (al.statut === "HIATUS") etat = "En pause";
    else if (al.statut === "CANCELLED") etat = "Abandonnée";
    else if (al.statut === "NOT_YET_RELEASED") etat = "En cours";
  } else if (leg.etat) { etat = leg.etat; sourceEtat = "excel"; }

  // Aucune source ne donne l'état (webtoons, BD et romans jeunesse) : un tome sorti en France récemment,
  // c'est que la série continue. Pour la BD et les romans (`presumer`), plus rien depuis 18 mois :
  // sans doute terminée (la fiche permet de corriger).
  if (!etat && parus !== null && serie.type !== "One shot") {
    const fr = ficheMangaNews(serie, enr, true);
    const d = Math.max(Date.parse(fr?.vfDernierDate || "") || 0, Date.parse(bnf?.dateDernier || "") || 0);
    const delai = (presumer ? 18 : 12) * MOIS;
    if (d && maintenant - d < delai) { etat = "En cours"; sourceEtat = "recent"; }
    // la médiathèque a des tomes plus récents que ce que recense la BnF : sa date ne dit rien
    else if (presumer && sourceParus === "reseau") { etat = "En cours"; sourceEtat = "presume"; }
    else if (presumer && d) { etat = "Terminée"; sourceEtat = "ancien"; }
  }
  if (serie.type === "One shot" && !etat) { etat = "Terminée"; sourceEtat = sourceEtat || "type"; }
  if (serie.type === "One shot" && parus === null) { parus = 1; sourceParus = sourceParus || "type"; }

  const pays = al?.pays || fiche?.pays || null;
  // Prochain tome annoncé en France (date de sortie), s'il n'est pas déjà sorti depuis la lecture de la fiche
  // (une série terminée en France peut annoncer un hors-série ou une réédition : on n'en parle pas)
  const prochain = fiche?.vfProchainDate && etatFiche !== "Terminée" && Date.parse(fiche.vfProchainDate) > maintenant
    ? { tome: fiche.vfProchain || null, date: fiche.vfProchainDate } : null;
  return { parus, sourceParus, sourceEnRetard, etat, sourceEtat, totalVO, etatVO, pays, aVenir, doute, prochain,
    dateDernier: fiche?.vfDernierDate || bnf?.dateDernier || null };
}

/** Libellés repris de l'ancien Excel. */
export const STATUTS = {
  finie: "Finie",
  completer: "À compléter",
  continuer: "À continuer",
  attente: "En attente",
  abandonnee: "Abandonnée",
  verifier: "À vérifier",
};

/**
 * Où en est la série pour un périmètre donné (une médiathèque ou tout le réseau).
 * Finie = terminée + tous les tomes ; À compléter = terminée + il en manque ;
 * À continuer = en cours + il en manque ; En attente = en cours + à jour.
 */
export function statutSerie(possedes, info) {
  const { parus, etat } = info;
  if (parus === null || !etat) return { cle: "verifier", manquants: [] };
  const set = new Set(possedes);
  const manquants = [];
  for (let i = 1; i <= parus; i++) if (!set.has(i)) manquants.push(i);
  if (/abandon/i.test(etat)) return { cle: "abandonnee", manquants };
  if (info.doute || /\?\s*$/.test(etat)) return { cle: "verifier", manquants };
  const termine = /termin|arr[eê]t/i.test(etat);
  if (termine) return { cle: manquants.length ? "completer" : "finie", manquants };
  return { cle: manquants.length ? "continuer" : "attente", manquants };
}

export function presence(f, bib) {
  // une médiathèque a la série si elle a au moins un tome numéroté, un hors-série ou un titre sans numéro
  const a = (b) => (f?.tomes?.[b] || []).length > 0 || (f?.sansNumero?.[b] || []).length > 0 || (f?.hs?.[b] || 0) > 0;
  const bibs = new Set([...Object.keys(f?.tomes || {}), ...Object.keys(f?.sansNumero || {}), ...Object.keys(f?.hs || {})]);
  const ici = a(bib);
  const ailleurs = [...bibs].some((b) => b !== bib && a(b));
  if (ici && ailleurs) return "partagee";
  if (ici) return "ici";
  if (ailleurs) return "reseau";
  return "aucune";
}
