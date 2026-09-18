@echo off
rem ===========================================================================
rem  rollback.bat - restore the live folder from a backup          #P202609_002
rem
rem  Which backup to restore is a JUDGEMENT, so Node makes it (deploy history,
rem  index clamping) and hands the resolved paths here. This script only moves
rem  folders and drives the web server. See docs/design/*/06_*.md [D10].
rem
rem  INPUT (environment variables)
rem    RB_LIVE     live folder to restore into                     (required)
rem    RB_SOURCE   backup folder to restore from                   (required)
rem    RB_ASIDE    where the current live is moved out of the way  (required)
rem    RB_MODE     consume | copy                                  (required)
rem    RB_TEMP     scratch copy target, copy mode only             (required
rem                when RB_MODE=copy)
rem    RB_PRESERVE names to carry from the current live into the   (optional)
rem                build being restored, separated by ; or , or
rem                space. Same list and same rule as DP_PRESERVE in
rem                deploy.bat - a rollback must not drop runtime data
rem                that a deploy would have kept.
rem    WS_TYPE     adapter to call: webserver_<TYPE>.bat           (required
rem                unless WS_SKIP=1)
rem    WS_NAME     web server target, passed through               (required
rem                unless WS_SKIP=1)
rem    WS_SKIP     1 = do not touch the web server
rem    DRY_RUN     1 = print the plan, change nothing
rem
rem  THE TWO MODES
rem    consume   Roll back during a deploy. The backup this run just created is
rem              MOVED back, so it is consumed. The failed build is kept as
rem              RB_ASIDE (<live>_failed_<stamp>) for a human to inspect. The
rem              next successful deploy removes it (Node does, not this script).
rem    copy      Forced rollback to an older build. The backup is COPIED so the
rem              original survives for the next rollback. The live it replaced
rem              is DELETED once the site is back up: a forced rollback means
rem              that live was bad, and the deploy archive (zip) is the copy to
rem              go forward from - not this folder. Runtime data it held has
rem              already been carried over by RB_PRESERVE.
rem
rem  EXIT CODES - same table as deploy.bat
rem    0  restored
rem    1  failed, live folder is intact
rem    2  bad or missing input
rem    3  insufficient privileges
rem    4  backup not found
rem    5  FAILED AND LIVE IS MISSING. Manual fix.
rem
rem  ENCODING: ASCII-only. See docs/design/*/06_*.md before adding Korean.
rem ===========================================================================

setlocal EnableExtensions

if not defined RB_LIVE (
    echo [rollback] RB_LIVE is required
    exit /b 2
)
if not defined RB_SOURCE (
    echo [rollback] RB_SOURCE is required
    exit /b 2
)
if not defined RB_ASIDE (
    echo [rollback] RB_ASIDE is required
    exit /b 2
)
if /i "%RB_MODE%"=="consume" goto :mode_ok
if /i "%RB_MODE%"=="copy"    goto :mode_ok
echo [rollback] RB_MODE must be consume or copy ^(got "%RB_MODE%"^)
exit /b 2
:mode_ok

rem cmd's move/mkdir/if-exist reject forward slashes. YAML writes them that way.
set "RB_LIVE=%RB_LIVE:/=\%"
set "RB_SOURCE=%RB_SOURCE:/=\%"
set "RB_ASIDE=%RB_ASIDE:/=\%"
if defined RB_TEMP set "RB_TEMP=%RB_TEMP:/=\%"

set "SCRIPT_DIR=%~dp0"

rem Check the backup BEFORE stopping anything. Taking the site down for a
rem backup that is not there would turn a bad deploy into an outage.
if not exist "%RB_SOURCE%" (
    echo [rollback] backup not found: %RB_SOURCE%
    echo [rollback]   the deploy history still lists it - find out who removed it
    exit /b 4
)

rem Flat, not nested. An `exit /b` inside a nested parenthesised block does not
rem reliably set the exit code - the message prints and the script still reports
rem success (measured 2026-09-17). Batch nesting is not worth the risk here.
if /i not "%RB_MODE%"=="copy" goto :temp_checked

if not defined RB_TEMP (
    echo [rollback] RB_TEMP is required when RB_MODE=copy
    exit /b 2
)
if exist "%RB_TEMP%" (
    echo [rollback] scratch path already exists: %RB_TEMP%
    exit /b 1
)
:temp_checked

