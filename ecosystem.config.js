const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const LOCAL_CONFIG = path.join(ROOT, 'ecosystem.local.cjs');

const LOCAL = fs.existsSync(LOCAL_CONFIG)
  ? require(LOCAL_CONFIG)
  : {
      nodeAppName: 'vault-os-2',
      aiAppName: 'vault-ai-2',
      nodePort: '8002',
      faceServicePort: '8003',
    };

const FACE_SERVICE_HOST = process.env.FACE_SERVICE_HOST || '127.0.0.1';
const FACE_SERVICE_PORT =
  process.env.FACE_SERVICE_PORT || LOCAL.faceServicePort || '8003';
const NODE_PORT = process.env.PORT || LOCAL.nodePort || '8002';

const FACE_SERVICE_URL =
  process.env.FACE_SERVICE_URL ||
  `http://${FACE_SERVICE_HOST}:${FACE_SERVICE_PORT}`;

const PYTHON = process.env.VAULTOS_PYTHON || path.join(
  ROOT,
  'face_service',
  'venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

module.exports = {
  apps: [
    {
      name: LOCAL.nodeAppName,
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
        PORT: NODE_PORT,
        FACE_SERVICE_URL,
      },
    },
    {
      name: LOCAL.aiAppName,
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
