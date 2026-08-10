# Contributing

VaultOS is a local-first media vault. Keep changes focused, portable, and safe for fresh clones.

## Development Checklist

- Do not commit `.env`, `media/`, generated thumbnails, SQLite databases, virtual environments, `node_modules/`, or ONNX model binaries.
- Keep machine-specific values in `.env` or local shell configuration.
- Run `npm install` or `npm ci` before Node-side validation.
- Run the Python face service from `face_service/venv` before validating face detection or clustering.
- Verify changed JavaScript with `node --check <file>`.
- Verify changed Python with `python -m py_compile <file>`.
- Prefer minimal, targeted fixes over broad rewrites.

## Local Run

```powershell
.\setup.ps1
.\start.ps1
```

For Node-only work:

```powershell
npm start
```
