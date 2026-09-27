@echo off
rem ===========================================================================
rem  deploy.bat - put the new build live                 #P202609_002 #P202609_003
rem
rem  Two modes. The caller picks; this script does not guess.
rem
rem    copy  overwrite the live folder in place   stop -> robocopy -> start
rem    swap  exchange whole folders               stop -> rename x2 -> delta -> start
rem
rem  WHY TWO
rem    swap is atomic and fast, but it RENAMES the live folder - and Windows
rem    refuses to rename a folder anything holds a handle in. One operator with
rem    a cmd window open inside it blocks every deploy until they close it.
rem    copy never renames, so it survives that; the cost is that a failure
rem    halfway leaves the live folder mixed (exit 5, see below).
rem
rem  INPUT (environment variables)
rem    DP_MODE         copy | swap                                  (required)
rem    DP_LIVE         live folder, the one the web server serves   (required)
rem    DP_STAGED       unpacked new build, ready to go live         (required)
rem    DP_ORG          swap only: where the current live is renamed (required
rem                    to. It stays until the health check passes.   for swap)
rem    DP_DELTA        swap only: names to catch up from DP_ORG      (optional)
rem                    after the swap - the runtime files written
rem                    between the bulk copy and the stop.
rem                    Separated by ; or , or space.
rem    DP_EXCLUDE      copy only: names NOT to copy over the live    (optional)
rem                    folder. The server's own config lives there.
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
rem  WHAT THIS SCRIPT NO LONGER DOES
rem    Carrying the bulk of the runtime data (the old DP_PRESERVE) moved OUT of
rem    here: Node copies it BEFORE the stop, while the service is still up, so
rem    the outage is two renames plus DP_DELTA. Backups moved out too - the
rem    backup is now the preserved data plus the confirmed build zip, and Node
rem    owns both. See docs/design/*/06_*.md.
rem
rem  EXIT CODES - see scriptExit.js (DEPLOY)
rem    0  deployed
rem    1  failed, and the live folder is untouched or was put back
rem    2  bad or missing input
rem    3  insufficient privileges
rem    4  target not found
rem    5  FAILED AND THE LIVE FOLDER IS NOT INTACT. A human has to fix it.
rem       swap: the rename back failed - the live folder is missing.
rem       copy: the copy died midway - live is part old build, part new.
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
if not defined DP_MODE (
    rem No default. "copy" and "swap" fail in different ways and leave the live
    rem folder in different states; guessing one would pick the caller's
    rem recovery plan for them.
    echo [deploy] DP_MODE is required ^(copy^|swap^)
    exit /b 2
)
if /i "%DP_MODE%"=="swap" if not defined DP_ORG (
    echo [deploy] DP_ORG is required when DP_MODE=swap
    exit /b 2
)

rem cmd's mkdir/move/if-exist reject forward slashes ("The syntax of the command
rem is incorrect", measured 2026-09-01). YAML writes paths with slashes, so the
rem caller may hand them over that way. Normalise once, here.
set "DP_LIVE=%DP_LIVE:/=\%"
set "DP_STAGED=%DP_STAGED:/=\%"
if defined DP_ORG set "DP_ORG=%DP_ORG:/=\%"

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

if /i "%DP_MODE%"=="copy" goto :mode_ok
if /i "%DP_MODE%"=="swap" goto :mode_ok
echo [deploy] DP_MODE must be copy or swap ^(got "%DP_MODE%"^)
exit /b 2

:mode_ok
if /i "%DP_MODE%"=="swap" if exist "%DP_ORG%" (
    rem Refuse rather than merge into it. `move` into an existing directory
    rem nests instead of replacing, and the result looks like it worked.
    echo [deploy] org path already exists: %DP_ORG%
    exit /b 1
)

echo [deploy] mode   = %DP_MODE%
echo [deploy] live   = %DP_LIVE%
echo [deploy] staged = %DP_STAGED%
if /i "%DP_MODE%"=="swap" echo [deploy] org    = %DP_ORG%

if "%DRY_RUN%"=="1" (
    echo [deploy] DRY_RUN stop web server
    if /i "%DP_MODE%"=="swap" echo [deploy] DRY_RUN move "%DP_LIVE%" -^> "%DP_ORG%"
    if /i "%DP_MODE%"=="swap" echo [deploy] DRY_RUN move "%DP_STAGED%" -^> "%DP_LIVE%"
    if /i "%DP_MODE%"=="swap" if defined DP_DELTA echo [deploy] DRY_RUN delta %DP_DELTA%
    if /i "%DP_MODE%"=="copy" echo [deploy] DRY_RUN robocopy "%DP_STAGED%" -^> "%DP_LIVE%"
    if /i "%DP_MODE%"=="copy" if defined DP_EXCLUDE echo [deploy] DRY_RUN exclude %DP_EXCLUDE%
    echo [deploy] DRY_RUN start web server
    exit /b 0
)


rem --- 1. stop -------------------------------------------------------------
call :webserver stop
if errorlevel 1 goto :propagate

if /i "%DP_MODE%"=="copy" goto :do_copy


rem ===========================================================================
rem  swap
rem ===========================================================================

rem --- 2. live -> org ------------------------------------------------------
move "%DP_LIVE%" "%DP_ORG%" > nul
if errorlevel 1 (
    echo [deploy] failed to move live aside
    rem Live was never moved, so it is still serving. Put the server back up.
    call :webserver start
    exit /b 1
)

rem From here the live folder does not exist. Everything below must either
rem finish or restore it.


rem --- 3. staged -> live ---------------------------------------------------
move "%DP_STAGED%" "%DP_LIVE%" > nul
if errorlevel 1 goto :undo


rem --- 4. delta: catch up what was written during the bulk copy -------------
rem
rem Node copied the runtime data into DP_STAGED BEFORE the stop, while the
rem service was still writing. Anything written between that copy and the stop
rem is only in the old build - which is now DP_ORG. /XO copies just those: the
rem bulk has identical timestamps and is skipped, so this is small and fast.
rem
rem It runs BEFORE the start on purpose. After the start, a file that a user
rem uploaded seconds ago would be missing for as long as this takes.
if defined DP_DELTA (
    for %%N in (%DP_DELTA%) do (
        call :delta "%%~N"
        if errorlevel 1 goto :undo
    )
)


rem --- 5. start ------------------------------------------------------------
call :webserver start
if errorlevel 1 goto :propagate

echo [deploy] OK  swapped, previous build at %DP_ORG%
exit /b 0


rem ===========================================================================
rem  copy - overwrite in place. The live folder is never renamed.
rem ===========================================================================
:do_copy
    rem /E     include subfolders, empty ones too
    rem /IS /IT copy even when size and time match - the staged folder holds
    rem         exactly what this deploy means to put live
    rem /R:2 /W:2 a file can be held for a moment right after the stop
    rem
    rem Deletions are NOT mirrored (no /MIR): a file dropped from the build stays
    rem on the server. /MIR here would delete the runtime data too, and the names
    rem to spare are not all known to this script. Cleaning up accumulated files
    rem is what a swap deploy does - see docs/design/*/06_*.md.
    call :exclude_args
    robocopy "%DP_STAGED%" "%DP_LIVE%" /E /IS /IT /NFL /NDL /NJH /NJS /NP /R:2 /W:2 %XARGS%
    rem robocopy returns 1 for a NORMAL copy. Only 8 and above are failures -
    rem treating 1 as an error would fail every successful deploy.
    if errorlevel 8 goto :copy_failed
    ver > nul

    call :webserver start
    if errorlevel 1 goto :propagate

    echo [deploy] OK  copied into %DP_LIVE%
    exit /b 0

