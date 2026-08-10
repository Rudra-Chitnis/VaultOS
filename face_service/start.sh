#!/usr/bin/env bash
# ============================================================
# Vault OS AI Microservice — Linux / macOS startup script
# Run this BEFORE starting node server.js
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FACE_SERVICE_HOST="${FACE_SERVICE_HOST:-127.0.0.1}"
FACE_SERVICE_PORT="${FACE_SERVICE_PORT:-7860}"

# ── Check Python 3.9+ ────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
    echo "[ERROR] python3 not found. Install Python 3.10 or 3.11."
    exit 1
fi
PYVER=$(python3 --version)
echo "[AI] Using $PYVER"

# ── Create virtualenv if needed ──────────────────────────────
if [ ! -f "$SCRIPT_DIR/venv/bin/activate" ]; then
    echo "[AI] Creating virtual environment …"
    python3 -m venv "$SCRIPT_DIR/venv"
fi

# ── Activate venv ────────────────────────────────────────────
# shellcheck disable=SC1090
source "$SCRIPT_DIR/venv/bin/activate"

# ── Install / upgrade dependencies ───────────────────────────
echo "[AI] Checking dependencies …"
pip install --quiet --upgrade pip
pip install --quiet -r "$SCRIPT_DIR/requirements.txt"

# ── Start server ─────────────────────────────────────────────
echo ""
echo "[AI] Starting VaultOS AI Microservice on http://$FACE_SERVICE_HOST:$FACE_SERVICE_PORT"
echo "[AI] InsightFace buffalo_l models will download on first run (~400 MB)"
echo "[AI] Press Ctrl+C to stop."
echo ""

cd "$PROJECT_DIR"
python -m uvicorn face_service.main:app \
    --host "$FACE_SERVICE_HOST" \
    --port "$FACE_SERVICE_PORT" \
    --workers 1 \
    --log-level info
