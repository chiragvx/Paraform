#!/usr/bin/env bash
set -e

echo "================================================"
echo " Paraform build123d Server"
echo "================================================"
echo ""
echo "Step 1/2 — Installing Python dependencies..."
pip3 install -r requirements.txt
echo ""
echo "Step 2/2 — Starting server on http://localhost:7823"
echo ""
echo " To expose via Cloudflare Tunnel, open a NEW terminal and run:"
echo "   cloudflared tunnel --url http://localhost:7823"
echo ""
echo " Then paste the tunnel URL into the Paraform app engine settings."
echo " Keep this terminal open. Press Ctrl+C to stop."
echo "================================================"
echo ""
python3 server.py 7823
