# ParaForm MCP server — Claude connector

Connect **Claude** (Opus / Sonnet via your existing Claude subscription) to
ParaForm. **No Anthropic API key required** — Claude pays for inference; this
server just exposes ParaForm's build tools.

Two paths are supported. Pick whichever fits the user:

| Transport | Where it runs | User flow | Who it's for |
|---|---|---|---|
| **Remote MCP** (HTTP) | Hosted at your domain | Paste a URL into claude.ai → "Add custom connector" → done | **Anyone**, including non-developers, on **claude.ai web** or **Claude Desktop** |
| **stdio** | The user's own machine | Edit `claude_desktop_config.json` to spawn a local Node process | Developers running ParaForm locally |

If you're shipping a hosted product, the **Remote MCP** path is what most users
will see; the stdio path stays useful for local dev and offline use.

## What Claude can do over MCP

The server exposes every tool the in-studio chat agent has — `addBox`,
`addCylinder`, `addExtrude`, `addRevolve`, `addFillet`, `addChamfer`,
`addShell`, `addHole`, `addUnion`, `addCut`, `addIntersect`, `addLinearPattern`,
`addCircularPattern`, `addMirror`, `addStandardPart`, `placeLibraryPart`,
`replace_component`, `add_mate`, `add_casing`, `addDocumentParameter`,
`setDocumentParameter`, `setFeatureParams`, `deleteFeature`, `addComponent`,
`get_document_summary`, `list_components`, `search_library`, `measure`,
`run_invariants` — plus three ParaForm-only verbs that wrap the document store:

| Tool | What it does |
|---|---|
| `paraform_reset_document`  | Clears the workspace and starts a fresh document. |
| `paraform_save_document`   | Writes the in-memory document to a `.paraform.json` file you can open in the studio. |
| `paraform_load_document`   | Replaces the in-memory document with a saved `.paraform.json` so Claude can extend an existing build. |

## Remote MCP — paste-a-URL setup (claude.ai or Claude Desktop)

This is the user-friendly path. End-users do **nothing technical**: they paste
your public URL into Claude's "Add custom connector" popup and it works.

### For the end-user — one-time connector setup

1. Open **claude.ai** → Settings → **Connectors** → **Add custom connector**.
2. **Name**: `ParaForm`
3. **Remote MCP server URL**: `https://<your-host>/mcp`
4. Leave OAuth fields blank — v1 is anonymous, per-session, no login.
5. **Add**. You only do this once.

### Live editing — Claude builds, your studio updates in real time

1. Open the ParaForm studio.
2. Click **Connect Claude** in the chat panel header. A modal shows a 6-letter
   code (e.g. `QRMNZX`) and a one-line phrase to paste:
   *"Connect to ParaForm with code QRMNZX"*
3. Paste that line into your Claude chat. Claude calls `paraform_attach` and
   the modal flips to **"Claude is connected."**
4. Now ask Claude anything — *"build a bracket with a Ø12 boss"*. Every tool
   call mutates the **studio's live document** through SSE; the viewport
   updates as Claude works. You can keep editing in the studio alongside.

### Headless / no studio open

If you don't have the studio open, Claude builds into a private server-side
document instead. Ask Claude to save and `paraform_save_document` returns a
**download URL** — click it, `.paraform.json` downloads, open it in the
studio later (File → Open).

### For the operator (you) — deploy

The remote gateway is `mcp/remote_server.mjs`. It's a self-contained Node
service (built-in `node:http`, **zero runtime deps**) that spawns
`mcp/server.mjs` as a **child process per Claude session** — so every session
has its own isolated document store with no cross-session leak risk and no
refactor of the document layer.

```bash
node mcp/remote_server.mjs
# listens on PARAFORM_MCP_PORT (default 8080)
```

Environment:

| Var | Default | What it does |
|---|---|---|
| `PARAFORM_MCP_PORT` | `8080` | TCP port to listen on |
| `PARAFORM_MCP_PUBLIC_URL` | `http://localhost:<port>` | Absolute URL of this service, used in `paraform_save_document` download links. Set this to your public HTTPS URL in production (e.g. `https://paraform.app`). |
| `PARAFORM_MCP_SESSION_IDLE_MS` | `900000` (15 min) | Reap a session after this much idle time |
| `PARAFORM_MCP_MAX_SESSIONS` | `200` | Concurrent-session cap |

