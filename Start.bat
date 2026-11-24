@echo off
setlocal enabledelayedexpansion
pushd %~dp0

set "PATH=%USERPROFILE%\.bun\bin;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%APPDATA%\npm;%LocalAppData%\Volta\bin;%USERPROFILE%\scoop\shims;%ProgramFiles%\Git\cmd;%ProgramFiles(x86)%\Git\cmd;%LocalAppData%\Programs\Git\cmd;%LocalAppData%\SillyBunny\MinGit\cmd;%PATH%"
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
    set "_arm_has_node=0"
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "_arm_has_node=1"
    ) else if exist "!ProgramFiles(x86)!\nodejs\node.exe" (
        set "_arm_has_node=1"
    ) else if exist "%LocalAppData%\Volta\bin\node.exe" (
        set "_arm_has_node=1"
    ) else if exist "%USERPROFILE%\scoop\shims\node.exe" (
        set "_arm_has_node=1"
    ) else (
        where node > nul 2>&1
        if !errorlevel! equ 0 set "_arm_has_node=1"
    )
    if "!_arm_has_node!"=="1" (
        set "_arm_has_npm=0"
        if exist "%ProgramFiles%\nodejs\npm.cmd" (
            set "_arm_has_npm=1"
        ) else if exist "!ProgramFiles(x86)!\nodejs\npm.cmd" (
            set "_arm_has_npm=1"
        ) else if exist "%APPDATA%\npm\npm.cmd" (
            set "_arm_has_npm=1"
        ) else if exist "%LocalAppData%\Volta\bin\npm.exe" (
            set "_arm_has_npm=1"
        ) else if exist "%USERPROFILE%\scoop\shims\npm.cmd" (
            set "_arm_has_npm=1"
        ) else if exist "%USERPROFILE%\scoop\shims\npm.exe" (
            set "_arm_has_npm=1"
        ) else (
            where npm > nul 2>&1
            if !errorlevel! equ 0 set "_arm_has_npm=1"
        )
        if "!_arm_has_npm!"=="1" (
            echo.
            echo [SillyBunny] ARM64 detected. Bun may use excessive CPU on this platform.
            echo [SillyBunny] Switching to Node.js automatically. Use Start-Bun.bat or Start.bat with SILLYBUNNY_USE_BUN=1 to override.
            echo.
            set "_server_runtime=node"
        )
    )
)

set "RUNTIME_CMD="
if "!_server_runtime!"=="node" (
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
        echo Node.js was requested but could not be found in PATH.
        echo Install Node.js from https://nodejs.org/ or unset SILLYBUNNY_USE_NODE.
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
        echo npm was not found in PATH. Install a complete Node.js distribution from https://nodejs.org/
        goto end
    )
) else (
    if exist "%USERPROFILE%\.bun\bin\bun.exe" (
        set "RUNTIME_CMD=%USERPROFILE%\.bun\bin\bun.exe"
    ) else if exist "%USERPROFILE%\scoop\shims\bun.exe" (
        set "RUNTIME_CMD=%USERPROFILE%\scoop\shims\bun.exe"
    ) else (
        for /f "delims=" %%I in ('where bun 2^>nul') do if not defined RUNTIME_CMD set "RUNTIME_CMD=%%I"
    )
    if not defined RUNTIME_CMD (
        set "_has_powershell=0"
        if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
            set "_has_powershell=1"
        ) else (
            where powershell > nul 2>&1
            if !errorlevel! equ 0 set "_has_powershell=1"
        )
        if "!_has_powershell!"=="0" (
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
        if exist "%USERPROFILE%\.bun\bin\bun.exe" (
            set "RUNTIME_CMD=%USERPROFILE%\.bun\bin\bun.exe"
        ) else (
            for /f "delims=" %%I in ('where bun 2^>nul') do if not defined RUNTIME_CMD set "RUNTIME_CMD=%%I"
        )
    )
)

if "%_need_git%"=="1" (
    set "_has_git=0"
    if exist "%ProgramFiles%\Git\cmd\git.exe" (
        set "_has_git=1"
    ) else if exist "!ProgramFiles(x86)!\Git\cmd\git.exe" (
        set "_has_git=1"
    ) else if exist "%LocalAppData%\Programs\Git\cmd\git.exe" (
        set "_has_git=1"
    ) else if exist "%LocalAppData%\SillyBunny\MinGit\cmd\git.exe" (
        set "_has_git=1"
    ) else if exist "%USERPROFILE%\scoop\shims\git.exe" (
        set "_has_git=1"
    ) else (
        where git > nul 2>&1
        if !errorlevel! equ 0 set "_has_git=1"
    )
    if "!_has_git!"=="0" (
        set "_has_powershell=0"
        if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
            set "_has_powershell=1"
        ) else (
            where powershell > nul 2>&1
            if !errorlevel! equ 0 set "_has_powershell=1"
        )
        if "!_has_powershell!"=="0" (
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
    if defined RUNTIME_CMD (
        "%RUNTIME_CMD%" "%~dp0scripts\self-update.mjs" --optional
    ) else (
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Self-Update.ps1" -Optional
    )
    if !errorlevel! neq 0 goto end
)

if "%_need_git%"=="0" if "%_auto_update%"=="1" (
    echo [SillyBunny] Self-update skipped: this folder is not a Git checkout.
    echo [SillyBunny] ZIP installs are fully deprecated. Please reinstall with our new installer to get updates:
    echo [SillyBunny] https://github.com/SillyBunnyTeam/SillyBunny/releases/latest
    echo.
)

set NODE_ENV=production
set NODE_NO_WARNINGS=1
set SILLYBUNNY_LAUNCHER=1
set "_dependency_profile=!_server_runtime!-production"
if exist node_modules\eslint\package.json set "_dependency_profile=!_server_runtime!-development"

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
        node "%~dp0src\server-init.js"
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
        bun "%~dp0src\server-init.js"
    )
    if !errorlevel! neq 0 goto end
    if not exist "node_modules\.cache" mkdir "node_modules\.cache" > nul 2>&1
    (echo(!_boot_stamp!)>"!_boot_stamp_file!"
)

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
