@echo off
REM Double-click wrapper: runs the installer next to this file, bypassing the execution policy for this run only.
setlocal
set "_installer=%~dp0Install-SillyBunny.ps1"
if not exist "%_installer%" (
    echo [SillyBunny] Install-SillyBunny.ps1 must be in the same folder as this file.
    echo [SillyBunny] Download both from https://github.com/SillyBunnyTeam/SillyBunny/releases/latest
    pause
    exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%_installer%" %*
set "_exit=%errorlevel%"
if not "%_exit%"=="0" pause
endlocal & exit /b %_exit%
