# Deploy ParaForm Engine to Hugging Face Spaces (free)

Step-by-step. ~15 min, no credit card.

## Why Hugging Face Spaces

- **Truly free** — 16 GB RAM, 2 vCPU on the CPU Basic tier
- **Docker SDK** — full control over OCP/build123d native deps
- **Always-on while active** — sleeps only after ~48 h of idle (one HTTP call wakes it)
- **Public HTTPS URL** with stable subdomain
- **CORS-friendly** (FastAPI middleware already handles it)

Alternative free hosts (Render, Fly.io, Railway) all have stricter limits
for native-extension Docker images. HF Spaces wins for this stack.

---

## Step 1 — Make a Hugging Face account

1. Go to https://huggingface.co/join
2. Sign up (email or GitHub SSO — GitHub is faster)
3. Verify email
4. Pick a username — this becomes part of your Space URL.
   e.g. username `udit` → `https://udit-paraform-engine.hf.space`

## Step 2 — Create the Space

1. Click your avatar → **New Space**
2. Fill in:
   - **Owner:** your username
   - **Space name:** `paraform-engine` (lowercase, dashes only)
   - **License:** MIT
   - **Select the Space SDK:** **Docker** → **Blank**
   - **Hardware:** **CPU basic** (free)
   - **Public** (private also works on free tier, but public is simpler for testing)
3. Click **Create Space**

You now have an empty repo at:
```
https://huggingface.co/spaces/<username>/paraform-engine
```

## Step 3 — Push the engine code

There are two ways. Pick one.

### Option A — Web UI (easiest, no git)

1. On your Space page, click the **Files** tab
2. Click **Add file → Upload files**
3. Drag the entire contents of `paraform-engine/` into the upload area:
   - `Dockerfile`
   - `requirements.txt`
   - `README.md`
   - `.gitignore`
   - `app/__init__.py`
   - `app/main.py`
   - `app/execute.py`
   - `app/harness.py`
4. Commit message: `initial commit`
5. Click **Commit changes to main**

**Note:** the `README.md` must be at the repo root — it carries the YAML
frontmatter that tells HF Spaces to use Docker SDK and port 7860.

### Option B — Git CLI (cleaner)

```bash
# From your machine
cd paraform-engine

# Get an HF access token: https://huggingface.co/settings/tokens
# Create one with WRITE scope, copy it

git init
git add .
git commit -m "initial commit"

# Use your username and the token (token replaces password)
git remote add space https://huggingface.co/spaces/<username>/paraform-engine
git push space main
# When prompted: username = <your hf username>, password = <the token>
```

## Step 4 — Wait for the build

1. On the Space page, the top will show **Building**
2. Click **Logs** to watch the Docker build
3. First build: **5–8 minutes** (downloading OCP wheel is ~120 MB)
4. When it flips to **Running**, click the **App** tab
5. You should see the ParaForm Engine status page

### Common build errors

- **"No module named build123d"** — wheel install failed. Check Logs for the
  pip error. Usually a transient PyPI issue; click **Restart this Space**.
- **"libGL.so.1 not found"** — should not happen with our Dockerfile (we
  install `libgl1`). If it does, edit the Dockerfile to add the missing lib.
- **Build timeout (>15 min)** — HF Spaces has a build cap. If the OCP
  download is the culprit, retry; the wheel is cached after the first
  successful build.

## Step 5 — Verify the engine

In a browser, hit:

```
https://<username>-paraform-engine.hf.space/health
```

Expected response:
```json
{ "ok": true, "build123d_version": "0.8.0", "service": "paraform-engine" }
```

Then try the smoke test (returns a real glb of a filleted box):
```
https://<username>-paraform-engine.hf.space/smoke
```

If your browser downloads a `.glb` file, the backend is working.

## Step 6 — Connect ParaForm frontend

1. Open ParaForm with b123d mode active:
   `http://localhost:5173/?engine=b123d`
2. In the bottom status bar, find **⚠ Mock engine** and click the **⚙** icon next to it
3. Paste your engine URL:
   `https://<username>-paraform-engine.hf.space`
4. Hit OK. The badge should flip to `● <your-space>.hf.space`
5. Make any edit (drag a slider in the Inspector). The tree re-executes
   against your HF Space, downloads the glb, and renders the real BREP
   geometry in the viewport.

The URL is persisted in `localStorage` so you only set it once.

## Step 7 (optional) — Wake the Space

HF Spaces sleeps after ~48 h of no requests. To keep it warm during active
development, add this to a cron / Task Scheduler:

```bash
curl -s https://<username>-paraform-engine.hf.space/health > /dev/null
```

Every 6 hours is plenty.

## Iterating on the backend

1. Edit files in `paraform-engine/`
2. Push to the Space (web UI or git)
3. HF auto-rebuilds (~1–2 min for code-only changes, deps cached)
4. Frontend keeps working — no client changes needed

## Cost & quotas

- **CPU**: free, unlimited
- **RAM**: 16 GB
- **Storage**: 50 GB free
- **Egress**: unmetered for public Spaces
- **Concurrent requests**: shared CPU — fine for ~5 simultaneous users

When you outgrow this:
- Pin to **CPU Upgrade** ($0.03/hr) for dedicated 8 vCPU / 32 GB
- Or migrate the Docker image to Google Cloud Run / Fly.io / your laptop

## Troubleshooting

| Symptom | Fix |
|---|---|
| Status bar still says "Mock engine" after setting URL | Hard refresh (Ctrl+Shift+R); check the URL has no trailing slash |
| `/health` 200 but `/execute` returns CORS error in browser | The CORSMiddleware allows `*`. If you have a custom CSP, ensure your frontend can reach `hf.space` |
| `/execute` times out (>30s) | First request to a sleeping Space is cold-start (5–10 s). Hit `/health` once to warm it. |
| `/execute` returns 400 "No build123d bodies produced" | Your tree is empty or the last node didn't yield a Part. Check the Generated Code in Inspector. |
| Glb downloads but viewport stays empty | Check browser DevTools console for adapter errors. Confirm the host's Three.js scene is on `window.__PARAFORM_VIEWPORT__`. |

That's it. You now have a real build123d backend that the b123d-mode
frontend can drive.
