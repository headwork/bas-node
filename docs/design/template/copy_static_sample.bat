@echo off
rem ---------------------------------------------------------------------------
rem copy_static_shore.bat - static-only fast path for MFM.Shore
rem
rem Stands in for build_shore.bat when git_sync decided that every changed file
rem is a view or an asset. The pipeline judges, this script only copies: by the
rem time it runs the pre-pull commit is already gone, so it has nothing to judge
rem with. The verdict lives in the yaml (static_paths + if/unless).
rem
rem Called by the deploy pipeline (BuildStage) with the working directory already
rem set to the project folder (build_cwd), so this script does not cd.
rem
rem   usage: copy_static_shore.bat <publish url>
rem   e.g.   copy_static_shore.bat "D:/Deploy/build/MFM.SHORE_QA"
rem
rem Why copy rather than skip the build outright: a bare skip leaves the previous
rem publish output untouched, and BuildStage fails the run when nothing under
rem build_path is newer than the build start. That guard stops a stale artifact
rem from shipping as new and is worth keeping. Copying makes the output genuinely
rem current, so the guard passes on its own terms.
rem
rem Why this is safe for .cshtml: MFM.Shore.csproj sets RazorCompileOnBuild and
rem RazorCompileOnPublish to false, and Program.cs calls AddRazorRuntimeCompilation.
rem Views are not build artifacts - they are read from disk per request.
rem
rem Deletions are NOT mirrored: files removed from git stay on the server. That is
rem a 2026-08-27 decision, not an oversight - wwwroot can hold runtime uploads and
rem mirroring would delete live data.
rem
rem When the fast path cannot be trusted this exits non-zero instead of guessing.
rem A visible failure beats a half-updated output that looks deployable.
rem
rem ENCODING: ASCII-only. UTF-8 is not the problem - a MISMATCH is: a UTF-8 file
rem needs `chcp 65001`, a CP949 file needs `chcp 949`, and either one paired with
rem the other codepage produces mojibake. Staying ASCII sidesteps the question.
rem Rules and the measured matrix: the deploy script conventions guide,
rem docs/design/*/06_*.md  (its folder name is Korean, so it is not spelled here).
rem ---------------------------------------------------------------------------
setlocal

set PUBURL=%~1

if "%PUBURL%"=="" (
  echo [copy_static] publish url is required.
  echo [copy_static]   usage: copy_static_shore.bat "<build path>"
  exit /b 1
)

rem yaml keeps paths with forward slashes; cmd copy needs backslashes.
set PUBURL=%PUBURL:/=\%

rem No output yet means there is nothing to update. Copying views onto an empty
rem folder would leave a deployable-looking folder with no application in it, so
rem a full build has to have run at least once.
if not exist "%PUBURL%" (
  echo [copy_static] no existing output at %PUBURL%
  echo [copy_static]   a full build must run at least once before the fast path.
  exit /b 1
)

echo [copy_static] dir    = %CD%
echo [copy_static] output = %PUBURL%

rem This list is project shape and must stay in step with static_paths in the
rem yaml - that one decides when the fast path runs, this one carries it out.
rem They are written differently on purpose: static_paths is repo-root relative
rem (MFM.Shore/Web/Views/), these are relative to build_cwd.
set COPIED=0
call :copyDir Views
if errorlevel 1 exit /b 1
call :copyDir wwwroot
if errorlevel 1 exit /b 1
call :copyDir Template
if errorlevel 1 exit /b 1

rem Copying nothing means the two lists have drifted apart: the yaml said the
rem change was static, but none of those folders is here. Silence would ship the
rem previous output unchanged.
if "%COPIED%"=="0" (
  echo [copy_static] no static folder found under %CD% - nothing was copied.
  echo [copy_static]   check the folder list here against static_paths in the yaml.
  exit /b 1
)

echo [copy_static] static copy OK
exit /b 0

rem Subroutine, reached only by call. The main path exits above.
:copyDir
if not exist "%CD%\%~1" (
  echo [copy_static]   %~1 - not in source, skipped.
  exit /b 0
)
echo [copy_static]   %~1
xcopy "%CD%\%~1" "%PUBURL%\%~1" /E /I /Y /Q > nul
if errorlevel 1 (
  echo [copy_static] copy FAILED: %~1
  exit /b 1
)
set COPIED=1
exit /b 0
