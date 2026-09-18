@echo off
rem ===========================================================================
rem  deploy.bat - stop, swap, start                                #P202609_002
rem
rem  The one chunk that must not be split across ssh round trips. Between the
rem  two moves the live folder does not exist; every extra hop widens that hole.
rem
rem  INPUT (environment variables)
rem    DP_LIVE         live folder, the one the web server serves   (required)
rem    DP_STAGED       unpacked new build, ready to become live     (required)
rem    DP_BACKUP       where the current live is moved to           (required)
rem    DP_BACKUP_ROOT  parent of DP_BACKUP, created if absent       (optional)
rem    DP_PRESERVE     names to carry from DP_BACKUP into            (optional)
rem                    DP_STAGED, separated by ; or , or space.
rem                    Files and folders both work. Missing names
rem                    are skipped - a first deploy has none.
rem    WS_TYPE         which adapter to call: webserver_<TYPE>.bat  (required
rem                    unless WS_SKIP=1) e.g. iis
rem    WS_NAME         web server target, passed through            (required
rem                    unless WS_SKIP=1)
rem    WS_SKIP         1 = do not touch the web server at all       (optional)
rem    DRY_RUN         1 = print the plan, change nothing           (optional)
rem
rem  Any other WS_* variable is inherited by the adapter untouched (WS_POOL for
rem  IIS, and whatever a future adapter needs). This file does not interpret
rem  them - it knows nothing about IIS, and that is why it never has to change
rem  when a new web server is added.
rem
rem  EXIT CODES - same table as webserver.bat. See docs/design/*/06_*.md
rem    0  deployed
rem    1  failed
rem    2  bad or missing input
rem    3  insufficient privileges
rem    4  target not found
rem    5  FAILED AND COULD NOT ROLL BACK - live folder is missing. Manual fix.
rem
rem  ROLLBACK
rem    Everything after live->backup is rolled back: the preserve step and the
rem    staged->live move. Before that point the live folder is untouched, so
rem    there is nothing to undo. After a rollback the web server is started
rem    again but the exit code still reports failure - the deployment did fail,
rem    and reporting success would ship the old build as if it were new.
rem
rem  ENCODING: ASCII-only. See docs/design/*/06_*.md before adding Korean.
rem ===========================================================================

setlocal EnableExtensions

if not defined DP_LIVE (
    echo [deploy] DP_LIVE is required
    exit /b 2
)
if not defined DP_STAGED (
    echo [deploy] DP_STAGED is required
    exit /b 2
)
if not defined DP_BACKUP (
    echo [deploy] DP_BACKUP is required
    exit /b 2
)
rem No defaults. A guessed path here moves the wrong folder and the move
rem succeeds, so nothing reports an error until the site is already down.

rem cmd's mkdir/move/if-exist reject forward slashes ("The syntax of the command
rem is incorrect", measured 2026-09-01). YAML writes paths with slashes, so the
rem caller may hand them over that way. Normalise once, here.
set "DP_LIVE=%DP_LIVE:/=\%"
set "DP_STAGED=%DP_STAGED:/=\%"
set "DP_BACKUP=%DP_BACKUP:/=\%"
if defined DP_BACKUP_ROOT set "DP_BACKUP_ROOT=%DP_BACKUP_ROOT:/=\%"

set "SCRIPT_DIR=%~dp0"

if not exist "%DP_STAGED%" (
    echo [deploy] staged build not found: %DP_STAGED%
    exit /b 4
)
if not exist "%DP_LIVE%" (
    rem Refuse rather than create it. A mistyped DP_LIVE would otherwise deploy
    rem to a brand new folder and report success while the real site is stale.
    rem A genuine first deploy still has the folder: a web server cannot point
    rem at a path that does not exist, so it was created when the site was.
    echo [deploy] live folder not found: %DP_LIVE%
    echo [deploy]   create it first, or fix web_deploy_path
    exit /b 4
)
if exist "%DP_BACKUP%" (
    rem Refuse rather than merge into it. `move` into an existing directory
    rem nests instead of replacing, and the result looks like it worked.
    echo [deploy] backup path already exists: %DP_BACKUP%
    exit /b 1
)

echo [deploy] live   = %DP_LIVE%
echo [deploy] staged = %DP_STAGED%
echo [deploy] backup = %DP_BACKUP%

if "%DRY_RUN%"=="1" (
    echo [deploy] DRY_RUN stop web server
    echo [deploy] DRY_RUN move "%DP_LIVE%" -^> "%DP_BACKUP%"
    if defined DP_PRESERVE echo [deploy] DRY_RUN preserve %DP_PRESERVE%
    echo [deploy] DRY_RUN move "%DP_STAGED%" -^> "%DP_LIVE%"
    echo [deploy] DRY_RUN start web server
    exit /b 0
)


rem --- 1. stop -------------------------------------------------------------
call :webserver stop
if errorlevel 1 goto :propagate


rem --- 2. live -> backup ---------------------------------------------------
if defined DP_BACKUP_ROOT if not exist "%DP_BACKUP_ROOT%" mkdir "%DP_BACKUP_ROOT%"

move "%DP_LIVE%" "%DP_BACKUP%" > nul
if errorlevel 1 (
    echo [deploy] failed to move live to backup
    rem Live was never moved, so it is still serving. Put the server back up.
    call :webserver start
    exit /b 1
)

