@echo off
rem ===========================================================================
rem  patch.bat - static deploy: copy changed files over the live folder
rem
rem  The fast path for a change that touches only views and assets. There is
rem  no build, no stop, no backup and no swap: Razor views are compiled at
rem  runtime and assets are read per request, so overwriting the files is the
rem  whole deploy. WHICH files is a judgement - Node makes it from the deploy
rem  history (last successful commit of this environment) and hands over a
rem  folder holding exactly those files, laid out like the live folder.
rem
rem  INPUT (environment variables)
rem    PT_LIVE     live folder to update                          (required)
rem    PT_SOURCE   folder with the changed files, same layout      (required)
rem    WS_TYPE     adapter to call: webserver_<TYPE>.bat           (required
rem                unless WS_SKIP=1)
rem    WS_NAME     web server target, passed through               (required
rem                unless WS_SKIP=1)
rem    WS_SKIP     1 = do not touch the web server
rem    DRY_RUN     1 = print the plan, change nothing
rem
rem  THE WEB SERVER
rem    A running server is left alone - no restart, so Node skips the health
rem    check. A server that is NOT running is started after the copy, and the
rem    exit code says so (6) so that Node runs the health check.
rem
rem  EXIT CODES - see scriptExit.js (PATCH)
rem    0  copied, web server was running and was not touched
rem    6  copied, web server was not running and has been started. SUCCESS
rem    1  copy failed - some files may already be in the live folder. Static
rem       files only, and the next deploy copies the same range again
rem    2  bad or missing input
rem    3  insufficient privileges
rem    4  live folder not found (or web server target / adapter missing)
rem
rem  Deletions are NOT mirrored: a file removed from git stays on the server.
rem  That is a 2026-08-27 decision - wwwroot can hold runtime uploads.
rem
rem  ENCODING: ASCII-only. See docs/design/*/06_*.md before adding Korean.
rem ===========================================================================

setlocal EnableExtensions

if not defined PT_LIVE (
    echo [patch] PT_LIVE is required
    exit /b 2
)
if not defined PT_SOURCE (
    echo [patch] PT_SOURCE is required
    exit /b 2
)

rem cmd rejects forward slashes in paths. YAML writes them that way.
set "PT_LIVE=%PT_LIVE:/=\%"
set "PT_SOURCE=%PT_SOURCE:/=\%"

set "SCRIPT_DIR=%~dp0"

rem A trailing backslash matches directories only. A typo in the live path
rem must not create a new folder that nobody serves.
if not exist "%PT_LIVE%\" (
    echo [patch] live folder not found: %PT_LIVE%
    exit /b 4
)
if not exist "%PT_SOURCE%\" (
    echo [patch] source folder not found: %PT_SOURCE%
    exit /b 2
)

echo [patch] live   = %PT_LIVE%
echo [patch] source = %PT_SOURCE%

if "%DRY_RUN%"=="1" (
    echo [patch] DRY_RUN robocopy "%PT_SOURCE%" -^> "%PT_LIVE%"
    echo [patch] DRY_RUN start web server only if it is not running
    exit /b 0
)


rem --- 1. copy --------------------------------------------------------------
rem /IS /IT copy even when size and time match - the folder already holds only
rem the files Node chose, so every one of them is meant to land.
rem /R:3 /W:2 because a view or template can be open for a moment.
rem The file list stays in the log: it is the record of what changed on live.
robocopy "%PT_SOURCE%" "%PT_LIVE%" /E /IS /IT /NDL /NJH /NJS /NP /R:3 /W:2
rem robocopy returns 1 for a NORMAL copy. Only 8 and above are failures.
if errorlevel 8 goto :copy_failed
ver > nul
echo [patch] files copied


rem --- 2. web server: start it only if it is down ------------------------------
if "%WS_SKIP%"=="1" (
    echo [patch] web server control skipped ^(WS_SKIP=1^)
    exit /b 0
)

call :webserver status
set "PT_WS=%ERRORLEVEL%"
if "%PT_WS%"=="0" goto :running
if "%PT_WS%"=="6" goto :start_it

echo [patch] could not read the web server state ^(code %PT_WS%^)
echo [patch]   the files are already copied
exit /b %PT_WS%

:running
echo [patch] OK  web server is running - not restarted
exit /b 0

:start_it
echo [patch] web server is not running - starting it
call :webserver start
if errorlevel 1 goto :propagate
echo [patch] OK  web server started
exit /b 6

:copy_failed
echo [patch] copy failed - some files may already be in the live folder
echo [patch]   the next deploy copies the same range again
exit /b 1


rem NOTE: `call :x || exit /b %ERRORLEVEL%` does not work - %ERRORLEVEL% expands
rem when the LINE is parsed, before the call runs, so it always exits 0.
:propagate
    exit /b %ERRORLEVEL%


rem ---------------------------------------------------------------------------
rem  :webserver <status|start>   - same contract as deploy.bat
rem ---------------------------------------------------------------------------
:webserver
    if not defined WS_TYPE (
        echo [patch] WS_TYPE is required unless WS_SKIP=1 ^(e.g. iis^)
        exit /b 2
    )
    if not defined WS_NAME (
        echo [patch] WS_NAME is required unless WS_SKIP=1
        exit /b 2
    )

    set "WS_ADAPTER=%SCRIPT_DIR%webserver_%WS_TYPE%.bat"
    if not exist "%WS_ADAPTER%" (
        echo [patch] no adapter for WS_TYPE=%WS_TYPE%: %WS_ADAPTER%
        exit /b 4
    )

    setlocal
    set "WS_ACTION=%~1"
    call "%WS_ADAPTER%"
    endlocal & exit /b %ERRORLEVEL%
