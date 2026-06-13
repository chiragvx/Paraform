# Deploy the ParaForm kernel (b123d_server) to Hugging Face Spaces

Step-by-step, ~15 min, free, no credit card. This stands up the backend your
deployed studio actually calls (`/execute`, `/measure`, `/ai/chat`,
`/billing/me`, the library) at a **stable HTTPS URL** — replacing the dead
Cloudflare quick-tunnel.

> **Why not a `cloudflared` quick-tunnel?** Those URLs are random and die when
> the process stops — which is exactly why the app broke. An HF Space gives a
> permanent subdomain that survives restarts.

---

## Step 1 — Hugging Face account

1. https://huggingface.co/join (GitHub SSO is fastest).
2. Your username becomes part of the URL, e.g. `udit` →
   `https://udit-paraform-kernel.hf.space`.

## Step 2 — Create the Space

1. Avatar → **New Space**.
2. **Space name:** `paraform-kernel` (lowercase, dashes).
3. **SDK:** **Docker** → **Blank**. **Hardware:** **CPU basic** (free).
4. **Create Space**. You get an empty repo at
   `https://huggingface.co/spaces/<username>/paraform-kernel`.

## Step 3 — Push the kernel code

**Critical:** push only the `b123d_server/` *contents* (the `README.md` with
the Docker frontmatter must be at the Space repo root). The `.gitignore` here
already excludes `build/` (631 MB of PyInstaller output) — do **not** let that
get pushed.

### Option A — git CLI (cleanest)

```bash
cd b123d_server

# Get a WRITE token: https://huggingface.co/settings/tokens
git init
git add .                       # .gitignore drops build/, dist/, __pycache__
git commit -m "ParaForm kernel"
git remote add space https://huggingface.co/spaces/<username>/paraform-kernel
git push space main             # username = <hf user>, password = <token>
```

### Option B — web upload

Files tab → **Add file → Upload files** → drag the contents of `b123d_server/`
**except** `build/`, `dist/`, `__pycache__/`, `__tests__/`. Must include:
`Dockerfile`, `README.md`, `requirements.txt`, `server.py`, `harness.py`,
`measure.py`, `naming.py`, `ai_proxy.py`, `auth_gate.py`, `billing.py`,
`VERSIONS.json`, and the whole `standard_parts/` folder.

## Step 4 — Set secrets (Space → Settings → Variables and secrets)

All optional, but for the AI assistant to work add at minimum:

| Secret | Value |
|---|---|
| `OPENAI_API_KEY` | your OpenRouter key (`sk-or-v1-…`) |
| `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` |

Add `GEMINI_API_KEY` for the Gemini provider. Leave Supabase/Stripe unset to
run open + free-only. (Changing secrets triggers a rebuild.)

## Step 5 — Wait for the build

Logs tab shows the Docker build. First build is **5–8 min** (the OCP wheel is
big). When it flips to **Running**, verify:

```
https://<username>-paraform-kernel.hf.space/health
→ { "ok": true, "server": "paraform-b123d", "build123d_version": "0.10.0" }
```

If the build fails on `build123d==0.10.0` (wheel/native mismatch), check the
log and adjust the pin in `requirements.txt` (e.g. `0.9.1`) — `VERSIONS.json`
expects 0.10.0, so a mismatch only triggers a non-fatal version warning in the
studio.

## Step 6 — Point the studio at it

Pick ONE. The URL is `https://<username>-paraform-kernel.hf.space` (no
trailing slash).

- **Recommended — Vercel build env:** Vercel project → Settings → Environment
  Variables → add `VITE_ENGINE_URL = https://<username>-paraform-kernel.hf.space`
  → **Redeploy**. (Vite inlines it at build time.) Nothing in source.

- **Or — runtime override in `index.html`:** uncomment the
  `window.__PARAFORM_ENGINE_URL__` line (top of `index.html`) and paste the URL.
  Works without touching Vercel env, but the URL lives in source.

Local dev is unaffected either way — on `localhost` the studio always targets
`http://localhost:7823` (`npm run kernel`).

## Step 7 (optional) — keep it warm

HF Spaces sleep after ~48 h idle (a request wakes it, ~5–10 s cold start). To
avoid cold starts during active use, ping `/health` on a schedule:

```bash
curl -s https://<username>-paraform-kernel.hf.space/health > /dev/null
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Studio console still hits the old URL | You set `VITE_ENGINE_URL` but didn't **redeploy** Vercel, or the `index.html` global still has a value. Hard-refresh. |
| `/ai/chat` → 503 "not configured" | `OPENAI_API_KEY` / `OPENAI_BASE_URL` not set as Space secrets. |
| `/execute` first call slow / times out | Cold start — hit `/health` once to warm it. |
| `/billing/me` → 404 | Expected if billing isn't configured; the studio falls back to free plan. |
| Build > 15 min (HF cap) | Usually the OCP download — restart the Space; the wheel caches after one success. |
