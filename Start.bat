@echo off
setlocal enabledelayedexpansion
pushd %~dp0

set "PATH=%USERPROFILE%\.bun\bin;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%APPDATA%\npm;%LocalAppData%\Volta\bin;%USERPROFILE%\scoop\shims;%ProgramFiles%\Git\cmd;%ProgramFiles(x86)%\Git\cmd;%LocalAppData%\Programs\Git\cmd;%PATH%"
set "_need_git=0"
set "_auto_update=1"

if exist .git set "_need_git=1"
if /I "%SILLYBUNNY_AUTO_UPDATE%"=="0" set "_auto_update=0"
if /I "%SILLYBUNNY_AUTO_UPDATE%"=="false" set "_auto_update=0"
if /I "%SILLYBUNNY_AUTO_UPDATE%"=="no" set "_auto_update=0"
if /I "%SILLYBUNNY_AUTO_UPDATE%"=="off" set "_auto_update=0"

set "_force_node=0"
if /I "!SILLYBUNNY_USE_NODE!"=="1" set "_force_node=1"
if /I "!SILLYBUNNY_USE_NODE!"=="true" set "_force_node=1"
if /I "!SILLYBUNNY_USE_NODE!"=="yes" set "_force_node=1"
if /I "!SILLYBUNNY_USE_NODE!"=="on" set "_force_node=1"

set "_force_bun=0"
if /I "!SILLYBUNNY_USE_BUN!"=="1" set "_force_bun=1"
if /I "!SILLYBUNNY_USE_BUN!"=="true" set "_force_bun=1"
if /I "!SILLYBUNNY_USE_BUN!"=="yes" set "_force_bun=1"
if /I "!SILLYBUNNY_USE_BUN!"=="on" set "_force_bun=1"

set "_server_runtime=bun"
if "!_force_node!"=="1" set "_server_runtime=node"

set "_is_arm64=0"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "_is_arm64=1"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "_is_arm64=1"
if "!_force_node!"=="0" if "!_force_bun!"=="0" if "!_is_arm64!"=="1" (
    where node > nul 2>&1
    if !errorlevel! equ 0 (
        where npm > nul 2>&1
        if !errorlevel! equ 0 (
            echo.
            echo [SillyBunny] ARM64 detected. Bun may use excessive CPU on this platform.
            echo [SillyBunny] Switching to Node.js automatically. Use Start-Bun.bat or Start.bat with SILLYBUNNY_USE_BUN=1 to override.
            echo.
            set "_server_runtime=node"
        )
    )
)

if "!_server_runtime!"=="node" (
    where node > nul 2>&1
    if !errorlevel! neq 0 (
        echo Node.js was requested but could not be found in PATH.
        echo Install Node.js from https://nodejs.org/ or unset SILLYBUNNY_USE_NODE.
        goto end
    )
    where npm > nul 2>&1
    if !errorlevel! neq 0 (
        echo npm was not found in PATH. Install a complete Node.js distribution from https://nodejs.org/
        goto end
    )
) else (
    where bun > nul 2>&1
    if !errorlevel! neq 0 (
        where powershell > nul 2>&1
        if !errorlevel! neq 0 (
            echo Bun could not be found in PATH, and PowerShell is unavailable for automatic installation.
            echo Install Bun manually from https://bun.sh/
            goto end
        )

        echo Bun was not found. Installing prerequisites automatically...
        if "!_need_git!"=="1" (
            powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Install-Prerequisites.ps1" -RequireGit
        ) else (
            powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Install-Prerequisites.ps1"
        )
        if !errorlevel! neq 0 goto end
    )
)

if "%_need_git%"=="1" (
    where git > nul 2>&1
    if !errorlevel! neq 0 (
        where powershell > nul 2>&1
        if !errorlevel! neq 0 (
            echo Git could not be found in PATH, and PowerShell is unavailable for automatic installation.
            echo Install Git manually from https://git-scm.com/downloads
            goto end
        )

        echo Git was not found. Installing prerequisites automatically...
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Install-Prerequisites.ps1" -RequireGit -RequireBun:$false
        if !errorlevel! neq 0 goto end
    )
)

