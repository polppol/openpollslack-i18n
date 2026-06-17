@echo off
REM Launches setup-autocert.ps1 with the PowerShell execution policy bypassed.
REM Right-click this file -> "Run as administrator" (win-acme needs admin to
REM create the renewal Scheduled Task and to restart your service).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-autocert.ps1"
echo.
pause
