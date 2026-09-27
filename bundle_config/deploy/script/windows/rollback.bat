@echo off
rem ===========================================================================
rem  rollback.bat - put a confirmed build back live      #P202609_002 #P202609_003
rem
rem  The source is a CONFIRMED BUILD ZIP, not a backup folder. A deploy that
rem  passed its health check keeps its zip (Node does that), so rolling back is
rem  "deploy that zip again" - the same path a normal deploy takes, which means
rem  it is exercised every day instead of only in an emergency.
rem
rem  TWO SOURCES, ONE PROCEDURE
rem    RB_ZIP     a confirmed build - unpack it, then swap it in.
rem    RB_SOURCE  a folder that already holds the build to restore, normally the
rem               <live>_org_<stamp> a swap left behind. Nothing to unpack, so
rem               this is the seconds-long path a failed health check takes.
rem    Exactly one of the two. Everything after staging is identical.
rem
rem  INPUT (environment variables)
rem    RB_LIVE     live folder to restore into                     (required)
rem    RB_ZIP      confirmed build zip to restore                  (one of
rem    RB_SOURCE   folder holding the build to restore              the two)
rem    RB_STAGE    empty scratch folder to unpack into             (required
rem                                                                 with RB_ZIP)
rem    RB_ASIDE    where the current live is moved out of the way  (required)
rem    RB_STRIP    tar --strip-components (default 1)              (optional)
rem    RB_CARRY    names to carry from the CURRENT live into the   (optional)
rem                build being restored, separated by ; or , or
rem                space. Rolling back returns the CODE to an
rem                older build; the DATA stays current.
rem    WS_TYPE     adapter to call: webserver_<TYPE>.bat           (required
rem    WS_NAME     web server target                                unless
rem    WS_SKIP     1 = do not touch the web server                  WS_SKIP=1)
rem    DRY_RUN     1 = print the plan, change nothing
rem
rem  EXIT CODES - see scriptExit.js (ROLLBACK)
rem    0  restored
rem    1  failed, live is untouched (or was put back)
rem    2  bad or missing input
rem    3  insufficient privileges
rem    4  the zip or the adapter was not found
rem    5  FAILED AND LIVE IS MISSING. A human has to fix it.
rem
rem  The replaced build is left at RB_ASIDE (<live>_replaced_<stamp>) instead of
rem  being deleted: it is usually the build that just broke, and that is worth
rem  looking at. The next successful deploy cleans it up.
rem
rem  ENCODING: ASCII-only. See docs/design/*/06_*.md before adding Korean.
rem ===========================================================================

setlocal EnableExtensions

if not defined RB_LIVE (
    echo [rollback] RB_LIVE is required
    exit /b 2
)
if not defined RB_ZIP if not defined RB_SOURCE (
    echo [rollback] one of RB_ZIP ^(confirmed build^) or RB_SOURCE ^(folder^) is required
    exit /b 2
)
if defined RB_ZIP if defined RB_SOURCE (
    rem Both would mean two different builds. Refuse rather than pick one.
    echo [rollback] RB_ZIP and RB_SOURCE cannot both be set
    exit /b 2
)
if defined RB_ZIP if not defined RB_STAGE (
    echo [rollback] RB_STAGE is required when RB_ZIP is used
    exit /b 2
)
if not defined RB_ASIDE (
    echo [rollback] RB_ASIDE is required
    exit /b 2
)

rem cmd rejects forward slashes in paths; YAML writes them that way.
set "RB_LIVE=%RB_LIVE:/=\%"
if defined RB_ZIP set "RB_ZIP=%RB_ZIP:/=\%"
if defined RB_SOURCE set "RB_SOURCE=%RB_SOURCE:/=\%"
if defined RB_STAGE set "RB_STAGE=%RB_STAGE:/=\%"
set "RB_ASIDE=%RB_ASIDE:/=\%"
if not defined RB_STRIP set "RB_STRIP=1"

set "SCRIPT_DIR=%~dp0"

rem STAGE is what ends up being renamed to live. With a zip that is the scratch
rem folder; with a folder source it IS the source - no copy, which is the whole
rem point of keeping <live>_org_<stamp> around until the health check passes.
if defined RB_SOURCE ( set "STAGE=%RB_SOURCE%" ) else ( set "STAGE=%RB_STAGE%" )

if defined RB_ZIP if not exist "%RB_ZIP%" (
    rem The history says this build exists. If the file is gone somebody deleted
    rem it - say so rather than silently rolling back further than asked.
    echo [rollback] confirmed build not found: %RB_ZIP%
    exit /b 4
)
if defined RB_SOURCE if not exist "%RB_SOURCE%\" (
    echo [rollback] source folder not found: %RB_SOURCE%
    exit /b 4
)
if defined RB_ZIP if exist "%RB_STAGE%" (
    echo [rollback] scratch path already exists: %RB_STAGE%
    exit /b 1
)
if exist "%RB_ASIDE%" (
    echo [rollback] aside path already exists: %RB_ASIDE%
    exit /b 1
)

echo [rollback] live   = %RB_LIVE%
if defined RB_ZIP    echo [rollback] zip    = %RB_ZIP%
if defined RB_SOURCE echo [rollback] source = %RB_SOURCE%
echo [rollback] aside  = %RB_ASIDE%
if defined RB_CARRY echo [rollback] carry  = %RB_CARRY%

if "%DRY_RUN%"=="1" (
    if defined RB_ZIP echo [rollback] DRY_RUN unpack "%RB_ZIP%" -^> "%RB_STAGE%"
    echo [rollback] DRY_RUN stop web server
    if defined RB_CARRY echo [rollback] DRY_RUN carry %RB_CARRY%
    echo [rollback] DRY_RUN move "%RB_LIVE%" -^> "%RB_ASIDE%"
    echo [rollback] DRY_RUN move "%STAGE%" -^> "%RB_LIVE%"
    echo [rollback] DRY_RUN start web server
    exit /b 0
)


rem --- 1. unpack (zip source only) -----------------------------------------
rem Before the stop. Unpacking is the slow part and it touches nothing live,
rem so there is no reason for the service to be down while it runs.
if not defined RB_ZIP goto :staged

mkdir "%RB_STAGE%" 2>nul
tar -xf "%RB_ZIP%" -C "%RB_STAGE%" --strip-components=%RB_STRIP%
if errorlevel 1 goto :unpack_failed

rem An archive that unpacks to nothing would go live as an empty folder, and the
rem web server would serve 404s that look like a working deployment.
dir /b "%RB_STAGE%" | findstr . > nul
if errorlevel 1 goto :unpack_empty

:staged


rem --- 2. stop -------------------------------------------------------------
call :webserver stop
if errorlevel 1 goto :stop_failed


rem --- 3. carry the runtime data forward ------------------------------------
rem
rem From the CURRENT live, not from the zip. A rollback returns the code to an
rem older build; the uploads and the server config stay as they are now.
rem After the stop, because a copy taken while the service writes is torn.
if defined RB_CARRY (
    for %%N in (%RB_CARRY%) do (
        call :carry "%%~N"
        if errorlevel 1 goto :carry_failed
    )
)


rem --- 4. swap -------------------------------------------------------------
move "%RB_LIVE%" "%RB_ASIDE%" > nul
if errorlevel 1 goto :aside_failed

rem From here the live folder does not exist.
move "%STAGE%" "%RB_LIVE%" > nul
if errorlevel 1 goto :undo


rem --- 5. start ------------------------------------------------------------
call :webserver start
if errorlevel 1 goto :propagate

echo [rollback] OK  restored from %STAGE%
echo [rollback] replaced build kept at %RB_ASIDE%
exit /b 0


rem ---------------------------------------------------------------------------
rem  failure paths - flat labels, never nested.
rem  An `exit /b` two levels deep inside parentheses LOSES the exit code: the
rem  message prints and the caller reads 0 (measured 2026-09-17).
rem ---------------------------------------------------------------------------
:unpack_failed
    echo [rollback] could not unpack %RB_ZIP%
    if defined RB_ZIP if exist "%RB_STAGE%" rmdir /s /q "%RB_STAGE%"
    exit /b 1

:unpack_empty
    echo [rollback] the archive unpacked to nothing: %RB_ZIP%
    echo [rollback]   check RB_STRIP ^(currently %RB_STRIP%^)
    rmdir /s /q "%RB_STAGE%"
    exit /b 1

:stop_failed
    rem Nothing has moved. Leave the scratch folder behind? No - it would block
    rem the next attempt, which refuses an existing RB_STAGE.
    if defined RB_ZIP if exist "%RB_STAGE%" rmdir /s /q "%RB_STAGE%"
    goto :propagate

:carry_failed
    echo [rollback] could not carry runtime data - live is untouched
    call :webserver start
    if defined RB_ZIP if exist "%RB_STAGE%" rmdir /s /q "%RB_STAGE%"
    exit /b 1

:aside_failed
    echo [rollback] could not move the live folder aside
    echo [rollback]   something is holding it open
    call :webserver start
    if defined RB_ZIP if exist "%RB_STAGE%" rmdir /s /q "%RB_STAGE%"
    exit /b 1

:undo
    echo [rollback] failed after the live folder was moved - putting it back
    move "%RB_ASIDE%" "%RB_LIVE%" > nul
    if errorlevel 1 goto :undo_failed
    echo [rollback] the previous state is back
    call :webserver start
    exit /b 1

:undo_failed
    echo [rollback] ROLLBACK FAILED. Live folder is missing.
    echo [rollback]   restore by hand: move "%RB_ASIDE%" "%RB_LIVE%"
    rem Do not start the web server on an empty path - it would serve 404s and
    rem look alive to a health check.
    exit /b 5

:propagate
    exit /b %ERRORLEVEL%


rem ---------------------------------------------------------------------------
rem  :carry <name>
rem  Copies one name from the current live into the build being restored.
rem  Folders and files both. A name that is not there is not an error.
rem ---------------------------------------------------------------------------
:carry
    set "CR_FROM=%RB_LIVE%\%~1"
    set "CR_TO=%STAGE%\%~1"

    if not exist "%CR_FROM%" (
        echo [rollback] carry %~1 - not in the current live, skipped
        exit /b 0
    )

    rem A trailing backslash matches directories only.
    if exist "%CR_FROM%\" goto :carry_dir

    copy /y "%CR_FROM%" "%CR_TO%" > nul
    if errorlevel 1 (
        echo [rollback] carry %~1 - copy failed
        exit /b 1
    )
    echo [rollback] carry %~1
    exit /b 0

:carry_dir
    robocopy "%CR_FROM%" "%CR_TO%" /E /NFL /NDL /NJH /NJS /R:1 /W:1 > nul
    rem robocopy returns 1 for a NORMAL copy. Only 8 and above are failures.
    if errorlevel 8 goto :carry_dir_failed
    rem Reset ERRORLEVEL: robocopy's 1 would be read as failure by the caller.
    ver > nul
    echo [rollback] carry %~1\
    exit /b 0

:carry_dir_failed
    echo [rollback] carry %~1 - copy failed
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
