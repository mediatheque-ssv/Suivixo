// Publication dans le dépôt GitHub : un seul commit pour tous les fichiers modifiés.

const API = "https://api.github.com";

async function appel(token, methode, chemin, corps) {
  const r = await fetch(API + chemin, {
    method: methode,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(corps ? { "Content-Type": "application/json" } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).message || ""; } catch { /* rien */ }
    const err = new Error(messageErreur(r.status, detail));
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

function messageErreur(status, detail) {
  if (status === 401) return "La clé d'accès GitHub est refusée (expirée ou mal copiée). Remplace-la dans les réglages.";
  if (status === 403 || status === 404) return "La clé d'accès n'a pas le droit d'écrire dans ce dépôt. Vérifie qu'elle cible bien « suivixo » avec Contents en lecture et écriture.";
  if (status === 409 || status === 422) return "Le dépôt a changé pendant l'enregistrement. Nouvel essai dans un instant.";
  return `GitHub a répondu ${status}${detail ? ` : ${detail}` : ""}.`;
}

/** Vérifie la clé et renvoie le nom du compte. */
export async function verifierCle(token, depot) {
  const d = await appel(token, "GET", `/repos/${depot}`);
  if (!d.permissions?.push) throw new Error("Cette clé peut lire le dépôt mais pas y écrire.");
  return d.full_name;
}

/** Contenu actuel d'un fichier du dépôt (null s'il n'existe pas encore). */
export async function lireFichier({ token, depot, branche = "main", chemin }) {
  const r = await fetch(`${API}/repos/${depot}/contents/${chemin}?ref=${branche}&t=${Date.now()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28" },
    cache: "no-store",
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    const err = new Error(messageErreur(r.status, ""));
    err.status = r.status;
    throw err;
  }
  return r.text();
}

/**
 * fichiers : [{ chemin: "data/series.json", contenu: "…" }]
 */
export async function publier({ token, depot, branche = "main", fichiers, message }) {
  const ref = await appel(token, "GET", `/repos/${depot}/git/ref/heads/${branche}`);
  const commitParent = await appel(token, "GET", `/repos/${depot}/git/commits/${ref.object.sha}`);
  const tree = [];
  for (const f of fichiers) {
    const blob = await appel(token, "POST", `/repos/${depot}/git/blobs`, { content: f.contenu, encoding: "utf-8" });
    tree.push({ path: f.chemin, mode: "100644", type: "blob", sha: blob.sha });
  }
  const nouvelArbre = await appel(token, "POST", `/repos/${depot}/git/trees`, { base_tree: commitParent.tree.sha, tree });
  const commit = await appel(token, "POST", `/repos/${depot}/git/commits`, {
    message,
    tree: nouvelArbre.sha,
    parents: [ref.object.sha],
  });
  await appel(token, "PATCH", `/repos/${depot}/git/refs/heads/${branche}`, { sha: commit.sha });
  return commit;
}

/**
 * Lance la vérification des parutions (GitHub Actions) tout de suite.
 * series : identifiants à revérifier entièrement ; vide = passage normal (nouvelles séries, liens modifiés…).
 * La clé doit avoir la permission « Actions » en lecture et écriture.
 */
export async function lancerVerification({ token, depot, branche = "main", series = [], collection = "mangas" }) {
  try {
    await appel(token, "POST", `/repos/${depot}/actions/workflows/parutions.yml/dispatches`, {
      ref: branche,
      inputs: { collection, ...(series.length ? { series: series.join(",") } : {}) },
    });
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      const err = new Error("Ta clé d'accès ne peut pas lancer la vérification. Sur GitHub, modifie la clé et ajoute la permission « Actions » en lecture et écriture (Read and write).");
      err.status = e.status;
      err.droits = true;
      throw err;
    }
    throw e;
  }
}
