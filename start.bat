@echo off
rem ASCII only: non-ASCII text in .bat files breaks cmd's parser under
rem mismatched codepages (UTF-8 console vs Big5 system, and vice versa).
title AI Usage Dashboard
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install Node.js 20+ from https://nodejs.org/zh-tw
    pause
    exit /b 1
)

rem Already running: just open the browser.
netstat -ano | findstr /c:":4317 " | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo Server already running, opening browser...
    start "" http://127.0.0.1:4317
    exit /b 0
)

if not exist node_modules (
    echo First run: installing dependencies, about 1 minute...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. Check network / npm settings.
        pause
        exit /b 1
    )
)

echo Starting server. Browser will open at http://127.0.0.1:4317
echo Close this window to stop the server.
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:4317"
call npm start
pause
