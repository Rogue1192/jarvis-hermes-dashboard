@echo off
REM Double-click launcher for the JARVIS dashboard.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause
