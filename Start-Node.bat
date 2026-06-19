@echo off
REM Force SillyBunny to use Node.js instead of Bun.
REM Use this if Bun causes high CPU usage on your platform.
setlocal enabledelayedexpansion
pushd %~dp0

REM Prepend common Node.js install locations so double-click launches still find
REM Node when the launching shell inherited a stale PATH (e.g. right after install,
REM before Explorer refreshes environment variables). Mirrors the PATH augmentation
REM Start.bat applies for Bun/Git discovery.
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%APPDATA%\npm;%LocalAppData%\Volta\bin;%USERPROFILE%\scoop\shims;%PATH%"

where node > nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js was not found in PATH.
    echo Install Node.js from https://nodejs.org/ or use Start.bat for Bun.
    echo If you just installed Node.js, restart your PC or relaunch from a fresh
    echo Command Prompt so the updated PATH is picked up.
    goto end
)

set NODE_ENV=production
set SILLYBUNNY_LAUNCHER=1
set "_dependency_profile=node-production"
if exist node_modules\eslint\package.json set "_dependency_profile=node-development"
node scripts\dependency-state.js check !_dependency_profile! > nul 2>&1
if !errorlevel! neq 0 (
    if "!_dependency_profile!"=="node-development" (
        echo Installing packages via npm including development tooling (Node.js mode)...
    ) else (
        echo Installing packages via npm (Node.js mode)...
    )
    if exist package-lock.json (
        if "!_dependency_profile!"=="node-development" (
            call npm ci --no-audit --no-fund --loglevel=error
        ) else (
            call npm ci --no-audit --no-fund --omit=dev --loglevel=error
        )
    ) else (
        if "!_dependency_profile!"=="node-development" (
            call npm install --no-audit --no-fund --loglevel=error
        ) else (
            call npm install --no-audit --no-fund --omit=dev --loglevel=error
        )
    )
    if !errorlevel! neq 0 goto end
    node scripts\dependency-state.js mark !_dependency_profile!
    if !errorlevel! neq 0 goto end
) else (
    echo Dependencies are up to date.
)

echo Entering SillyBunny (Node.js mode)...
set NODE_NO_WARNINGS=1

:server_loop
node --no-warnings server.js %*
set "_server_exit=!errorlevel!"
if "!_server_exit!"=="75" (
    echo.
    echo [SillyBunny] Restarting server...
    set SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH=1
    goto server_loop
)

:end
pause
popd
endlocal
