@echo off
echo ================================================
echo  Paraform build123d Server
echo ================================================
echo.
echo Step 1/2 — Installing Python dependencies...
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo ERROR: pip install failed. Make sure Python 3.10+ is installed.
    pause
    exit /b 1
)
echo.
echo Step 2/2 — Starting server on http://localhost:7823
echo.
echo  To expose via Cloudflare Tunnel, open a NEW terminal and run:
echo    cloudflared tunnel --url http://localhost:7823
echo.
echo  Then paste the tunnel URL into the Paraform app engine settings.
echo  Keep this window open. Press Ctrl+C to stop.
echo ================================================
echo.
python server.py 7823
pause
