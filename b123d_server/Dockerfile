# ParaForm kernel (b123d_server) — Flask build123d + AI proxy + billing backend.
# Built for Hugging Face Spaces (Docker SDK). Serves on port 7860 (app_port in
# README.md). This is the backend the deployed studio talks to — NOT the older
# geometry-only paraform-engine service.

FROM python:3.11-slim

# OCP (OpenCascade Python, used by build123d) needs these native libs for
# tessellation / headless rendering. Same set proven by paraform-engine.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglu1-mesa \
        libxrender1 \
        libxext6 \
        libsm6 \
        libfontconfig1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first for layer caching (the OCP wheel is ~120 MB — slow).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Server code. Flat module layout: server.py imports its siblings (harness,
# measure, ai_proxy, auth_gate, billing, standard_parts/) directly, so the
# whole dir lands in the workdir. build/ and dist/ are excluded via
# .dockerignore (631 MB of PyInstaller artifacts — must not bloat the image).
COPY . .

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# HF Spaces serves the container on this port (matches app_port in README.md).
EXPOSE 7860

# Flask's threaded single-process server. REQUIRED to stay single-process:
# /measure reads a process-local cache populated by /execute, so a multi-worker
# WSGI server (gunicorn -w >1) would shard that cache and /measure would miss
# the worker holding the latest build. server.py takes the port as argv[1] and
# already binds 0.0.0.0 with threaded=True.
CMD ["python", "server.py", "7860"]