rem From here the live folder does not exist. Everything below must either
rem finish or restore it.


rem --- 3. carry runtime data from the old build into the new one -----------
rem
rem Runtime folders (uploads, caches, an operator-edited config) live inside
rem the deployed folder, so a whole-folder swap drops them. They are copied
rem AFTER the stop on purpose: while the service runs those files are being
rem written, and a copy taken then is torn.
rem
rem Absent names are not an error - a first deploy has none of them yet.
if defined DP_PRESERVE (
    for %%N in (%DP_PRESERVE%) do (
        call :preserve "%%~N"
        if errorlevel 1 goto :undo
    )
)


rem --- 4. staged -> live ---------------------------------------------------
move "%DP_STAGED%" "%DP_LIVE%" > nul
if errorlevel 1 goto :undo


rem --- 5. start ------------------------------------------------------------
call :webserver start
if errorlevel 1 goto :propagate

echo [deploy] OK  backup=%DP_BACKUP%
exit /b 0


rem ---------------------------------------------------------------------------
rem  :undo - put the previous build back
rem
rem  Reached only from inside the window where the live folder does not exist.
rem  Flattened into a label instead of nested parentheses: an `exit /b` two
rem  levels deep LOSES the exit code - the message prints and the caller still
rem  reads 0. See docs/design/*/06_*.md section 4.
rem ---------------------------------------------------------------------------
:undo
    echo [deploy] failed after the live folder was moved - rolling back
    move "%DP_BACKUP%" "%DP_LIVE%" > nul
    if errorlevel 1 goto :undo_failed
    echo [deploy] rolled back to the previous build
    call :webserver start
    rem Deployment failed even though the service is back up. Reporting 0 here
    rem would ship the old build as if it were the new one.
    exit /b 1

:undo_failed
    echo [deploy] ROLLBACK FAILED. Live folder is missing.
    echo [deploy]   restore by hand: move "%DP_BACKUP%" "%DP_LIVE%"
    rem Do not start the web server on an empty path - it would serve 404s and
    rem look alive to a health check.
    exit /b 5


rem NOTE: `call :x || exit /b %ERRORLEVEL%` does not work - %ERRORLEVEL% expands
rem when the LINE is parsed, before the call runs, so it always exits 0.
rem Jumping here keeps the real code because this line is parsed after the jump.
:propagate
    exit /b %ERRORLEVEL%


rem ---------------------------------------------------------------------------
rem  :preserve <name>
rem  Copies one name from the previous build into the staged one. Folders and
rem  files both. A name that is not in the previous build is not an error.
rem ---------------------------------------------------------------------------
:preserve
    set "PS_FROM=%DP_BACKUP%\%~1"
    set "PS_TO=%DP_STAGED%\%~1"

    if not exist "%PS_FROM%" (
        echo [deploy] preserve %~1 - not in the previous build, skipped
        exit /b 0
    )

    rem A trailing backslash matches directories only.
    if exist "%PS_FROM%\" goto :preserve_dir

    copy /y "%PS_FROM%" "%PS_TO%" > nul
    if errorlevel 1 (
        echo [deploy] preserve %~1 - copy failed
        exit /b 1
    )
    echo [deploy] preserve %~1
    exit /b 0

:preserve_dir
    robocopy "%PS_FROM%" "%PS_TO%" /E /NFL /NDL /NJH /NJS /R:1 /W:1 > nul
    rem robocopy returns 1 for a NORMAL copy. Only 8 and above are failures -
    rem treating 1 as an error would fail every successful preserve.
    if errorlevel 8 goto :preserve_dir_failed
    rem Reset ERRORLEVEL: robocopy's 1 would otherwise be read as failure by the
    rem caller's `if errorlevel 1`.
    ver > nul
    echo [deploy] preserve %~1\
    exit /b 0

:preserve_dir_failed
    echo [deploy] preserve %~1 - copy failed
    exit /b 1


rem ---------------------------------------------------------------------------
rem  :webserver <stop|start>
rem  Delegates to webserver_<WS_TYPE>.bat so the web server lives in exactly one
rem  file. Adding nginx means adding webserver_nginx.bat next to this script -
rem  nothing here changes.
rem ---------------------------------------------------------------------------
:webserver
    if "%WS_SKIP%"=="1" (
        echo [deploy] web server control skipped ^(WS_SKIP=1^)
        exit /b 0
    )
    if not defined WS_TYPE (
        echo [deploy] WS_TYPE is required unless WS_SKIP=1 ^(e.g. iis^)
        exit /b 2
    )
    if not defined WS_NAME (
        echo [deploy] WS_NAME is required unless WS_SKIP=1
        exit /b 2
    )

    set "WS_ADAPTER=%SCRIPT_DIR%webserver_%WS_TYPE%.bat"
    if not exist "%WS_ADAPTER%" (
        rem Fail loudly. Skipping an unknown type would swap the folders and
        rem leave the old process serving the new files.
        echo [deploy] no adapter for WS_TYPE=%WS_TYPE%: %WS_ADAPTER%
        exit /b 4
    )

    setlocal
    set "WS_ACTION=%~1"
    call "%WS_ADAPTER%"
    endlocal & exit /b %ERRORLEVEL%
