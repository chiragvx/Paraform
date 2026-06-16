# Session log — AI code editor for build123d

**Date:** 2026-06-15
**Branch:** `main`
**Topic:** Let the AI write & build 3D models with raw build123d code, alongside the existing typed-tool surface.
**Commits:** `a2ee002` (compile cache), `ac31697` (AI code editor)

---

## 1. The questions asked

1. *"Did we design the code editor for build123d for AI to write and build objects?"*
2. *"We need to add a code editor where the AI can easily code and make 3D models… and also use the tool calling thing. First commit the changes so far and then start planning. Look through the app and make sure it fits perfectly. If it exists, use it properly!"*
3. *"How do I access the code editor?"*
4. *"Save to memory and keep a log of this conversation."*

## 2. What we found (before building)

- The studio already had a **human** code editor (`src/lib/components/studio/CodeEditorDialog.svelte`) backed by a first-class `BuildScript` feature type (ops `addBuildScript`/`updateBuildScript`).
- The **AI** could *not* write code — its system prompt literally said *"you never write Python."* It was an agent over ~70 typed ops; raw code was deliberately off-limits as the safety rail.
- Two real gaps surfaced:
  - **`BuildScript` rendered nothing.** It was excluded from `leafIds` in `emit.js` and never bound its output to a body var — a script ran but produced no visible geometry.
  - **The kernel had no sandbox.** `exec(code, namespace)` ran with full builtins (`harness.py`) — a human could already run arbitrary Python; letting the AI author code widened the blast radius (esp. on a shared/hosted kernel).

## 3. Decisions (chosen by the user)

| Decision | Choice |
|---|---|
| Execution safety for AI-authored code | **Full kernel sandbox first** (not just a client-side guard) |
| Feature model | **Reuse `BuildScript` + fix its render gap** (not a new feature type) |

## 4. What was built

### Commit `a2ee002` — 2-tier compile cache (pre-existing work, committed first)
Content-addressed result cache: client executor LRU + server `/execute` LRU, keyed on emitted code + tessellation deflection. Redundant compiles (undo/redo, param toggles, metadata-only commits, reopen) replay from cache instead of re-running OCCT.

### Commit `ac31697` — AI code editor

**Design seam:** the `BuildScript` emitter emits `n_<id> = _bs_run(<code>, <label>)`. `_bs_run` is a kernel helper that execs the (untrusted) script in a restricted sandbox and returns its `result` variable (or `None` for helper-only scripts). `BuildScript` joined `leafIds` so a non-`None` result renders.

- **Kernel sandbox** (`b123d_server/harness.py`): `_bs_run` runs script code in restricted globals — guarded `__import__` (allowlist: build123d/math/numpy + pure stdlib; `os`/`sys`/`subprocess`/`socket`/… raise `ImportError`), curated builtins (no `open`/`eval`/`exec`/`compile`/`getattr`), wall-clock timeout. Trusted typed-op emit keeps its full-builtins path.
- **Render fix** (`lib/document/emit.js`): new `BuildScript` handler + removed from the `leafIds` exclusion. Helper-only scripts (`None`) are skipped by the kernel's existing None-guards.
- **AI tool surface** (`src/lib/ai/tools_code.js`): `writeBuildScript` / `editBuildScript`, wired into `tools.js`; `BuildScript` added to `BODY_EMITTING`.
- **Static pre-check** (`src/lib/ai/script_guard.js`): fast model-facing blocklist mirroring the kernel (the kernel sandbox is the real boundary).
- **System prompt** (`src/lib/ai/system_prompt.js`): carved out a "Dropping to code (last resort)" escape hatch — typed ops stay the default; verify/look rules untouched.
- **Default snippets** (`operations.js`, `CodeEditorDialog.svelte`): updated to teach the `result =` contract (scripts now run in isolated globals; only `result` renders).

### Files changed
```
b123d_server/harness.py                         (sandbox _bs_run)
lib/document/emit.js                            (BuildScript handler + leaf)
lib/document/operations.js                      (default snippet)
lib/document/__tests__/emit.mjs                 (BuildScript test suite)
lib/document/__tests__/all.mjs                  (register code-tools test)
src/lib/ai/tools.js                             (wire CODE_TOOLS + BODY_EMITTING)
src/lib/ai/system_prompt.js                     (escape hatch)
src/lib/ai/tools_code.js                        (new — write/editBuildScript)
src/lib/ai/script_guard.js                      (new — static pre-check)
src/lib/ai/__tests__/code_tools.test.mjs        (new)
src/lib/components/studio/CodeEditorDialog.svelte (snippet + description)
b123d_server/__tests__/test_buildscript_sandbox.py (new — UNTRACKED, dir is gitignored)
```

## 5. Verification

- Full JS suite (`npm test`): green; new emit + AI-tool tests pass.
- Python: sandbox tests 23/23; `test_component_meshes` + `test_execute_cache` 13/13.
- **End-to-end:** an emitted `BuildScript` program rendered a real **4476-byte GLB** through the kernel.
- **Security:** a malicious `import os` script returned `ok=False` with the blocked-import error (which the agent's self-repair loop surfaces).

## 6. How to access the code editor

The editor is hidden by the **V1 launch flag** (`src/lib/flags.js`; `V1` is on unless `VITE_FULL_UI=1`).

- **Via the AI (default build):** ask the assistant to build with code → it calls `writeBuildScript`. The script appears in the feature tree; **double-click** its row or **right-click → Edit…** to open the editor (these edit paths are not V1-gated). Needs a provider API key in Settings → AI.
- **Manual create:** run `npx cross-env VITE_FULL_UI=1 VITE_ENGINE_URL=http://localhost:7823 vite` (kernel via `npm run kernel`). Then: Toolbar "New Script", feature-tree "New script", or command palette "New Script…".

## 7. Known limitations / possible follow-ups

- Sandbox is defense-in-depth, **not a perfect jail**: abandons (can't force-kill) a CPU-bound thread; no hard memory cap. For the hosted kernel, a container with cgroup limits is the production boundary.
- Nothing exercised in a **live browser chat turn** yet (tools are unit-tested + verified end-to-end at the kernel).
- Edge case: a helper-only (no `result`) script owned by a **non-root component** would crash on placement — documented; normal cases all work.
- Possible niceties: a `dev:full` npm script; un-gate the script editor in V1; surface a "view code" chip in chat when the AI writes a script.

## 8. Memory written this session

- `project_ai_code_editor.md` — the capability, sandbox design, render fix, V1 access gotcha.
- `project_python_tests_gitignored.md` — `b123d_server/__tests__/` is gitignored; kernel pytest runs locally, never commits.
