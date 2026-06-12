---
title: ParaForm Engine
emoji: 🔧
colorFrom: orange
colorTo: red
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: build123d execution backend for ParaForm CAD
---

# ParaForm Engine

The build123d execution backend for [ParaForm](https://paraform.app).
Receives Python code emitted by the browser-side feature tree and returns
binary glTF (glb) for the viewport plus STEP/STL for export.

## Endpoints

| Method | Path        | Purpose                              |
|--------|-------------|--------------------------------------|
| GET    | `/`         | Status page (HTML)                   |
| GET    | `/health`   | `{ ok, build123d_version }`          |
| GET    | `/smoke`    | Hardcoded test — returns Box+Fillet glb |
| POST   | `/execute`  | Run code → glb / step / stl bytes    |
| POST   | `/export`   | Same as execute, format required     |
| POST   | `/validate` | Syntax check only                    |

### POST /execute body

```json
{
  "code": "from build123d import *\nresult = Box(10, 10, 10)\n__paraform_result__ = {\"bodies\": {\"main\": result}}",
  "format": "glb",
  "tree": {}
}
```

Returns binary glb (`Content-Type: model/gltf-binary`) on success,
JSON `{ok: false, error, trace}` on failure.

## Run locally

```bash
docker build -t paraform-engine .
docker run -p 7860:7860 paraform-engine
# → open http://localhost:7860
```

Or without Docker:

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 7860 --reload
```

## Deploy to Hugging Face Spaces

1. Create a new Space → choose **Docker** SDK
2. Push this folder to the Space's git repo
3. Wait ~5 min for build, then hit `/health`

Frontend wiring: set `window.__PARAFORM_ENGINE_URL__ = "https://<user>-<space>.hf.space"`
before mounting b123d mode.

## Phase 0 limitations

- Topology fingerprints not yet resolved — `resolve_edges`/`resolve_faces`
  return all edges/faces. Fillet/Chamfer applied with selections work only
  for "all edges" cases.
- `make_hole` drills through the bounding-box Z center, not a picked face.
- `pattern_path`, `push_pull_face`, `draft`, `split`, `add_thread`,
  `import_step` are stubs — they return inputs unchanged.

These all land in Phase 2+.
