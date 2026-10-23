@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-complete.ps1" %*
set "TELEGRAM_BUILD_EXIT=%ERRORLEVEL%"
if not "%TELEGRAM_BUILD_EXIT%"=="0" echo Build failed. See build\logs for details.
pause
exit /b %TELEGRAM_BUILD_EXIT%
