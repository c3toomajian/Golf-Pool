# ctoomajian golf pool

A real, standalone version of the golf pool app -- no Claude sandbox restrictions,
your own domain if you want one, auto-deploys whenever you push changes.

## Multiple pools

The site supports any number of separate pools -- one per friend group, per
tournament. Visiting the bare URL shows a picker: a list of every pool
created so far, plus a box to start a new one. Creating a pool gives you a
link like `?pool=college-friends-us-open-4x9k` to send to that specific
group; their picks, leaderboard, and settings are completely separate from
any other pool's. Old pools stay in the list indefinitely, so past
tournaments remain browsable rather than getting overwritten by the next one.

Each pool can optionally get its own password at creation time -- separate
from every other pool's, and separate from the Setup passcode (which only
gates the tournament/payout settings *within* a pool you're already in, not
entry to the pool itself). Leave it blank for an open pool. This is a light
deterrent, not real security -- someone inspecting network requests in dev
tools could read it directly from the API. Once entered correctly on a
device, that browser won't be asked again for that pool.

## What's in here

- `src/` -- the React app (picks, leaderboard, setup, all the same logic as before)
- `worker/index.js` -- the Cloudflare Worker backend: proxies ESPN (so the browser
  isn't blocked by CORS) and stores picks/settings in Cloudflare KV (replacing
  `window.storage`, which only exists inside Claude artifacts)
- `wrangler.toml` -- reference config if you ever want to deploy the Worker via
  the command line instead of the dashboard (not required for the steps below)

## Setup, start to finish

### 1. Put this code on GitHub

1. Go to `github.com`, sign in (or create a free account).
2. Click the `+` in the top right -> **New repository**. Name it whatever you
   like (e.g. `golf-pool`), leave it public or private, don't add a README --
   click **Create repository**.
3. On the empty repo's page, click **uploading an existing file**.
4. Drag the entire contents of this project folder (everything except
   `node_modules` and `dist`, which don't exist yet anyway) into the upload area.
5. Scroll down, click **Commit changes**.

No git command line needed -- the web upload does the same thing.

### 2. Create the KV namespace (where picks/settings get stored)

1. In the Cloudflare dashboard, go to **Workers & Pages** -> **KV** (left sidebar).
2. Click **Create a namespace**. Name it `golf-pool-kv`. Create.

### 3. Deploy the Worker (backend)

1. **Workers & Pages** -> **Create** -> **Create Worker** -> **Start with Hello World!**
2. Name it something like `ctoomajian-golf-pool-api`. Deploy.
3. Click **Edit code**, select all, delete, and paste in the full contents of
   `worker/index.js` from this project. Deploy.
4. Go to that worker's **Settings** tab -> **Bindings** -> **Add binding** ->
   **KV Namespace**. Variable name: `POOL_KV`. Namespace: the `golf-pool-kv`
   you created in step 2. Save.
5. Same **Settings** tab -> **Variables and Secrets** -> **Add** -> type
   **Secret**, name `WRITE_KEY`, value: pick a password (reusing `PercivalToots`
   is fine, or choose something else). Save and deploy.
6. Copy this worker's URL (top of its overview page) -- something like
   `https://ctoomajian-golf-pool-api.yourname.workers.dev`. You'll need it next.

### 4. Deploy the site (frontend) via Cloudflare Pages

1. **Workers & Pages** -> **Create** -> **Pages** tab -> **Connect to Git**.
2. Authorize Cloudflare to access your GitHub, select the repo from step 1.
3. Build settings: **Build command** = `npm run build`, **Build output
   directory** = `dist`.
4. Before deploying, add environment variables (there's a section for this
   on the same setup screen, or under Settings -> Environment Variables after):
   - `VITE_WORKER_URL` = the Worker URL you copied in step 3.6
   - `VITE_WRITE_KEY` = the same value you set for `WRITE_KEY` in step 3.5
5. Click **Save and Deploy**. Cloudflare will build and give you a live URL
   like `ctoomajian-golf-pool.pages.dev` -- that's a fully working site already.

From now on, any time this GitHub repo's code changes, Cloudflare Pages
automatically rebuilds and redeploys -- no manual steps.

### 5. (Optional) Your own domain

1. **Workers & Pages** (or the main dashboard) -> **Domain Registration** ->
   search `ctoomajian.com`, buy it (~$10-11/year, Cloudflare's cost, no markup).
2. In your Pages project -> **Custom domains** -> **Set up a custom domain**.
   Enter `ctoomajian.com` (or a subdomain like `golf.ctoomajian.com` if you'd
   rather keep the root free for something else). Cloudflare handles the
   SSL certificate automatically.

## Making changes later

Edit the code (ask me, or edit it yourself), update the files in the GitHub
repo (web upload again, or `git push` if you ever set up git locally), and
Cloudflare Pages redeploys automatically within a minute or two.
