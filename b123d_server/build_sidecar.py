"""
Freeze the b123d Flask server into a single executable that Tauri can ship
as an `externalBin` sidecar.

Run from the b123d_server/ directory:
    python build_sidecar.py

Output:
    dist/b123d_server-<target-triple>(.exe)

The output name embeds Rust's target triple so `tauri build` / `tauri dev`
can pick the right binary per host platform (see `externalBin` in
src-tauri/tauri.conf.json).

Why a wrapper instead of a raw .spec file:
  - Resolves the target triple from `rustc -Vv`, so we don't have to maintain
    a per-OS matrix here.
  - Adds the OCP/build123d hidden-import collection that PyInstaller can't
    statically discover.
  - Pins binary name + entry point so the Rust spawn code can hard-code it.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def detect_triple() -> str:
    """Return Rust's host target triple (e.g. x86_64-pc-windows-msvc)."""
    try:
        out = subprocess.check_output(["rustc", "-Vv"], text=True)
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        raise SystemExit(
            "rustc not found — install Rust (https://rustup.rs) before "
            "building the sidecar, or set TARGET_TRIPLE in the environment."
        ) from e
    for line in out.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip()
    raise SystemExit(f"Could not parse target triple from `rustc -Vv`:\n{out}")


def main() -> None:
    here = Path(__file__).resolve().parent
    repo = here.parent
    out_dir = repo / "src-tauri" / "binaries"
    out_dir.mkdir(parents=True, exist_ok=True)

    triple = os.environ.get("TARGET_TRIPLE") or detect_triple()
    name = f"b123d_server-{triple}"

    # PyInstaller args. We use --onefile so Tauri sees a single binary; the
    # build123d package brings OCP (a heavy C++ binding) along with several
    # data files, hence --collect-all.
    args = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name", name,
        "--collect-all", "build123d",
        "--collect-all", "OCP",
        "--collect-all", "ocpsvg",
        "--collect-submodules", "flask",
        "--collect-submodules", "flask_cors",
        "--distpath", str(here / "dist"),
        "--workpath", str(here / "build"),
        "--specpath", str(here / "build"),
        str(here / "server.py"),
    ]
    print("[sidecar] running:", " ".join(args), flush=True)
    rc = subprocess.call(args, cwd=here)
    if rc != 0:
        raise SystemExit(f"PyInstaller failed with exit code {rc}")

    # Move the produced binary to src-tauri/binaries/ with the triple-suffixed
    # name Tauri expects for externalBin sidecars.
    suffix = ".exe" if os.name == "nt" else ""
    produced = here / "dist" / f"{name}{suffix}"
    if not produced.exists():
        raise SystemExit(f"PyInstaller did not produce expected file: {produced}")
    dest = out_dir / f"{name}{suffix}"
    if dest.exists():
        dest.unlink()
    shutil.move(str(produced), str(dest))
    print(f"[sidecar] wrote {dest}")


if __name__ == "__main__":
    main()
