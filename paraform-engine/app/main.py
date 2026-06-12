"""
ParaForm Engine — FastAPI entry point.

Endpoints
─────────
GET  /              — friendly index page
GET  /health        — { ok, build123d_version }
POST /execute       — { code, format? }   → glb bytes (or json on error)
POST /export        — { code, format }    → step/stl/glb bytes
POST /validate      — { code }            → { ok, error? } syntax check only
"""

import io
import time
import traceback
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel, Field

import build123d as _b123d

from .execute import (
    execute_code,
    to_glb_bytes,
    to_step_bytes,
    to_stl_bytes,
    combine_bodies,
)


app = FastAPI(
    title="ParaForm Engine",
    description="build123d execution backend for ParaForm CAD",
    version="0.1.0",
)

# Allow any origin for now — tighten in production
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request models ─────────────────────────────────────────────────────────
class ExecuteRequest(BaseModel):
    code: str = Field(..., description="build123d Python emitted by the browser tree")
    tree: Optional[dict] = Field(None, description="Original tree JSON (informational)")
    format: str = Field("glb", description="glb | step | stl")


class ExportRequest(BaseModel):
    code: str
    format: str = Field("step", description="step | stl | glb")


class ValidateRequest(BaseModel):
    code: str


# ── Routes ─────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
def index():
    return f"""<!doctype html>
<html><head><title>ParaForm Engine</title>
<style>
body{{font-family:ui-sans-serif,system-ui,-apple-system;background:#1a1d23;color:#e6e9ee;
     margin:0;padding:40px;line-height:1.6}}
h1{{color:#ff8a3d;margin:0 0 8px}} .v{{color:#8a93a3;font-size:13px}}
code{{background:#22262e;padding:2px 6px;border-radius:3px;color:#e6e9ee}}
.endpoint{{padding:12px 16px;background:#22262e;border-radius:4px;margin:8px 0}}
.method{{display:inline-block;background:#ff8a3d;color:#1a1d23;padding:1px 6px;
       border-radius:2px;font-size:11px;font-weight:600;margin-right:8px}}
</style></head><body>
<h1>ParaForm Engine</h1>
<div class="v">build123d {_b123d.__version__} — ready</div>
<h3>Endpoints</h3>
<div class="endpoint"><span class="method">GET</span><code>/health</code> — status check</div>
<div class="endpoint"><span class="method">POST</span><code>/execute</code> — run code → glb bytes</div>
<div class="endpoint"><span class="method">POST</span><code>/export</code> — run code → step/stl bytes</div>
<div class="endpoint"><span class="method">POST</span><code>/validate</code> — syntax check only</div>
<p class="v">Frontend: set <code>window.__PARAFORM_ENGINE_URL__</code> to this domain in b123d mode.</p>
</body></html>"""


@app.get("/health")
def health():
    return {
        "ok": True,
        "build123d_version": _b123d.__version__,
        "service": "paraform-engine",
    }


@app.post("/execute")
def execute(req: ExecuteRequest):
    t0 = time.time()
    result = execute_code(req.code)
    elapsed_ms = int((time.time() - t0) * 1000)

    if not result["ok"]:
        return JSONResponse(
            {
                "ok": False,
                "error": result.get("error"),
                "trace": result.get("trace"),
                "elapsed_ms": elapsed_ms,
            },
            status_code=400,
        )

    bodies = result["bodies"]
    if not bodies:
        return JSONResponse(
            {"ok": False, "error": "No build123d bodies produced by code",
             "locals": result.get("locals_summary", {}), "elapsed_ms": elapsed_ms},
            status_code=400,
        )

    combined = combine_bodies(bodies)

    try:
        fmt = req.format.lower()
        if fmt == "glb":
            data = to_glb_bytes(combined)
            return Response(
                content=data,
                media_type="model/gltf-binary",
                headers={
                    "X-Paraform-Elapsed-Ms": str(elapsed_ms),
                    "X-Paraform-Bodies": str(len(bodies)),
                    "X-Paraform-Body-Names": ",".join(bodies.keys()),
                },
            )
        elif fmt == "step":
            data = to_step_bytes(combined)
            return Response(content=data, media_type="model/step",
                            headers={"X-Paraform-Elapsed-Ms": str(elapsed_ms)})
        elif fmt == "stl":
            data = to_stl_bytes(combined)
            return Response(content=data, media_type="model/stl",
                            headers={"X-Paraform-Elapsed-Ms": str(elapsed_ms)})
        else:
            return JSONResponse({"ok": False, "error": f"Unknown format: {fmt}"},
                                status_code=400)
    except Exception as e:
        return JSONResponse({
            "ok": False,
            "error": f"Export failed: {e}",
            "trace": traceback.format_exc(),
            "elapsed_ms": elapsed_ms,
        }, status_code=500)


@app.post("/export")
def export(req: ExportRequest):
    # Same as /execute but format is required
    return execute(ExecuteRequest(code=req.code, format=req.format))


@app.post("/validate")
def validate(req: ValidateRequest):
    try:
        compile(req.code, "<paraform>", "exec")
        return {"ok": True}
    except SyntaxError as e:
        return {"ok": False, "error": f"SyntaxError: {e.msg}", "line": e.lineno, "offset": e.offset}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Smoke-test endpoint (no body needed) ──────────────────────────────────
@app.get("/smoke")
def smoke():
    """Run a built-in test tree (Box + Fillet) and return glb bytes."""
    code = """
from build123d import *
box = Box(20, 20, 10, align=(Align.CENTER, Align.CENTER, Align.CENTER))
filleted = fillet(box.edges(), radius=2)
__paraform_result__ = {"bodies": {"smoke": filleted}}
"""
    return execute(ExecuteRequest(code=code, format="glb"))
