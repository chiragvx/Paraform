---
title: ParaForm Kernel
emoji: 🔩
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: build123d CAD kernel + AI proxy for the ParaForm studio
---

# ParaForm Kernel (b123d_server)

The Flask backend the ParaForm **studio** talks to. This is the real kernel —
build123d geometry execution, measurement, the standard-parts library, the
server-side AI proxy, and (optional) Stripe billing.

> Not to be confused with `paraform-engine/`, an older geometry-only FastAPI
> service that lacks `/ai/*`, `/billing/*`, `/measure`, and the v4 GLB+topology
> contract the current studio needs. **Deploy this one.**

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/health` | liveness + build123d version |
| GET  | `/version` | kernel version + pin mismatches |
| POST | `/execute` | run feature-tree code → GLB + topology |
| POST | `/measure` | queries against the last `/execute` |
| GET  | `/library`, `/library/<id>` | standard-parts catalog + GLB |
| POST | `/ai/chat`, GET `/ai/health` | server-side AI proxy |
| GET  | `/billing/me`, POST `/billing/{checkout,portal,webhook}` | Stripe billing (optional) |

`CORS(origins="*")` is on, so a browser studio on any origin can reach it.

## Configuration (HF Space → Settings → Variables and secrets)

Everything is optional — with nothing set the kernel still runs (geometry
works; AI + billing degrade gracefully to "not configured"):

| Secret | Enables |
|---|---|
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` | the AI assistant (`/ai/chat`). Use an OpenRouter key + `https://openrouter.ai/api/v1`. |
| `GEMINI_API_KEY` | the Gemini provider |
| `REQUIRE_AUTH=1` + `VITE_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Supabase auth + per-day caps |
| `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + `STRIPE_PRICE_ID` + `APP_URL` | the Pro ($9.99/mo) plan |

## Run locally

```bash
pip install -r requirements.txt
python server.py 7823          # → http://localhost:7823
```

Full deploy walkthrough: see [`DEPLOY_HUGGINGFACE.md`](./DEPLOY_HUGGINGFACE.md).
