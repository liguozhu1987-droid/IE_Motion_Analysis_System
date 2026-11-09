@echo off
rem ============================================================
rem  Install IE-Platform as a Windows service (RUN AS ADMINISTRATOR)
rem  - Service name: IE-Platform   Display name: IE-Platform
rem  - Auto-start on boot, auto-restart 60s after crash (3 attempts)
rem  - The exe chdir's to its own folder at startup, so .env /
rem    web/dist / storage / bin / config all resolve correctly
rem    even though services default to System32 as working dir.
rem ============================================================
cd /d %~dp0
sc create IE-Platform binPath= "\"%~dp0IE-Platform.exe\" run" start= auto displayname= "IE-Platform"
if errorlevel 1 (
  echo [FAIL] sc create failed - right-click this file and "Run as administrator"
  pause
  exit /b 1
)
sc description IE-Platform "IE Improvement Platform (single-exe deployment)"
sc failure IE-Platform reset= 0 actions= restart/60000/restart/60000/restart/60000
echo.
echo Installed. Manage with:
echo   net start IE-Platform    ^| sc start IE-Platform
echo   net stop IE-Platform     ^| sc stop IE-Platform
echo   sc query IE-Platform
pause
