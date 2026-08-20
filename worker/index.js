/**
 * Jäljed — write API
 * ------------------------------------------------------------------
 * GitHub Pages is static and cannot accept writes on its own. This
 * tiny Worker is the one piece of "real server" in the whole project:
 * it receives a new GeoJSON Feature from the app, reads the current
 * data/registrations_all.geojson straight out of the GitHub repo,
 * appends the feature, and commits the file back — via GitHub's own
 * Contents API, using a token that lives only here, never in the
 * browser. Every device reads the same file straight off GitHub
 * Pages and writes through this same endpoint, so there is exactly
 * one shared dataset and nothing is ever saved locally.
 *
 * Required environment variables (set in the Cloudflare dashboard or
 * via `wrangler secret put` / wrangler.toml — see README.md):
 *   GITHUB_TOKEN     fine-grained PAT, Contents: Read and write, scoped
 *                    to this one repo only
 *   GITHUB_REPO      e.g. "rivopolt/hunt"
 *   GITHUB_BRANCH    e.g. "main" (whatever GitHub Pages serves from)
 *   FILE_PATH        e.g. "data/registrations_all.geojson"
 *   ALLOWED_ORIGIN   e.g. "https://rivopolt.github.io" (or "*")
 */

const GITHUB_API = "https://api.github.com";

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

// btoa/atob that behave correctly with UTF-8 (Estonian diacritics etc.)
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function base64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function isValidFeature(f) {
  if (!f || f.type !== "Feature" || !f.properties) return false;
  const ft = f.properties.feature_type;
  if (!["track", "hundilipud", "presence"].includes(ft)) return false;
  if (typeof f.properties.group_code !== "string" || !/^\d{4}$/.test(f.properties.group_code)) return false;

  // "presence" is a lightweight once-a-day device ping used only for the
  // group statistics panel — it has no location, so geometry is null.
  if (ft === "presence") {
    return f.geometry === null || f.geometry === undefined;
  }
  if (!f.geometry || !["Point", "LineString"].includes(f.geometry.type)) return false;
  if (!Array.isArray(f.geometry.coordinates)) return false;
  return true;
}

async function githubRequest(env, path, options = {}) {
  const resp = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "jaljed-worker",
      ...(options.headers || {}),
    },
  });
  return resp;
}

// Finds a feature by (registered_at, group_code) — registered_at is a
// full-precision ISO timestamp set at creation time, so together with
// the group code it's effectively a unique key without needing to add
// or backfill a separate "id" field on every existing feature.
function findFeatureIndex(features, match) {
  return features.findIndex(f =>
    f.properties &&
    f.properties.registered_at === match.registered_at &&
    f.properties.group_code === match.group_code
  );
}

// Generic read-modify-write against the shared data file, retried a few
// times in case two writes race and the second PUT's sha goes stale.
// `mutate(features)` mutates the array in place and returns a short
// commit-message fragment; throw inside it to abort with an error.
async function mutateDataFile(env, mutate) {
  const filePath = env.FILE_PATH || "data/registrations_all.geojson";
  const branch = env.GITHUB_BRANCH || "main";
  const getPath = `/repos/${env.GITHUB_REPO}/contents/${filePath}?ref=${branch}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const getResp = await githubRequest(env, getPath);
    if (!getResp.ok) {
      const text = await getResp.text();
      throw new Error(`GitHub read failed (${getResp.status}): ${text}`);
    }
    const meta = await getResp.json();
    const current = JSON.parse(base64ToUtf8(meta.content));
    if (current.type !== "FeatureCollection" || !Array.isArray(current.features)) {
      throw new Error("Server file is not a valid FeatureCollection.");
    }

    const commitMessage = mutate(current.features);
    const newContent = utf8ToBase64(JSON.stringify(current, null, 2) + "\n");

    const putResp = await githubRequest(env, `/repos/${env.GITHUB_REPO}/contents/${filePath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: commitMessage,
        content: newContent,
        sha: meta.sha,
        branch,
      }),
    });

    if (putResp.ok) {
      return { featureCount: current.features.length };
    }
    if (putResp.status === 409 || putResp.status === 422) {
      // Someone else committed in between — retry with a fresh sha.
      continue;
    }
    const text = await putResp.text();
    throw new Error(`GitHub write failed (${putResp.status}): ${text}`);
  }
  throw new Error("Could not save after several attempts — too many concurrent writes. Try again.");
}

function commitLabel(feature) {
  return { hundilipud: "hundilipud", presence: "sisenemine" }[feature.properties.feature_type] || "jälg";
}

async function appendFeature(env, feature) {
  return mutateDataFile(env, features => {
    features.push(feature);
    return `Lisa ${commitLabel(feature)} (grupp ${feature.properties.group_code})`;
  });
}

async function updateFeature(env, match, newFeature) {
  return mutateDataFile(env, features => {
    const idx = findFeatureIndex(features, match);
    if (idx === -1) throw new Error("Kirjet ei leitud (võib-olla juba muudetud või kustutatud).");
    features[idx] = newFeature;
    return `Muuda ${commitLabel(newFeature)} (grupp ${newFeature.properties.group_code})`;
  });
}

async function deleteFeature(env, match) {
  return mutateDataFile(env, features => {
    const idx = findFeatureIndex(features, match);
    if (idx === -1) throw new Error("Kirjet ei leitud (võib-olla juba kustutatud).");
    const [removed] = features.splice(idx, 1);
    return `Kustuta ${commitLabel(removed)} (grupp ${match.group_code})`;
  });
}

function isValidMatch(m) {
  return m && typeof m.registered_at === "string" && typeof m.group_code === "string" && /^\d{4}$/.test(m.group_code);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "jaljed-api" }, 200, env);
    }

    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      if (request.method === "POST") {
        return json({ ok: false, error: "Worker is not configured (missing GITHUB_TOKEN/GITHUB_REPO)." }, 500, env);
      }
    }

    if (request.method === "POST" && url.pathname === "/save") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: "Invalid JSON body." }, 400, env); }
      const feature = body && body.feature;
      if (!isValidFeature(feature)) {
        return json({ ok: false, error: "Invalid or incomplete feature." }, 400, env);
      }
      try {
        const result = await appendFeature(env, feature);
        return json({ ok: true, ...result }, 200, env);
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) }, 502, env);
      }
    }

    if (request.method === "POST" && url.pathname === "/update") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: "Invalid JSON body." }, 400, env); }
      const match = body && body.match;
      const feature = body && body.feature;
      if (!isValidMatch(match)) return json({ ok: false, error: "Invalid match key." }, 400, env);
      if (!isValidFeature(feature)) return json({ ok: false, error: "Invalid or incomplete feature." }, 400, env);
      try {
        const result = await updateFeature(env, match, feature);
        return json({ ok: true, ...result }, 200, env);
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) }, 502, env);
      }
    }

    if (request.method === "POST" && url.pathname === "/delete") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: "Invalid JSON body." }, 400, env); }
      const match = body && body.match;
      if (!isValidMatch(match)) return json({ ok: false, error: "Invalid match key." }, 400, env);
      try {
        const result = await deleteFeature(env, match);
        return json({ ok: true, ...result }, 200, env);
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) }, 502, env);
      }
    }

    return json({ ok: false, error: `Not found: ${request.method} ${url.pathname}` }, 404, env);
  },
};

