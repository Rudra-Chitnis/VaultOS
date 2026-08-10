const path = require('path');

const ROOT = __dirname;
const FACE_SERVICE_HOST = process.env.FACE_SERVICE_HOST || '127.0.0.1';
const FACE_SERVICE_PORT = process.env.FACE_SERVICE_PORT || '7860';
const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL || `http://${FACE_SERVICE_HOST}:${FACE_SERVICE_PORT}`;
const PYTHON = process.env.VAULTOS_PYTHON || path.join(
  ROOT,
  'face_service',
  'venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

module.exports = {
  apps: [
    {
      name: 'vault-os',
      cwd: ROOT,
      script: 'server.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      windowsHide: true,
      env: {
        NODE_ENV: 'production',
        FACE_SERVICE_URL,
      },
    },
    {
      name: 'vault-ai',
      cwd: ROOT,
      script: PYTHON,
      args: `-m uvicorn face_service.main:app --host ${FACE_SERVICE_HOST} --port ${FACE_SERVICE_PORT}`,
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      windowsHide: true,
      env: {
        FACE_SERVICE_HOST,
        FACE_SERVICE_PORT,
      },
    },
  ],
};
