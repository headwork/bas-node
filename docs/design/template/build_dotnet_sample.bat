@echo off
rem ---------------------------------------------------------------------------
rem build_shore.bat - MFM.Shore publish build
rem
rem Called by the deploy pipeline (BuildStage) with the working directory
rem already set to the project folder (build_cwd), so this script does not cd.
rem
rem   usage: build_shore.bat <pubxml path> [publish url] [csproj]
rem   e.g.   build_shore.bat "D:/Deploy/jenkins/project_hlngs/wesysProfileDev.pubxml" ^
rem                          "D:/Deploy/build/MFM.SHORE_QA"
rem
rem The publish profile is copied into <cwd>\Properties\PublishProfiles\ and
rem passed to dotnet by NAME. A full path makes the SDK skip publishing with
rem NETSDK1198 while still exiting 0 - the old artifact then gets deployed.
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
  echo [build_shore]   usage: build_shore.bat "<dir>\wesysProfileDev.pubxml" [publish url] [csproj]
  exit /b 1
)

rem yaml keeps paths with forward slashes; cmd copy needs backslashes.
set SRC=%SRC:/=\%
if not exist "%SRC%" (
  echo [build_shore] publish profile not found: %SRC%
  exit /b 1
)

rem %%~nF = file name without extension. That NAME is what PublishProfile wants.
rem %%~nxF = name with extension, used to address the copy we are about to make.
for %%F in ("%SRC%") do (
  set PROFILE=%%~nF
  set PROFILE_FILE=%%~nxF
)

set DEST=%CD%\Properties\PublishProfiles
if not exist "%DEST%" mkdir "%DEST%"
copy /y "%SRC%" "%DEST%\" > nul
if errorlevel 1 (
  echo [build_shore] failed to copy publish profile: %SRC% -^> %DEST%
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

"%DOTNET_EXE%" build "%PROJECT%" -c Release /p:DeployOnBuild=true /p:PublishProfile=%PROFILE%
if errorlevel 1 (
  echo [build_shore] build FAILED
  exit /b 1
)

echo [build_shore] build OK
exit /b 0
