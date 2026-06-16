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

    # The kernel is a HEADLESS Flask server — it does CAD geometry via OCP and
    # ships meshes over HTTP. It never imports a Qt/VTK GUI binding (verified:
    # `import build123d` pulls none of them, and no server module references
    # them). But build123d's environment commonly has BOTH PyQt5 and PySide6
    # installed (viewer extras), and PyInstaller ABORTS if it tries to collect
    # two Qt bindings at once ("attempt to collect multiple Qt bindings
    # packages"). Excluding all GUI bindings fixes that abort and strips
    # hundreds of MB of dead weight (PySide6 + PyQtWebEngine + VTK) from the
    # frozen sidecar, which also speeds up cold start.
    excludes = [
        # Qt/VTK GUI bindings — not needed by the headless compile path (Box →
        # mesh → glb), and dual PyQt5+PySide6 makes PyInstaller abort outright
        # ("attempt to collect multiple Qt bindings packages"). Dropping these
        # is the bulk of the size win (~hundreds of MB). Verified safe by the
        # post-build geometry probe in this script's workflow.
        "PyQt5", "PyQt6", "PyQtWebEngine",
        "PySide2", "PySide6", "shiboken2", "shiboken6",
        "vtk", "vtkmodules",
        # ML stacks pulled transitively into the dependency graph but never
        # imported by the kernel (verified: no kernel module imports them).
        # torch alone is 100s of MB — excluding it keeps the sidecar lean.
        "torch", "tensorboard", "tensorflow", "sklearn", "keras",
        # NOTE: do NOT exclude IPython / matplotlib / jupyter / ocp_vscode /
        # numpy / scipy / PIL — build123d imports IPython at RUNTIME (display
        # hooks), and the geometry stack uses numpy/scipy/PIL for array/image
        # interchange. Excluding IPython makes every /execute fail with
        # "No module named 'IPython'".
    ]

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
        # build123d's mesher (3MF/STL export) loads lib3mf.dll from the SEPARATE
        # `lib3mf` package dir (mesher.py: Lib3MF.Wrapper(os.path.join(
        # dirname(Lib3MF.__file__), "lib3mf"))). --collect-all build123d does
        # NOT reach it, so without this the frozen kernel dies on first compile
        # with "lib3mf.dll could not be found". --collect-all bundles the DLL
        # alongside the module so the wrapper's relative path resolves.
        "--collect-all", "lib3mf",
        "--collect-submodules", "flask",
        "--collect-submodules", "flask_cors",
        # build123d derives __version__ from importlib.metadata, which needs the
        # package's .dist-info bundled. Without this the frozen kernel reports
        # build123d_version "unknown" and the client's version-drift handshake
        # (kernelVersion → naming-contract mismatch warnings) can't function.
        "--copy-metadata", "build123d",
    ]
    for mod in excludes:
        args += ["--exclude-module", mod]
    args += [
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
