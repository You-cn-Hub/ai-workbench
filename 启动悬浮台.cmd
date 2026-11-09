@echo off
rem Launch the packaged app (no console window).
rem
rem Note: keep this file ASCII-only. cmd.exe reads .bat/.cmd as GBK,
rem so UTF-8 Chinese comments turn into garbage and break the script.
rem
rem We also clear ELECTRON_RUN_AS_NODE: if it is set to 1, Electron
rem degrades into plain Node mode and exits silently without any error.
setlocal
set "ELECTRON_RUN_AS_NODE="
set "EXE=%~dp0dist\AI-Workbench\AI-Workbench.exe"
if not exist "%EXE%" (
  echo Package not found. Run: npm run release
  pause
  exit /b 1
)
start "" "%EXE%"
