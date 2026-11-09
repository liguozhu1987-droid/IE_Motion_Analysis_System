@echo off
rem ============================================================
rem  IE-Platform foreground start
rem  - Logs print to this console window
rem  - Ctrl+C = graceful shutdown (closes DB pool, removes PID file)
rem  - Close window / taskkill = hard stop (safe for this stateless API)
rem ============================================================
cd /d %~dp0
if not exist ".env" echo [WARN] .env missing - running on built-in defaults
if not exist "web\dist\index.html" echo [WARN] web\dist\index.html missing - API-only mode (frontend not served)
echo Starting IE-Platform on http://127.0.0.1:3001 ...
echo Open http://<server-ip>:3001/ in your browser.
echo.
IE-Platform.exe run
