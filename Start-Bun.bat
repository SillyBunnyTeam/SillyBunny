@echo off
REM Force SillyBunny to use Bun instead of Node.js.
setlocal
set "SILLYBUNNY_USE_NODE="
set "SILLYBUNNY_USE_BUN=1"
call "%~dp0Start.bat" %*
set "_exit=%errorlevel%"
endlocal & exit /b %_exit%
