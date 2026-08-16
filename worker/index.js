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

async function appendFeature(env, feature) {
  const filePath = env.FILE_PATH || "data/registrations_all.geojson";
  const branch = env.GITHUB_BRANCH || "main";
  const getPath = `/repos/${env.GITHUB_REPO}/contents/${filePath}?ref=${branch}`;

  // Read-modify-write, retried a few times in case two saves race and
  // the second PUT's sha goes stale.
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

    current.features.push(feature);
    const newContent = utf8ToBase64(JSON.stringify(current, null, 2) + "\n");

    const putResp = await githubRequest(env, `/repos/${env.GITHUB_REPO}/contents/${filePath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Lisa ${{ hundilipud: "hundilipud", presence: "sisenemine" }[feature.properties.feature_type] || "jälg"} (grupp ${feature.properties.group_code})`,
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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "jaljed-api" }, 200, env);
    }

    if (request.method === "POST" && url.pathname === "/save") {
      if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
        return json({ ok: false, error: "Worker is not configured (missing GITHUB_TOKEN/GITHUB_REPO)." }, 500, env);
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ ok: false, error: "Invalid JSON body." }, 400, env);
      }
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

    return json({ ok: false, error: "Not found." }, 404, env);
  },
};