if "%_need_git%"=="1" if "%_auto_update%"=="1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Self-Update.ps1" -Optional
    if !errorlevel! neq 0 goto end
)

if "%_need_git%"=="0" if "%_auto_update%"=="1" (
    echo [SillyBunny] Self-update skipped: this folder is not a Git checkout.
    echo [SillyBunny] Download the latest release ZIP, or install with git clone to enable automatic updates.
    echo.
)

set NODE_ENV=production
set NODE_NO_WARNINGS=1
set SILLYBUNNY_LAUNCHER=1
set "_dependency_profile=!_server_runtime!-production"
if exist node_modules\eslint\package.json set "_dependency_profile=!_server_runtime!-development"

if "!_server_runtime!"=="node" (
    node scripts\dependency-state.js check !_dependency_profile! > nul 2>&1
    if !errorlevel! neq 0 (
        if "!_dependency_profile!"=="node-development" (
            echo Installing packages via npm including development tooling ^(Node.js mode^)...
        ) else (
            echo Installing packages via npm ^(Node.js mode^)...
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
) else (
    set "_bun_install_args=--frozen-lockfile --production --no-progress --no-summary"
    set "_bun_fallback_args=--production --no-progress --no-summary"
    if "!_dependency_profile!"=="bun-development" (
        set "_bun_install_args=--frozen-lockfile --no-progress --no-summary"
        set "_bun_fallback_args=--no-progress --no-summary"
    )
    bun scripts\dependency-state.js check !_dependency_profile! > nul 2>&1
    if !errorlevel! neq 0 (
        if "!_dependency_profile!"=="bun-development" (
            echo Installing Bun packages including development tooling...
        ) else (
            echo Installing Bun packages...
        )
        set "_restore_bun_lock=0"
        if exist .git if exist bun.lock (
            git ls-files --error-unmatch bun.lock > nul 2>&1
            if !errorlevel! equ 0 (
                git diff --quiet -- bun.lock > nul 2>&1
                if !errorlevel! equ 0 set "_restore_bun_lock=1"
            )
        )
        call bun install !_bun_install_args!
        if !errorlevel! neq 0 (
            echo Bun lockfile check failed; retrying without --frozen-lockfile so bun.lock can refresh.
            call bun install !_bun_fallback_args!
        )
        if !errorlevel! neq 0 goto end
        if "!_restore_bun_lock!"=="1" (
            git diff --quiet -- bun.lock > nul 2>&1
            if !errorlevel! neq 0 (
                echo Restoring tracked bun.lock after Bun lockfile refresh...
                git restore -- bun.lock
                if !errorlevel! neq 0 goto end
            )
        )
        bun scripts\dependency-state.js mark !_dependency_profile!
        if !errorlevel! neq 0 goto end
    ) else (
        echo Dependencies are up to date.
    )
)

if "!_server_runtime!"=="node" (
    call npm run init
) else (
    call bun run init
)
if !errorlevel! neq 0 goto end

REM Normalise SILLYBUNNY_BUN_SMOL to a 0/1 flag so the accepted spellings match
REM is_truthy in start.sh, rather than only the literal 1.
set "_bun_smol=0"
if /I "!SILLYBUNNY_BUN_SMOL!"=="1" set "_bun_smol=1"
if /I "!SILLYBUNNY_BUN_SMOL!"=="true" set "_bun_smol=1"
if /I "!SILLYBUNNY_BUN_SMOL!"=="yes" set "_bun_smol=1"
if /I "!SILLYBUNNY_BUN_SMOL!"=="on" set "_bun_smol=1"

if "!_bun_smol!"=="1" if "!_server_runtime!"=="node" (
    echo [SillyBunny] SILLYBUNNY_BUN_SMOL is set, but Node.js was selected. --smol is a Bun flag and will be ignored.
    echo [SillyBunny] For Bun with --smol, use Start-Bun.bat.
)

:server_loop
if "!_server_runtime!"=="node" (
    node --no-warnings server.js %*
) else if "!_bun_smol!"=="1" (
    REM Bun grows the JSC heap freely while RAM looks plentiful; --smol trades
    REM throughput for much more aggressive GC on memory-constrained hosts.
    bun --smol server.js %*
) else (
    bun server.js %*
)
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