if exist "%RB_ASIDE%" (
    echo [rollback] aside path already exists: %RB_ASIDE%
    exit /b 1
)

echo [rollback] mode   = %RB_MODE%
echo [rollback] live   = %RB_LIVE%
echo [rollback] source = %RB_SOURCE%
echo [rollback] aside  = %RB_ASIDE%
if defined RB_PRESERVE echo [rollback] preserve = %RB_PRESERVE%

if "%DRY_RUN%"=="1" (
    if /i "%RB_MODE%"=="copy" echo [rollback] DRY_RUN robocopy "%RB_SOURCE%" -^> "%RB_TEMP%"
    echo [rollback] DRY_RUN stop web server
    echo [rollback] DRY_RUN move "%RB_LIVE%" -^> "%RB_ASIDE%"
    if defined RB_PRESERVE echo [rollback] DRY_RUN preserve %RB_PRESERVE%
    echo [rollback] DRY_RUN move source -^> "%RB_LIVE%"
    echo [rollback] DRY_RUN start web server
    if /i "%RB_MODE%"=="copy" echo [rollback] DRY_RUN remove "%RB_ASIDE%"
    exit /b 0
)


rem --- 0. copy mode: duplicate the backup WHILE THE SITE IS STILL UP ---------
rem Doing this before the stop keeps the outage down to two renames.
set "RB_SRC=%RB_SOURCE%"
if /i not "%RB_MODE%"=="copy" goto :copied

echo [rollback] Step 0: copying backup -^> %RB_TEMP%
robocopy "%RB_SOURCE%" "%RB_TEMP%" /E /NFL /NDL /NJH /NJS /R:1 /W:1
rem robocopy returns 1 for a NORMAL copy. Only 8 and above are failures;
rem treating non-zero as an error would fail every successful rollback.
if errorlevel 8 (
    echo [rollback] backup copy failed
    exit /b 1
)
rem Clear the leftover robocopy code so later checks see a clean slate.
ver > nul
set "RB_SRC=%RB_TEMP%"
:copied


rem --- 1. stop --------------------------------------------------------------
call :webserver stop
if errorlevel 1 goto :propagate


rem --- 2. current live -> aside ---------------------------------------------
rem `if exist` because a previous failure may have left no live folder at all.
if exist "%RB_LIVE%" (
    move "%RB_LIVE%" "%RB_ASIDE%" > nul
    if errorlevel 1 (
        echo [rollback] failed to move live aside
        rem Live was never moved, so it is still there. Bring the service back.
        call :webserver start
        exit /b 1
    )
)


rem --- 2.5 carry runtime data from the live being replaced ------------------
rem
rem Same rule as deploy.bat step 3, for the same reason: uploads and caches
rem live inside the served folder, so swapping the folder drops them. A
rem rollback puts back OLDER code, but the data written since then is still
rem current - losing it because the code went back would be wrong. It is
rem copied into the build being restored BEFORE that becomes live, with the
rem web server already stopped so the copy is not torn.
rem
rem The source is the folder just moved aside. With no live folder (left by an
rem earlier failure) there is nothing to carry and every name is skipped.
if defined RB_PRESERVE (
    for %%N in (%RB_PRESERVE%) do (
        call :preserve "%%~N"
        if errorlevel 1 goto :preserve_failed
    )
)


rem --- 3. backup -> live ----------------------------------------------------
move "%RB_SRC%" "%RB_LIVE%" > nul
if errorlevel 1 goto :restore_failed
goto :restored

rem Flat rather than nested - see the note above :temp_checked.
:preserve_failed
    echo [rollback] failed to carry runtime data - undoing
    goto :undo

:restore_failed
    echo [rollback] failed to move backup into place - undoing
    goto :undo

:undo
    if not exist "%RB_ASIDE%" (
        echo [rollback] LIVE IS MISSING and there was nothing to undo.
        echo [rollback]   candidates: "%RB_SRC%"  "%RB_SOURCE%"
        exit /b 5
    )

    move "%RB_ASIDE%" "%RB_LIVE%" > nul
    if errorlevel 1 (
        echo [rollback] UNDO FAILED. Live folder is missing.
        echo [rollback]   restore by hand: move "%RB_ASIDE%" "%RB_LIVE%"
        rem Do not start on an empty path - it would serve 404s and look
        rem healthy to a health check.
        exit /b 5
    )

    echo [rollback] undone - live is back to the state before this rollback
    call :webserver start
    exit /b 1

