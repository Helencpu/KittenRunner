@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "NODE="
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
if not defined NODE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
  echo.
  echo  未找到可用的 Node 运行时。
  echo  请确认 runtime\node.exe 存在，或安装 Node.js 18+ 后重试。
  echo.
  pause
  exit /b 1
)

set "PORT=7788"
set "PORTOCC="
for /f "delims=" %%a in ('netstat -ano ^| findstr /c:":7788 " ^| findstr /c:"LISTENING"') do set "PORTOCC=1"

if defined PORTOCC (
  echo  已在运行，直接打开窗口 ...
) else (
  echo  正在启动本地服务 ...
  start "" /min "%NODE%" server.js
  ping -n 3 127.0.0.1 >nul
)

if defined KR_NOUI exit /b 0

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=http://127.0.0.1:%PORT%/ --window-size=1180,820 --autoplay-policy=no-user-gesture-required
) else (
  start "" http://127.0.0.1:%PORT%/
)
exit /b 0