"""HTTP-level checks against Flask's test client.

Boot the production `server.app`, hit `/library` + `/library/<id>`, and
verify the wire shape matches the spec.
"""

from __future__ import annotations

import base64


def test_library_index_lists_at_least_75_fasteners(flask_client):
    """GET /library returns the full catalog with ≥75 fastener entries."""
    resp = flask_client.get("/library")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload["ok"] is True
    entries = payload["entries"]
    fasteners = [e for e in entries if e.get("category") == "Fastener"]
    assert len(fasteners) >= 75
    # No `_build` references leak through the wire.
    for e in entries:
        assert not any(k.startswith("_") for k in e.keys())


def test_library_entry_returns_glb(flask_client):
    """GET /library/iso4762-m3-16 returns a non-empty base64 GLB."""
    resp = flask_client.get("/library/iso4762-m3-16")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload["ok"] is True
    assert payload["entry"]["id"] == "iso4762-m3-16"
    glb_b64 = payload["glbBase64"]
    assert isinstance(glb_b64, str) and glb_b64
    blob = base64.b64decode(glb_b64)
    # GLB magic: 0x46546C67 ("glTF") LE = b"glTF" in the first 4 bytes.
    assert blob[:4] == b"glTF"
    assert len(blob) > 100


def test_library_entry_unknown_id_returns_404(flask_client):
    resp = flask_client.get("/library/not-a-real-id")
    assert resp.status_code == 404
    payload = resp.get_json()
    assert payload["ok"] is False
    assert "unknown" in payload["error"].lower()


def test_library_attaches_kernel_version(flask_client):
    """Both routes must include the kernelVersion stamp."""
    idx = flask_client.get("/library").get_json()
    assert "kernelVersion" in idx
    detail = flask_client.get("/library/bearing-608").get_json()
    assert "kernelVersion" in detail
