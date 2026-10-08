@echo off
rem ---------------------------------------------------------------------------
rem build_shore.bat - MFM.Shore publish build
rem
rem Called by the deploy pipeline (BuildStage) with the working directory
rem already set to the project folder (build_cwd), so this script does not cd.
rem
rem   usage: build_shore.bat <pubxml path> [publish url] [csproj]
rem   e.g.   build_shore.bat "Properties/PublishProfiles/FolderProfile.pubxml" ^
rem                          "D:/Deploy/build/MFM.SHORE_QA"
rem
rem The pubxml path may be relative to the project folder (cwd), so the profile
rem committed in the repo can be used as-is. Server-side copies are not needed:
rem they differed from FolderProfile only in PublishUrl, and a stale copy is how
rem TargetFramework=net6.0 survived the net8.0 upgrade (NU1202, 2026-09-30).
rem
rem The publish profile is copied into <cwd>\Properties\PublishProfiles\ under
rem the fixed name _pipeline.pubxml and passed to dotnet by NAME. A full path makes
rem the SDK skip publishing with NETSDK1198 while still exiting 0 - the old
rem artifact then gets deployed. A fixed name is also what lets the source sit
rem in that same folder: `copy` onto itself fails ("cannot be copied onto
rem itself", exit 1), and editing the tracked file would dirty the checkout.
rem
rem When a publish url is given, it is written into that COPY so the pipeline
rem decides where the output lands. The original profile is left untouched.
rem
rem ENCODING: ASCII-only. UTF-8 is not the problem - a MISMATCH is: a UTF-8 file
rem needs `chcp 65001`, a CP949 file needs `chcp 949`, and either one paired with
rem the other codepage produces mojibake. Staying ASCII sidesteps the question.
rem Rules and the measured matrix: the deploy script conventions guide,
rem docs/design/*/06_*.md  (its folder name is Korean, so it is not spelled here).
rem ---------------------------------------------------------------------------
setlocal

set SRC=%~1
set PUBURL=%~2
set PROJECT=%~3
if "%PROJECT%"=="" set PROJECT=MFM.Shore.csproj

if "%SRC%"=="" (
  echo [build_shore] publish profile path is required.
  echo [build_shore]   usage: build_shore.bat "Properties/PublishProfiles/FolderProfile.pubxml" [publish url] [csproj]
  exit /b 1
)

rem yaml keeps paths with forward slashes; cmd copy needs backslashes.
set SRC=%SRC:/=\%
if not exist "%SRC%" (
  echo [build_shore] publish profile not found: %SRC%
  exit /b 1
)

rem Untracked file; git_sync's `checkout -f` leaves it alone and we overwrite
rem it every run. PROFILE (no extension) is the NAME PublishProfile wants.
set COPY_NAME=_pipeline
set PROFILE=%COPY_NAME%
set PROFILE_FILE=%COPY_NAME%.pubxml

set DEST=%CD%\Properties\PublishProfiles
if not exist "%DEST%" mkdir "%DEST%"
copy /y "%SRC%" "%DEST%\%PROFILE_FILE%" > nul
if errorlevel 1 (
  echo [build_shore] failed to copy publish profile: %SRC% -^> %DEST%\%PROFILE_FILE%
  exit /b 1
)

rem ---------------------------------------------------------------------------
rem Rewrite PublishUrl in the COPY. The original profile is never modified.
rem
rem The pipeline owns the output path (yaml build_path); the profile owns the
rem rest. When both carry a path they can disagree without any error: dotnet
rem publishes where the pubxml says, the pipeline looks where the yaml says,
rem and a stale artifact ships as if it were new. Passing the path in makes
rem the yaml the single source of truth.
rem
rem Skipped when no url is given, so old one-argument callers still work.
rem ---------------------------------------------------------------------------
if "%PUBURL%"=="" goto skipUrl

rem yaml keeps paths with forward slashes; the pubxml wants backslashes.
set PUBURL=%PUBURL:/=\%
rem Drop a trailing backslash. The rewrite itself is fine with it, but findstr
rem reads "\<" in the check below as an escape and reports a false failure.
if "%PUBURL:~-1%"=="\" set PUBURL=%PUBURL:~0,-1%
set PROFILE_COPY=%DEST%\%PROFILE_FILE%

powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%PROFILE_COPY%'; $c=Get-Content -Raw -LiteralPath $f; $c=[regex]::Replace($c,'<PublishUrl>.*?</PublishUrl>','<PublishUrl>%PUBURL%</PublishUrl>'); Set-Content -LiteralPath $f -Value $c -Encoding UTF8 -NoNewline"
if errorlevel 1 (
  echo [build_shore] failed to rewrite PublishUrl in %PROFILE_COPY%
  exit /b 1
)

rem Verify it actually landed. A silent no-op here is the very failure this guards
rem against - the regex missing would leave the old path and nothing would complain.
findstr /c:"<PublishUrl>%PUBURL%</PublishUrl>" "%PROFILE_COPY%" > nul
if errorlevel 1 (
  echo [build_shore] PublishUrl rewrite did not take effect: %PUBURL%
  echo [build_shore]   profile copy: %PROFILE_COPY%
  exit /b 1
)

:skipUrl

rem dotnet install path differs per server, so it is not hard-coded here.
set DOTNET_EXE=dotnet
if defined DOTNET_HOME if exist "%DOTNET_HOME%\dotnet.exe" set DOTNET_EXE=%DOTNET_HOME%\dotnet.exe

echo [build_shore] dir     = %CD%
echo [build_shore] project = %PROJECT%
echo [build_shore] profile = %PROFILE%  (%SRC%)
if not "%PUBURL%"=="" echo [build_shore] pub url = %PUBURL%
if "%PUBURL%"=="" echo [build_shore] pub url = (profile default)

rem Log which dotnet and which SDK actually run. The Jenkins service account
rem can see a different PATH than an interactive `where dotnet` does, and a
rem too-old SDK only shows up later as NETSDK1045 on the target framework.
echo [build_shore] dotnet  = %DOTNET_EXE%
for /f "delims=" %%V in ('"%DOTNET_EXE%" --version 2^>nul') do echo [build_shore] sdk     = %%V

"%DOTNET_EXE%" build "%PROJECT%" -c Release /p:DeployOnBuild=true /p:PublishProfile=%PROFILE%
if errorlevel 1 (
  echo [build_shore] build FAILED
  exit /b 1
)

echo [build_shore] build OK
exit /b 0
