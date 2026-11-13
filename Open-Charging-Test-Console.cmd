@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-report-app.ps1"
if errorlevel 1 (
  echo.
  echo Unable to open the Charging Test Console.
  pause
)
