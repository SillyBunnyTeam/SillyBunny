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

set "RUNTIME_CMD="
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "RUNTIME_CMD=%ProgramFiles%\nodejs\node.exe"
) else if exist "!ProgramFiles(x86)!\nodejs\node.exe" (
    set "RUNTIME_CMD=!ProgramFiles(x86)!\nodejs\node.exe"
) else if exist "%LocalAppData%\Volta\bin\node.exe" (
    set "RUNTIME_CMD=%LocalAppData%\Volta\bin\node.exe"
) else if exist "%USERPROFILE%\scoop\shims\node.exe" (
    set "RUNTIME_CMD=%USERPROFILE%\scoop\shims\node.exe"
) else (
    for /f "delims=" %%I in ('where node 2^>nul') do if not defined RUNTIME_CMD set "RUNTIME_CMD=%%I"
)
if not defined RUNTIME_CMD (
    echo Node.js was not found in PATH.
    echo Install Node.js from https://nodejs.org/ or use Start.bat for Bun.
    echo If you just installed Node.js, restart your PC or relaunch from a fresh
    echo Command Prompt so the updated PATH is picked up.
    goto end
)

set "_has_npm=0"
if exist "%ProgramFiles%\nodejs\npm.cmd" (
    set "_has_npm=1"
) else if exist "!ProgramFiles(x86)!\nodejs\npm.cmd" (
    set "_has_npm=1"
) else if exist "%APPDATA%\npm\npm.cmd" (
    set "_has_npm=1"
) else if exist "%LocalAppData%\Volta\bin\npm.exe" (
    set "_has_npm=1"
) else if exist "%USERPROFILE%\scoop\shims\npm.cmd" (
    set "_has_npm=1"
) else if exist "%USERPROFILE%\scoop\shims\npm.exe" (
    set "_has_npm=1"
) else (
    where npm > nul 2>&1
    if !errorlevel! equ 0 set "_has_npm=1"
)
if "!_has_npm!"=="0" (
    echo npm was not found in PATH.
    echo Install a complete Node.js distribution from https://nodejs.org/
    goto end
)

set NODE_ENV=production
set SILLYBUNNY_LAUNCHER=1
set "_dependency_profile=node-production"
if exist node_modules\eslint\package.json set "_dependency_profile=node-development"

set "_force_init=0"
if /I "!SILLYBUNNY_FORCE_INIT!"=="1" set "_force_init=1"
if /I "!SILLYBUNNY_FORCE_INIT!"=="true" set "_force_init=1"
if /I "!SILLYBUNNY_FORCE_INIT!"=="yes" set "_force_init=1"
if /I "!SILLYBUNNY_FORCE_INIT!"=="on" set "_force_init=1"

set "_git_dir="
if exist ".git\HEAD" (
    set "_git_dir=.git"
) else if exist ".git" (
    set "_gitfile_line="
    set /p _gitfile_line=<".git"
    if /I "!_gitfile_line:~0,8!"=="gitdir: " (
        set "_git_dir=!_gitfile_line:~8!"
        set "_git_dir=!_git_dir:/=\!"
    )
)
set "_head_state=nogit"
if defined _git_dir if exist "!_git_dir!\HEAD" (
    set /p _head_state=<"!_git_dir!\HEAD"
    if "!_head_state:~0,5!"=="ref: " (
        set "_head_ref=!_head_state:~5!"
        set "_head_ref=!_head_ref:/=\!"
        if exist "!_git_dir!\!_head_ref!" (
            set "_head_sha="
            set /p _head_sha=<"!_git_dir!\!_head_ref!"
            set "_head_state=!_head_state!@!_head_sha!"
        ) else if exist "!_git_dir!\commondir" (
            set "_common_rel="
            set /p _common_rel=<"!_git_dir!\commondir"
            set "_common_rel=!_common_rel:/=\!"
            if exist "!_git_dir!\!_common_rel!\!_head_ref!" (
                set "_head_sha="
                set /p _head_sha=<"!_git_dir!\!_common_rel!\!_head_ref!"
                set "_head_state=!_head_state!@!_head_sha!"
            ) else if exist "!_common_rel!\!_head_ref!" (
                set "_head_sha="
                set /p _head_sha=<"!_common_rel!\!_head_ref!"
                set "_head_state=!_head_state!@!_head_sha!"
            ) else if exist "!_git_dir!\!_common_rel!\packed-refs" (
                for %%F in ("!_git_dir!\!_common_rel!\packed-refs") do set "_head_state=!_head_state!@packed:%%~tF:%%~zF"
            )
        ) else if exist "!_git_dir!\packed-refs" (
            for %%F in ("!_git_dir!\packed-refs") do set "_head_state=!_head_state!@packed:%%~tF:%%~zF"
        )
    )
)
set "_files_state="
for %%P in ("package.json" "package-lock.json" "bun.lock" "default\config.yaml") do (
    if exist %%P (
        for %%F in (%%P) do set "_files_state=!_files_state!;%%~P=%%~tF:%%~zF"
    ) else (
        set "_files_state=!_files_state!;%%~P=missing"
    )
)
set "_boot_stamp_file=node_modules\.cache\.sillybunny-boot-stamp"
set "_boot_stamp=v1;!_dependency_profile!;!NODE_ENV!;!_head_state!!_files_state!"
set "_warm_boot_hit=0"
if "!_force_init!"=="0" if exist "!_boot_stamp_file!" if exist "node_modules\.sillybunny-dependencies.json" if exist "config.yaml" if exist "public\index.html" if not exist "config.conf" (
    set "_saved_boot_stamp="
    set /p _saved_boot_stamp=<"!_boot_stamp_file!"
    if "!_saved_boot_stamp!"=="!_boot_stamp!" set "_warm_boot_hit=1"
)

if "!_warm_boot_hit!"=="1" (
    echo Dependencies are up to date.
) else (
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
    node "%~dp0src\server-init.js"
    if !errorlevel! neq 0 goto end
    if not exist "node_modules\.cache" mkdir "node_modules\.cache" > nul 2>&1
    (echo(!_boot_stamp!)>"!_boot_stamp_file!"
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
