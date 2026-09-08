@echo off
rem ===========================================================================
rem Node-Proxy Client - one-shot installer for Windows (issue #40)
rem   * downloads the latest dev binary (client-win-x64.exe)
rem   * installs it to %ProgramFiles%\node-proxy
rem   * writes config.yaml (server_url / auth_token / region / tags)
rem   * registers a Windows service via nssm: node-proxy-client
rem
rem Usage (run as Administrator):
rem   docs\install.bat --server-url ws://1.2.3.4:3000/ws --token SECRET ^
rem        [--client-id np-node-01] [--region cn] [--tags region:cn]
rem   docs\install.bat --status | --restart | --uninstall
rem
rem Network: tries GitHub directly, then mirror prefixes, retrying each
rem (China-friendly). nssm comes from nssm.cc; if that download fails the
rem script points you to drop nssm-2.24.zip next to it manually.
rem ===========================================================================
chcp 65001 >nul
setlocal EnableDelayedExpansion

set "REPO=WAADRI/node-proxy"
set "TAG=dev"
set "ASSET=client-win-x64.exe"
set "INSTALL_DIR=%ProgramFiles%\node-proxy"
set "SERVICE=node-proxy-client"

set "SERVER_URL="
set "TOKEN="
set "CLIENT_ID="
set "REGION="
set "TAGS="
set "ACTION=install"

:parse
if "%~1"=="" goto parse_done
if /i "%~1"=="--server-url" ( set "SERVER_URL=%~2" & shift & shift & goto parse )
if /i "%~1"=="--token" ( set "TOKEN=%~2" & shift & shift & goto parse )
if /i "%~1"=="--client-id" ( set "CLIENT_ID=%~2" & shift & shift & goto parse )
if /i "%~1"=="--region" ( set "REGION=%~2" & shift & shift & goto parse )
if /i "%~1"=="--tags" ( set "TAGS=%~2" & shift & shift & goto parse )
if /i "%~1"=="--status" ( set "ACTION=status" & shift & goto parse )
if /i "%~1"=="--restart" ( set "ACTION=restart" & shift & goto parse )
if /i "%~1"=="--uninstall" ( set "ACTION=uninstall" & shift & goto parse )
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage
echo Unknown argument: %~1
:usage
echo Usage: %~nx0 --server-url ws://host:3000/ws --token SECRET [--client-id ID] [--region X] [--tags X,Y]
exit /b 1
:parse_done

rem ---- admin check ----
net session >nul 2>&1
if errorlevel 1 (
  echo Please run this script as Administrator.
  exit /b 1
)

if "%ACTION%"=="status" (
  nssm status "%SERVICE%" 2>nul || sc query "%SERVICE%"
  exit /b 0
)
if "%ACTION%"=="restart" (
  nssm restart "%SERVICE%"
  sc query "%SERVICE%"
  exit /b 0
)
if "%ACTION%"=="uninstall" (
  nssm stop "%SERVICE%" 2>nul
  nssm remove "%SERVICE%" confirm 2>nul
  echo Service %SERVICE% removed (files kept in %INSTALL_DIR%).
  exit /b 0
)

if "%SERVER_URL%"=="" goto usage
if "%TOKEN%"=="" goto usage

echo ==^> Install dir: %INSTALL_DIR%
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

rem ---- download the binary via GitHub + mirror list ----
set "BASE=https://github.com/%REPO%/releases/download/%TAG%/%ASSET%"
set "MIRRORS=https://ghfast.top/ https://gh-proxy.com/ https://ghproxy.net/ https://ghproxy.cn/ "
set "DEST=%INSTALL_DIR%\node-proxy-client.exe"
set "DONE="
for %%M in (%MIRRORS%) do (
  echo Trying: %%M%BASE%
  curl -fSL --connect-timeout 12 --retry 3 -o "%DEST%" "%%M%BASE%" && set "DONE=1" && goto downloaded
)
if not defined DONE (
  echo All download sources failed. Check your network and retry.
  exit /b 1
)
:downloaded
if not defined DONE (
  echo Trying directly: %BASE%
  curl -fSL --connect-timeout 12 --retry 3 -o "%DEST%" "%BASE%"
  if errorlevel 1 ( echo Direct download failed too. & exit /b 1 )
)

rem ---- write config.yaml next to the exe ----
echo ==^> Writing config.yaml ...
> "%INSTALL_DIR%\config.yaml" (
  echo server_url: %SERVER_URL%
  echo auth_token: %TOKEN%
  if not "%REGION%"=="" echo region: %REGION%
  if not "%TAGS%"=="" echo tags: %TAGS%
)

rem ---- nssm (service wrapper) ----
set "NSSM_EXE=%ProgramFiles%\nssm\nssm.exe"
set "NSSM_DIR=%TEMP%\nssm-2.24\nssm-2.24\win64"
if not exist "%NSSM_EXE%" (
  echo ==^> nssm not found, downloading nssm-2.24 ...
  curl -fSL --connect-timeout 15 -o "%TEMP%\nssm-2.24.zip" "https://nssm.cc/release/nssm-2.24.zip"
  if errorlevel 1 (
    echo.
    echo nssm download failed. Manually download https://nssm.cc/release/nssm-2.24.zip
    echo and place it at %TEMP%\nssm-2.24.zip, then run this script again.
    exit /b 1
  )
  powershell -NoProfile -Command "Expand-Archive -Force '%TEMP%\nssm-2.24.zip' '%TEMP%\nssm-2.24'"
  if not exist "%NSSM_DIR%\nssm.exe" ( echo nssm extraction failed & exit /b 1 )
  if not exist "%ProgramFiles%\nssm" mkdir "%ProgramFiles%\nssm"
  copy /y "%NSSM_DIR%\nssm.exe" "%ProgramFiles%\nssm\nssm.exe" >nul
)

echo ==^> Registering service %SERVICE% ...
"%NSSM_EXE%" stop "%SERVICE%" >nul 2>&1
"%NSSM_EXE%" remove "%SERVICE%" confirm >nul 2>&1
"%NSSM_EXE%" install "%SERVICE%" "%INSTALL_DIR%\node-proxy-client.exe"
"%NSSM_EXE%" set "%SERVICE%" AppDirectory "%INSTALL_DIR%"
"%NSSM_EXE%" set "%SERVICE%" Start SERVICE_AUTO_START
"%NSSM_EXE%" set "%SERVICE%" AppExit Default Restart
"%NSSM_EXE%" set "%SERVICE%" AppRestartDelay 5000
rem config.yaml sits next to the exe and is picked up automatically.
if not "%CLIENT_ID%"=="" "%NSSM_EXE%" set "%SERVICE%" AppEnvironmentExtra CLIENT_ID=%CLIENT_ID%
"%NSSM_EXE%" start "%SERVICE%"

echo.
echo ==^> Done. Service: %SERVICE%
echo   sc query %SERVICE%          status
echo   %~nx0 --restart             restart
echo   %~nx0 --uninstall           remove service
exit /b 0
