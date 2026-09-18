@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo 프로젝트 폴더: %CD%
echo Windows 환경을 설치합니다...
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup-windows.ps1"
echo.
pause
endlocal
