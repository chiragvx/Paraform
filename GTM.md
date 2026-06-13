# GTM — ParaForm launch plan

> **Goal:** $5–10K USD/month. **Timeline:** live in 1 week (aggressive).
> **Product:** prompt → assembly from a verified parts library → one-click
> part swap → auto-fitted casing → printable STL. Web-only at launch.
> Drafted 2026-06-13.

## Positioning

AI-native assembly CAD for the mechatronics / maker vertical. Do **not**
sell "Fusion replacement" — sell the workflow no one else has:
*"Describe a robot, get a printable assembly with a fitted case."*
The 75-second demo of assemble → swap-the-servo → casing auto-updates →
download STL **is** the entire marketing message.

## What's missing for revenue (build order)

1. **Billing** — nothing charges money today. **Stripe** (Checkout +
   billing portal + webhook). Checkout → webhook → `plan` column in
   Supabase ('free'/'paid') → caps lift.
2. **Auth gate + usage caps** — Supabase client exists (`lib/cloud.js`,
   local-first sync) but the AI proxy and kernel are open. Gate the studio
   behind Supabase email/Google auth; session token required by
   `/ai/chat` and `/execute`; hard caps per user/day (N AI messages,
   N compiles).
3. **Kernel security** — `/execute` accepts Python from the client =
   RCE on a public deploy. Emitted code must come only from the
   server-side emit path, and the kernel container is a disposable
   sandbox: no secrets, no network egress, 30 s execution timeout.
4. **Landing page + demo video** — record once, cut 3 GIFs from it.
   Landing = video + pricing + signup, nothing more.
5. **Human end-to-end dogfood** — 5 full builds through the chat UI
   (assemble → swap → casing → STL in a slicer screenshot). PLAN.md still
   lists this as unproven.

## 7-day plan

| Day | Deliverable |
|---|---|
| 1 | Merge branch → main. Supabase auth gating studio + AI proxy + kernel. Per-user daily caps. |
| 2 | Stripe checkout + billing portal + webhook → plan flag in Supabase ('free'/'paid'). |
| 3 | Deploy: frontend on Vercel; kernel on Fly.io/Railway (~$25–50/mo, one always-on worker; HF Spaces playbook in `paraform-engine/DEPLOY_HUGGINGFACE.md` as free-tier overflow). Sandbox the kernel container. |
| 4 | Record the 75-second hero video; cut GIFs; ship the landing page. |
| 5 | Dogfood 5 builds end-to-end as a stranger would; fix only what breaks; verify STL prints clean in a slicer. |
| 6 | Soft launch: X build-in-public thread, r/3Dprinting, r/robotics, r/functionalprint, maker Discords; DM 20 robotics-kit YouTubers/educators with free Pro. |
| 7 | Show HN ("Show HN: Describe a robot, get a printable assembly with a fitted case") + Product Hunt. |

## Pricing

Two tiers, processed by **Stripe** (Checkout + billing portal + webhook):

- **Free:** 15 AI generations/day, 60 compiles/day, full studio,
  STL/STEP export.
- **Pro — $9.99/month:** 200 AI generations/day, 1000 compiles/day,
  priority compiles.

**Honest math:** recurring $5K/mo needs ~500 Pro subscribers at $9.99 —
a month-2/3 goal. COGS per user is low (Gemini Flash pennies/session +
kernel CPU-seconds), so margins survive aggressive pricing.

## Scope cuts (ship without these)

| Cut | Why safe |
|---|---|
| Tauri desktop build | Web-only launch; desktop is a v2 upsell |
| Anthropic provider polish | Gemini Flash default works and is cheap |
| Legacy `app/` frontend retirement | Invisible to users |
| Redis / multi-worker kernel | One beefy worker + queue covers first 50 users |
| Casing v1 gaps (non-Z connector axes, corner bosses) | Label casing "beta" |
| 3D articulation drag gizmo | Sliders already work |
| STEP-insert, reparenting, headless `measure` | Nobody notices at launch |
| Library growth past current set | Verified set covers arm/gimbal/frame demos |

## Library policy (decided, partially done)

- **No bulk import from McMaster/GrabCAD/TraceParts** — licensing
  prohibits redistribution in a paid product; parametric self-made parts
  are the asset, not debt (connectors are what make assembly work and
  imported CAD has none).
- ✅ Hero-part fidelity pass done (servo mount holes, hex screw sockets,
  horn arm holes, nut chamfers) — bbox tests stay green (44/44).
- ✅ Studio shows only verified-geometry parts (74 of 105; placeholder
  brackets/misc/pulleys/rails/washers/composites hidden behind the
  `_unverified` gate in `src/lib/library/index.js`; AI `search_library`
  filtered too).
- Later: promote a family back by giving it real geometry and removing
  its filename from `_UNVERIFIED_FILES`.

## Status log

- 2026-06-13 — plan drafted; hero parts upgraded; library visibility gate
  shipped; trackpad + ViewCube camera UX shipped; connector-overlay
  offset investigated (current code verified consistent; was stale-doc
  artifact) + 2 bugs fixed (drop auto-select ReferenceError, unassigned
  viewport/bridge globals).
- Next unstarted GTM item: **Day 1 — auth gate + caps.**