:restored


rem --- 4. start -------------------------------------------------------------
rem Always attempt the start, even if something above complained. Leaving the
rem service down is worse than a noisy log.
call :webserver start
if errorlevel 1 goto :propagate

echo [rollback] OK  restored from %RB_SOURCE%
if /i "%RB_MODE%"=="copy" goto :drop_aside
echo [rollback] failed build kept at %RB_ASIDE%
echo [rollback]   the next successful deploy removes it
exit /b 0


rem --- 5. copy mode: delete the live that was replaced -----------------------
rem Only after the start succeeded - until then it is the undo copy. The site
rem is already serving, so the time this takes is not downtime.
rem
rem rmdir does not set ERRORLEVEL reliably, so check whether the folder is
rem still there. Failing to delete is NOT a failed rollback - the restore is
rem done. Node removes the leftover on the next successful deploy.
:drop_aside
if exist "%RB_ASIDE%" rmdir /s /q "%RB_ASIDE%"
if exist "%RB_ASIDE%" goto :drop_aside_failed
echo [rollback] replaced live removed
exit /b 0

:drop_aside_failed
echo [rollback] WARNING could not remove %RB_ASIDE%
echo [rollback]   the next successful deploy removes it
exit /b 0


rem NOTE: `call :x || exit /b %ERRORLEVEL%` does not work - %ERRORLEVEL% expands
rem when the LINE is parsed, before the call runs, so it always exits 0.
:propagate
    exit /b %ERRORLEVEL%


rem ---------------------------------------------------------------------------
rem  :preserve <name>
rem  Copies one name from the live being replaced (RB_ASIDE) into the build
rem  being restored (RB_SRC). Mirrors :preserve in deploy.bat - keep the two in
rem  step. A name that is not in the current live is not an error.
rem ---------------------------------------------------------------------------
:preserve
    set "PS_FROM=%RB_ASIDE%\%~1"
    set "PS_TO=%RB_SRC%\%~1"

    if not exist "%PS_FROM%" (
        echo [rollback] preserve %~1 - not in the current live, skipped
        exit /b 0
    )

    rem A trailing backslash matches directories only.
    if exist "%PS_FROM%\" goto :preserve_dir

    copy /y "%PS_FROM%" "%PS_TO%" > nul
    if errorlevel 1 (
        echo [rollback] preserve %~1 - copy failed
        exit /b 1
    )
    echo [rollback] preserve %~1
    exit /b 0

:preserve_dir
    robocopy "%PS_FROM%" "%PS_TO%" /E /NFL /NDL /NJH /NJS /R:1 /W:1 > nul
    rem robocopy returns 1 for a NORMAL copy. Only 8 and above are failures.
    if errorlevel 8 goto :preserve_dir_failed
    rem Reset ERRORLEVEL so the caller's `if errorlevel 1` does not read the 1.
    ver > nul
    echo [rollback] preserve %~1\
    exit /b 0

:preserve_dir_failed
    echo [rollback] preserve %~1 - copy failed
    exit /b 1


rem ---------------------------------------------------------------------------
rem  :webserver <stop|start>   - same contract as deploy.bat
rem ---------------------------------------------------------------------------
:webserver
    if "%WS_SKIP%"=="1" (
        echo [rollback] web server control skipped ^(WS_SKIP=1^)
        exit /b 0
    )
    if not defined WS_TYPE (
        echo [rollback] WS_TYPE is required unless WS_SKIP=1 ^(e.g. iis^)
        exit /b 2
    )
    if not defined WS_NAME (
        echo [rollback] WS_NAME is required unless WS_SKIP=1
        exit /b 2
    )

    set "WS_ADAPTER=%SCRIPT_DIR%webserver_%WS_TYPE%.bat"
    if not exist "%WS_ADAPTER%" (
        echo [rollback] no adapter for WS_TYPE=%WS_TYPE%: %WS_ADAPTER%
        exit /b 4
    )

    setlocal
    set "WS_ACTION=%~1"
    call "%WS_ADAPTER%"
    endlocal & exit /b %ERRORLEVEL%