**HTTPS is required** — claude.ai's connector won't talk to plain `http://`.
Terminate TLS at a reverse proxy / platform load balancer:

- **Fly.io / Railway / Render / Cloud Run** — they handle HTTPS for you;
  just run `node mcp/remote_server.mjs` and point your domain at it.
- **Bare VM** — put Caddy or nginx in front; e.g. Caddy:
  ```caddyfile
  paraform.app {
      reverse_proxy localhost:8080
  }
  ```
- **Cloudflare Tunnel** — `cloudflared tunnel --url http://localhost:8080`
  for a quick public URL during development.

Endpoints:

```
POST   /mcp                       JSON-RPC 2.0 in, JSON response out
DELETE /mcp                       terminate the current session
GET    /mcp/download/<sessionId>  serve the session's .paraform.json (headless mode)
GET    /health                    liveness + active-session/pairing counts

POST   /studio/pair               studio mints a 6-letter pairing code
GET    /studio/events?code=…      SSE stream of tool_call events for the studio
POST   /studio/results?code=…     studio posts dispatch results back
```

### Studio-side env

In the studio bundle, set `VITE_MCP_REMOTE_URL` to the gateway's public URL
(e.g. `https://paraform.app`) so the **Connect Claude** button knows where to
pair. On localhost it defaults to `http://localhost:8080`.

CORS is open (`Access-Control-Allow-Origin: *`); the protocol is Streamable
HTTP MCP per spec `2024-11-05`.

## Local stdio — for developers running ParaForm on their own machine

1. **Install Node 20+** if you don't have it. (`node --version`)
2. **Clone or open** this repo locally. You don't need to `npm install` for
   the MCP server itself — it has zero runtime dependencies beyond what's
   already in the project.
3. **Edit your Claude Desktop config** at:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - Linux: `~/.config/Claude/claude_desktop_config.json`

   Add a `paraform` entry under `mcpServers`:

   ```json
   {
     "mcpServers": {
       "paraform": {
         "command": "node",
         "args": ["C:\\path\\to\\3d_play\\mcp\\server.mjs"]
       }
     }
   }
   ```

   Replace the path with the absolute path to `mcp/server.mjs` in your clone.
4. **Restart Claude Desktop.** A 🔌 / plug icon should appear in the chat input
   when ParaForm is available.

## Use

Ask Claude something like:

> *"In ParaForm, build a 40×20×5 mm baseplate with a 12 mm-tall Ø12 mm boss
> centred on top, then save it to `~/Desktop/bracket.paraform.json`."*

Claude will call the build tools, verify with `get_document_summary` /
`measure`, then call `paraform_save_document`. **Open the resulting
`.paraform.json` in the ParaForm studio** (File → Open) to see and continue
working on it.

To extend an existing build, ask Claude to `paraform_load_document` first,
then make changes, then save again.

## How it's wired

- **Two transports, one tool layer.** `mcp/server.mjs` is the stdio MCP server
  (~150 lines, no deps). `mcp/remote_server.mjs` is the HTTP gateway (also no
  deps) — for every Claude session it spawns the stdio server as a child
  process, so per-session isolation and document-store correctness come for
  free. Both ultimately call `mcp/handlers.mjs` → `dispatchTool` →
  `lib/document/index.js`, the exact same path the in-studio chat agent uses.
- Wire: newline-delimited JSON-RPC 2.0 (stdio) or Streamable HTTP MCP
  (remote) — both per spec `2024-11-05`.
- Tools that need the component library (`placeLibraryPart`, `search_library`,
  `addStandardPart`) trigger a lazy `loadLibrary()` from the local `parts/`
  JSON files — no network, no Supabase, no Anthropic.
- The kernel (`b123d_server`) is **not required** for the MCP server to
  function — feature mutations are recorded directly in the document store.
  The kernel is only needed for compiled geometry (mesh output, exports), so
  the studio re-compiles when it opens the saved `.paraform.json`.

## Privacy

- No telemetry from the MCP server itself.
- Your prompts and Claude's responses go through your **Claude Desktop**
  subscription (Anthropic's normal data handling), not through this code.
- The MCP server never reads or writes API keys; the Claude connector is
  independent of the in-studio "bring your own key" flow.
