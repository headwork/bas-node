@echo off
chcp 65001

set curPath=%~dp0
echo curPath = %curPath%
cd %curPath%

set NODE_HOME="D:\Program Files\nodejs\node-v22.14.0-win-x64\node.exe"
%NODE_HOME% .\bas-HlngConfluence.js %1 %2 %3 %4 %5