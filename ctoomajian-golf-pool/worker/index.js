/**
 * Backend for the golf pool site. Two jobs:
 *  1. Proxy ESPN's golf JSON endpoints (adds CORS -- browsers can't call
 *     ESPN directly).
 *  2. A tiny key/value API backed by Workers KV, replacing what
 *     window.storage did inside the old Claude-artifact version.
 *
 * Requires a KV namespace bound as POOL_KV (see wrangler.toml) and a
 * secret WRITE_KEY (see setup instructions) that gates writes only --
 * reads stay open so the leaderboard is viewable without it.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // --- ESPN proxy ---
    if (url.pathname.startsWith("/apis/site/v2/sports/golf/")) {
      const target = "https://site.api.espn.com" + url.pathname + url.search;
      const espnResponse = await fetch(target, { headers: { Accept: "application/json" } });
      const body = await espnResponse.text();
      return new Response(body, {
        status: espnResponse.status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // --- KV storage API ---
    if (url.pathname.startsWith("/api/kv/")) {
      const key = decodeURIComponent(url.pathname.slice("/api/kv/".length));
      if (!key) return json({ error: "missing key" }, 400);

      if (request.method === "GET") {
        const value = await env.POOL_KV.get(key);
        if (value === null) return json({ error: "not found" }, 404);
        return json({ value });
      }

      if (request.method === "PUT") {
        const apiKey = request.headers.get("X-Api-Key");
        if (!env.WRITE_KEY || apiKey !== env.WRITE_KEY) {
          return json({ error: "unauthorized" }, 401);
        }
        const body = await request.json().catch(() => null);
        if (!body || typeof body.value !== "string") {
          return json({ error: "expected { value: string }" }, 400);
        }
        await env.POOL_KV.put(key, body.value);
        return json({ ok: true });
      }

      return json({ error: "method not allowed" }, 405);
    }

    return new Response("Not found", { status: 404 });
  },
};
