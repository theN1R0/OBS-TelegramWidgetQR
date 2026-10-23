@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\test-obs-portable.ps1" %*
set "TELEGRAM_TEST_EXIT=%ERRORLEVEL%"
if not "%TELEGRAM_TEST_EXIT%"=="0" echo Test failed. Send the latest log from build\obs-test\config\obs-studio\logs.
pause
exit /b %TELEGRAM_TEST_EXIT%
