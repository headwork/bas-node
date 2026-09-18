@echo off
rem Git credential helper for Jenkins.
rem
rem Git invokes GIT_ASKPASS with the prompt text as an argument, e.g.
rem   Username for 'http://host':
rem   Password for 'http://user@host':
rem We answer from GIT_USER / GIT_PASS, which Jenkins withCredentials()
rem injects into the environment.
rem
rem Why this instead of putting credentials in the URL:
rem   - the URL form is persisted into .git/config by clone
rem   - the URL form is visible in the process command line
rem   - against Bonobo Git Server it overrides the stored credential and fails
rem
rem NOTE: keep this file ASCII-only. cmd misparses UTF-8 Korean in batch files.

echo %* | findstr /I "Username" > nul
if errorlevel 1 (
  echo %GIT_PASS%
) else (
  echo %GIT_USER%
)
