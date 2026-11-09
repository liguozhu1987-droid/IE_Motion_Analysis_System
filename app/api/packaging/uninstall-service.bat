@echo off
rem ============================================================
rem  Uninstall the IE-Platform Windows service (RUN AS ADMINISTRATOR)
rem ============================================================
cd /d %~dp0
sc stop IE-Platform >nul 2>&1
rem give the process a moment to exit before delete
timeout /t 3 /nobreak >nul
sc delete IE-Platform
if errorlevel 1 (
  echo [FAIL] sc delete failed - run as administrator, or service may still be stopping
  pause
  exit /b 1
)
echo Uninstalled.
pause
