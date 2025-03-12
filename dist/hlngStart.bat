@echo off
chcp 65001

set curPath=%~dp0
echo %curPath%

set NODE_HOME="D:\Programs\node-v22.14.0-win-x64\node"

%NODE_HOME% .\bas-HlngConfluence.js %1 "page" "" "" "LOCAL"