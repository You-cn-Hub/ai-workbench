@echo off
rem Launch the packaged app (no console window).
rem NOTE: keep this file ASCII-only. cmd.exe reads .bat/.cmd as GBK,
rem so UTF-8 Chinese comments turn into garbage and break the script.
rem ELECTRON_RUN_AS_NODE=1 makes Electron degrade into plain Node mode
rem and exit silently without any error, so clear it first.
setlocal
set "ELECTRON_RUN_AS_NODE="
set "EXE=%~dp0release\win-unpacked\AI-Workbench.exe"
if not exist "%EXE%" (
  echo Package not found. Run: npm run dist
  pause
  exit /b 1
)
start "" "%EXE%"