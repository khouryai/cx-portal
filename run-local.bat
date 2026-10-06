@echo off
rem CX Portal - double-click to run the app locally on Windows.
rem Opens http://localhost:8080/ in your browser. Close the window to stop.
rem Optional: run-local.bat 8090   (use a different port)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-local.ps1" %*
