@echo off
REM ============================================================================
REM Node-Proxy Windows Service Installer
REM Requires: WinSW (https://github.com/winsw/winsw)
REM ============================================================================
setlocal enabledelayedexpansion

set PROXY_DIR=%~dp0..
set WINSW_PATH=%PROXY_DIR%\bin\winsw.exe
set XML_PATH=%PROXY_DIR%\deploy\node-proxy.xml

echo Node-Proxy Windows Service Manager
echo ===================================
echo.

if "%1"=="" (
    echo Usage: %0 [install^|uninstall^|start^|stop^|restart^|status^|help]
    echo.
    echo Commands:
    echo   install   - Install Node-Proxy as a Windows service
    echo   uninstall - Remove the Node-Proxy service
    echo   start     - Start the service
    echo   stop      - Stop the service
    echo   restart   - Restart the service
    echo   status    - Check service status
    echo   help      - Show this help
    goto :eof
)

if not exist "%WINSW_PATH%" (
    echo ERROR: WinSW not found at %WINSW_PATH%
    echo.
    echo Download WinSW from: https://github.com/winsw/winsw/releases
    echo Place winsw.exe in %PROXY_DIR%\bin\
    exit /b 1
)

if not exist "%XML_PATH%" (
    echo ERROR: Service config not found at %XML_PATH%
    exit /b 1
)

echo Running: %1
"%WINSW_PATH%" %1 "%XML_PATH%"

if %ERRORLEVEL% equ 0 (
    echo Command '%1' completed successfully.
) else (
    echo Command '%1' failed with error code %ERRORLEVEL%.
)

endlocal