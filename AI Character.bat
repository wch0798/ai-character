@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launch-ai-character.ps1"
endlocal
