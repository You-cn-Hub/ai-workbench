@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "APPDIR=%~dp0bin"
set "EXE=%APPDIR%\AI-Workbench.exe"
if not exist "%EXE%" ( echo Package broken: bin\AI-Workbench.exe missing & pause & exit /b 1 )
start "" "%EXE%"