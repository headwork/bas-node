@echo off
chcp 65001 > nul

rem Deploy pipeline launcher
rem   basDeploy.bat --yaml=deploy_shore.yaml [--dry-run]
rem
rem Uses NODE_HOME if defined, otherwise 'node' from PATH.
rem Node install path differs per server, so it is not hard-coded here.
rem NOTE: keep this file ASCII-only. cmd misparses UTF-8 Korean in batch files.

set curPath=%~dp0
cd /d "%curPath%"

if defined NODE_HOME goto useNodeHome

where node > nul 2>&1
if errorlevel 1 goto noNode
set NODE_EXE=node
goto run

:noNode
echo [basDeploy] node not found. Add it to PATH or set NODE_HOME.
echo [basDeploy]   set NODE_HOME=D:\Programs\nodejs\node-v22.14.0-win-x64\node.exe
exit /b 1

:useNodeHome
rem NODE_HOME may point at node.exe itself or at the install directory.
set NODE_EXE=%NODE_HOME%
if exist "%NODE_HOME%\node.exe" set NODE_EXE=%NODE_HOME%\node.exe

:run
"%NODE_EXE%" ".\bas-deploy.js" %*
exit /b %ERRORLEVEL%
