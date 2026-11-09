@echo off
rem ============================================================
rem  IE-Platform stop
rem  Uses the exe's built-in stop subcommand (reads ie-platform.pid,
rem  kills that PID). No taskkill / PATH dependency.
rem ============================================================
cd /d %~dp0
IE-Platform.exe stop
if errorlevel 1 (
  echo Built-in stop failed; falling back to image-name kill ...
  taskkill /F /IM IE-Platform.exe
)
