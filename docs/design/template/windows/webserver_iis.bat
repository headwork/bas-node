@echo off
rem ===========================================================================
rem  webserver_iis.bat - IIS site/apppool control                #P202609_002
rem
rem  One of the webserver_<type>.bat family. deploy.bat picks the file by
rem  WS_TYPE, so supporting nginx means adding webserver_nginx.bat next to this
rem  one - deploy.bat itself never changes.
rem
rem  INPUT (environment variables)
rem    WS_ACTION   stop | start | reload      (required)
rem    WS_NAME     IIS site name              (required)
rem    WS_POOL     app pool name              (optional, defaults to WS_NAME)
rem    DRY_RUN     1 = print plan, change nothing
rem
rem  EXIT CODES - this table is the contract with Node. Do not add codes
rem  without updating ScriptControlStage.
rem    0   success, INCLUDING "already in the desired state"
rem    2   bad or missing input
rem    3   insufficient privileges
rem    4   target not found (IIS absent, or unknown site/pool)
rem    1   unknown failure
rem
rem  WHY THIS FILE IS ASCII ONLY
rem    UTF-8 is not the problem - a MISMATCH is. A UTF-8 file needs `chcp 65001`,
rem    a CP949 file needs `chcp 949`; pair either with the other codepage and the
rem    text is mojibake (measured 2026-09-17). Staying ASCII sidesteps the whole
rem    question, and the exit code is the contract anyway - Node attaches the
rem    Korean reason. To use Korean here you must follow the guide:
rem    docs/design/*/06_*.md (deploy script conventions), enforced by npm test.
rem
rem  WHY STATE IS QUERIED INSTEAD OF PARSING MESSAGES
rem    appcmd returns a non-zero code for "already stopped", and its message is
rem    localized. Parsing it would put Korean patterns in this file and make the
rem    result depend on the server locale. Reading /text:state avoids both.
rem ===========================================================================

setlocal EnableExtensions

if not defined WS_ACTION (
    echo [webserver] WS_ACTION is required ^(stop^|start^|reload^)
    exit /b 2
)
if not defined WS_NAME (
    echo [webserver] WS_NAME is required
    exit /b 2
)
rem Deliberately NOT defaulting WS_ACTION or WS_NAME. A default here would let a
rem caller that forgot a variable deploy against the wrong target with no error.
if not defined WS_POOL set "WS_POOL=%WS_NAME%"

set "APPCMD=%windir%\system32\inetsrv\appcmd.exe"
if not exist "%APPCMD%" (
    echo [webserver] IIS management tool not found: %APPCMD%
    exit /b 4
)

if /i "%WS_ACTION%"=="stop"   goto :act_stop
if /i "%WS_ACTION%"=="start"  goto :act_start
if /i "%WS_ACTION%"=="reload" goto :act_reload

echo [webserver] unknown WS_ACTION: %WS_ACTION%
exit /b 2


rem NOTE: do not write `call :ensure ... || exit /b %ERRORLEVEL%`.
rem `%ERRORLEVEL%` on that line expands when the LINE is parsed - before the call
rem runs - so it always exits 0 and a failure is reported as success. Jumping to
rem :propagate keeps the real code, because that line is parsed after the jump.
:act_stop
    call :ensure site    Stopped
    if errorlevel 1 goto :propagate
    call :ensure apppool Stopped
    if errorlevel 1 goto :propagate
    exit /b 0

:act_start
    call :ensure apppool Started
    if errorlevel 1 goto :propagate
    call :ensure site    Started
    if errorlevel 1 goto :propagate
    exit /b 0

:propagate
    exit /b %ERRORLEVEL%

:act_reload
    rem IIS has no reload. Recycling the pool is the closest equivalent and it
    rem does not drop the site, so requires_stop:false callers keep serving.
    call :target_of apppool
    if not defined WS_READABLE (
        echo [webserver] cannot read IIS configuration for apppool %WS_OBJ%
        echo [webserver]   run elevated - the name is not the problem
        exit /b 3
    )
    if not defined WS_TARGET (
        echo [webserver] apppool not found: %WS_OBJ%
        exit /b 4
    )

    if "%DRY_RUN%"=="1" (
        echo [webserver] DRY_RUN recycle apppool %WS_POOL%
        exit /b 0
    )

    call :need_admin
    if errorlevel 1 (
        echo [webserver] administrator privileges required to recycle %WS_POOL%
        exit /b 3
    )

    "%APPCMD%" recycle apppool /apppool.name:"%WS_POOL%" >nul 2>&1
    if errorlevel 1 (
        echo [webserver] recycle failed: %WS_POOL%
        exit /b 1
    )
    echo [webserver] OK recycle apppool %WS_POOL%
    exit /b 0


rem ---------------------------------------------------------------------------
rem  :ensure <site|apppool> <Started|Stopped>
rem  Brings one object to the wanted state. Already-there is success.
rem ---------------------------------------------------------------------------
:ensure
    setlocal
    set "KIND=%~1"
    set "WANT=%~2"

    call :target_of %KIND%
    rem Flat, not nested. An `exit /b` two levels deep inside parentheses loses
    rem the code - the message prints and the caller reads 0 (measured 2026-09-17).
    if not defined WS_READABLE goto :ensure_denied
    if not defined WS_TARGET   goto :ensure_absent

    call :state_of %KIND%
    if /i "%WS_STATE%"=="%WANT%" (
        echo [webserver] OK %KIND% %WS_OBJ% already %WANT%
        endlocal & exit /b 0
    )

    if "%WANT%"=="Stopped" ( set "VERB=stop" ) else ( set "VERB=start" )

    if "%DRY_RUN%"=="1" (
        echo [webserver] DRY_RUN %VERB% %KIND% %WS_OBJ%
        endlocal & exit /b 0
    )

    call :need_admin
    if errorlevel 1 (
        echo [webserver] administrator privileges required to %VERB% %KIND% %WS_OBJ%
        endlocal & exit /b 3
    )

    "%APPCMD%" %VERB% %KIND% "/%KIND%.name:%WS_OBJ%" >nul 2>&1

    rem Do not trust the exit code. appcmd reports failure for races and for
    rem transitions it actually completed; the state is the only fact.
    call :state_of %KIND%
    if /i "%WS_STATE%"=="%WANT%" (
        echo [webserver] OK %VERB% %KIND% %WS_OBJ%
        endlocal & exit /b 0
    )

    echo [webserver] %VERB% %KIND% %WS_OBJ% failed, state=%WS_STATE%
    endlocal & exit /b 1

:ensure_denied
    echo [webserver] cannot read IIS configuration for %KIND% %WS_OBJ%
    echo [webserver]   run elevated - the name is not the problem
    endlocal & exit /b 3

:ensure_absent
    echo [webserver] %KIND% not found: %WS_OBJ%
    endlocal & exit /b 4


rem ---------------------------------------------------------------------------
rem  :target_of <kind>
rem    WS_OBJ       the name being asked about
rem    WS_TARGET    set only if that object exists
rem    WS_READABLE  set only if appcmd could read the configuration at all
rem
rem  TWO QUESTIONS, TWO CALLS - and the second one is not optional.
rem  `for /f` swallows the exit code of the command inside it, so an appcmd that
rem  could not run at all produces exactly what a missing site produces: no
rem  output. Without the probe below, running unelevated reports "site not
rem  found" and sends the operator hunting a typo that is not there.
rem  Measured 2026-09-17 on the build server: appcmd exits 5 with
rem  "Cannot read configuration file due to insufficient permissions".
rem ---------------------------------------------------------------------------
:target_of
    if /i "%~1"=="site" ( set "WS_OBJ=%WS_NAME%" ) else ( set "WS_OBJ=%WS_POOL%" )
    set "WS_TARGET="
    set "WS_READABLE=1"

    "%APPCMD%" list %~1 >nul 2>&1
    if errorlevel 1 set "WS_READABLE="

    rem The WHOLE command is wrapped in one more pair of quotes. `for /f` runs it
    rem through `cmd /c`, which strips the first and last quote when the line
    rem starts with one - `"appcmd" list site "X"` becomes `appcmd" list site "X`,
    rem prints nothing, and an existing site reads as "not found" (exit 4).
    rem Inside the outer quotes `>` is literal to the for-parser, so no caret.
    rem Measured 2026-09-17 elevated: unwrapped=[] wrapped=[MFM.SHORE_QA].
    for /f "delims=" %%A in ('""%APPCMD%" list %~1 "%WS_OBJ%" /text:name 2>nul"') do set "WS_TARGET=%%A"
    exit /b 0

rem ---------------------------------------------------------------------------
rem  :state_of <kind>   -> WS_STATE (Started | Stopped | Unknown)
rem ---------------------------------------------------------------------------
:state_of
    set "WS_STATE=Unknown"
    rem Same outer quotes as :target_of - without them this is always Unknown.
    for /f "delims=" %%A in ('""%APPCMD%" list %~1 "%WS_OBJ%" /text:state 2>nul"') do set "WS_STATE=%%A"
    exit /b 0

rem ---------------------------------------------------------------------------
rem  :need_admin  -> 0 when elevated, 1 otherwise
rem  `net session` needs administrator rights and touches nothing.
rem ---------------------------------------------------------------------------
:need_admin
    net session >nul 2>&1
    if errorlevel 1 exit /b 1
    exit /b 0