:copy_failed
    rem No undo from here. Unlike swap there is no folder holding the previous
    rem build - it was overwritten file by file. The live folder is now part old
    rem and part new, which is why this is 5 and not 1: Node restores the last
    rem confirmed build zip over it.
    echo [deploy] COPY FAILED midway - the live folder is part old, part new
    echo [deploy]   restore the last confirmed build over %DP_LIVE%
    rem Do not start the web server on a half-written folder.
    exit /b 5

rem ---------------------------------------------------------------------------
rem  :exclude_args - turn DP_EXCLUDE into robocopy /XF and /XD arguments
rem
rem  Both, because a name can be a file (web.config) or a folder. robocopy takes
rem  bare names and matches them anywhere in the tree.
rem ---------------------------------------------------------------------------
:exclude_args
    set "XARGS="
    if not defined DP_EXCLUDE exit /b 0
    for %%N in (%DP_EXCLUDE%) do call :exclude_one "%%~N"
    exit /b 0

:exclude_one
    set "XARGS=%XARGS% /XF "%DP_STAGED%\%~1" /XD "%DP_STAGED%\%~1""
    exit /b 0


rem ---------------------------------------------------------------------------
rem  :undo - put the previous build back (swap only)
rem
rem  Reached only from inside the window where the live folder does not exist.
rem  Flattened into a label instead of nested parentheses: an `exit /b` two
rem  levels deep LOSES the exit code - the message prints and the caller still
rem  reads 0. See docs/design/*/06_*.md section 4.
rem ---------------------------------------------------------------------------
:undo
    echo [deploy] failed after the live folder was moved - rolling back
    if exist "%DP_LIVE%" move "%DP_LIVE%" "%DP_STAGED%" > nul
    move "%DP_ORG%" "%DP_LIVE%" > nul
    if errorlevel 1 goto :undo_failed
    echo [deploy] rolled back to the previous build
    call :webserver start
    rem Deployment failed even though the service is back up. Reporting 0 here
    rem would ship the old build as if it were the new one.
    exit /b 1

:undo_failed
    echo [deploy] ROLLBACK FAILED. Live folder is missing.
    echo [deploy]   restore by hand: move "%DP_ORG%" "%DP_LIVE%"
    rem Do not start the web server on an empty path - it would serve 404s and
    rem look alive to a health check.
    exit /b 5


rem NOTE: `call :x || exit /b %ERRORLEVEL%` does not work - %ERRORLEVEL% expands
rem when the LINE is parsed, before the call runs, so it always exits 0.
rem Jumping here keeps the real code because this line is parsed after the jump.
:propagate
    exit /b %ERRORLEVEL%


rem ---------------------------------------------------------------------------
rem  :delta <name>
rem  Copies what changed in one name from the old build (DP_ORG) into the new
rem  live folder. /XO leaves alone anything the new build already has newer.
rem  A name that is not in the old build is not an error - a first deploy has none.
rem ---------------------------------------------------------------------------
:delta
    set "DL_FROM=%DP_ORG%\%~1"
    set "DL_TO=%DP_LIVE%\%~1"

    if not exist "%DL_FROM%" (
        echo [deploy] delta %~1 - not in the previous build, skipped
        exit /b 0
    )

    rem A trailing backslash matches directories only.
    if exist "%DL_FROM%\" goto :delta_dir

    rem Single file: copy only when the old one is newer, same rule as /XO.
    xcopy "%DL_FROM%" "%DL_TO%*" /Y /D /Q > nul
    if errorlevel 1 (
        echo [deploy] delta %~1 - copy failed
        exit /b 1
    )
    echo [deploy] delta %~1
    exit /b 0

:delta_dir
    robocopy "%DL_FROM%" "%DL_TO%" /E /XO /NFL /NDL /NJH /NJS /R:1 /W:1 > nul
    rem robocopy returns 1 for a NORMAL copy. Only 8 and above are failures -
    rem treating 1 as an error would fail every successful delta.
    if errorlevel 8 goto :delta_dir_failed
    rem Reset ERRORLEVEL: robocopy's 1 would otherwise be read as failure by the
    rem caller's `if errorlevel 1`.
    ver > nul
    echo [deploy] delta %~1\
    exit /b 0

:delta_dir_failed
    echo [deploy] delta %~1 - copy failed
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
