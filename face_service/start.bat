@echo off
:: ============================================================
:: Vault OS AI Microservice — Windows startup script
:: Run this BEFORE starting node server.js
:: ============================================================

setlocal

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
if "%FACE_SERVICE_HOST%"=="" set "FACE_SERVICE_HOST=127.0.0.1"
if "%FACE_SERVICE_PORT%"=="" set "FACE_SERVICE_PORT=7860"

:: ── Check Python ─────────────────────────────────────────────
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.10 or 3.11 from https://python.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo [AI] Using %PYVER%

:: ── Create virtualenv if needed ──────────────────────────────
if not exist "%SCRIPT_DIR%venv\Scripts\activate.bat" (
    echo [AI] Creating virtual environment …
    python -m venv "%SCRIPT_DIR%venv"
    if errorlevel 1 (
        echo [ERROR] Failed to create venv. Check Python installation.
        pause
        exit /b 1
    )
)

:: ── Activate venv ────────────────────────────────────────────
call "%SCRIPT_DIR%venv\Scripts\activate.bat"

:: ── Install / upgrade dependencies ───────────────────────────
echo [AI] Checking dependencies …
pip install --quiet --upgrade pip
pip install --quiet -r "%SCRIPT_DIR%requirements.txt"
if errorlevel 1 (
    echo [ERROR] pip install failed. Check requirements.txt and internet connection.
    pause
    exit /b 1
)

:: ── Start server ─────────────────────────────────────────────
echo.
echo [AI] Starting VaultOS AI Microservice on http://%FACE_SERVICE_HOST%:%FACE_SERVICE_PORT%
echo [AI] InsightFace buffalo_l models will download on first run (~400 MB)
echo [AI] Press Ctrl+C to stop.
echo.

cd /d "%PROJECT_DIR%"
python -m uvicorn face_service.main:app --host %FACE_SERVICE_HOST% --port %FACE_SERVICE_PORT% --workers 1 --log-level info

endlocal
