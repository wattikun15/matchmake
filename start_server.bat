@echo off
title MatchBoard Server
cd /d "%~dp0"

python server.py
if %errorlevel% neq 0 (
    py server.py
)

if %errorlevel% neq 0 (
    echo.
    echo ========================================================
    echo  Failed to start MatchBoard server.
    echo  Please ensure Python is installed and added to PATH.
    echo ========================================================
    echo.
    pause
)
