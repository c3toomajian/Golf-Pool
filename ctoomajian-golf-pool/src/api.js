// Talks to the Cloudflare Worker that backs this app -- both the ESPN proxy
// and the small KV-based storage that replaces window.storage (which only
// exists inside Claude artifacts, not a real hosted site).
//
// The Worker URL is baked in at build time via the VITE_WORKER_URL env var,
// set in Cloudflare Pages' build settings.

// The Worker URL and write key are baked in at build time via env vars,
// set in Cloudflare Pages' build settings. The write key isn't a strong
// secret (it ships in the built JS bundle, same tradeoff as the old Setup
// passcode) -- it just stops a random person who finds the Worker URL from
// posting garbage into the KV store without going through the site at all.
const WORKER_URL = import.meta.env.VITE_WORKER_URL || "";
const WRITE_KEY = import.meta.env.VITE_WRITE_KEY || "";

async function request(path, options = {}) {
  if (!WORKER_URL) {
    throw new Error("VITE_WORKER_URL isn't set -- add it in Cloudflare Pages build settings.");
  }
  const res = await fetch(`${WORKER_URL}${path}`, options);
  if (!res.ok && res.status !== 404) {
    throw new Error(`Worker returned ${res.status}`);
  }
  return res;
}

export async function kvGet(key) {
  const res = await request(`/api/kv/${encodeURIComponent(key)}`);
  if (res.status === 404) return null;
  const data = await res.json();
  return data.value;
}

export async function kvSet(key, value) {
  await request(`/api/kv/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Api-Key": WRITE_KEY },
    body: JSON.stringify({ value }),
  });
}

export async function espnScoreboard() {
  const res = await request(`/apis/site/v2/sports/golf/pga/scoreboard`);
  return res.json();
}

export async function espnSummary(eventId) {
  const res = await request(`/apis/site/v2/sports/golf/pga/summary?event=${encodeURIComponent(eventId)}`);
  return res.json();
}
