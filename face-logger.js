'use strict';

/**
 * face-logger.js
 * Structured, component-namespaced logger for the face indexing subsystem.
 *
 * All face modules share this logger.  Each creates an instance with its own
 * component name so log lines are immediately grep-able:
 *
 *   const log = new FaceLogger('INFER');
 *   log.info('Model loaded', { model: 'det_10g.onnx', ms: 420 });
 *   // → [FACE:INFER ] 14:23:05.182 INFO  Model loaded {"model":"det_10g.onnx","ms":420}
 *
 * Set FACE_DEBUG=1 in the environment to enable debug-level output.
 * Set FACE_LOG_JSON=1 to emit machine-readable JSON lines instead.
 */

const DEBUG_ENABLED = !!process.env.FACE_DEBUG;
const JSON_MODE     = !!process.env.FACE_LOG_JSON;

class FaceLogger {
  /**
   * @param {string} component  Short upper-case identifier, e.g. 'DB', 'INFER', 'WORKER'
   */
  constructor(component) {
    this.component = component.toUpperCase().padEnd(6).slice(0, 6);
  }

  // ── Internal emit ────────────────────────────────────────────

  _emit(level, msg, data) {
    const now  = new Date();
    const ts   = now.toISOString().slice(11, 23);   // HH:MM:SS.mmm

    if (JSON_MODE) {
      const line = JSON.stringify({
        ts:  now.toISOString(),
        lvl: level,
        cmp: this.component.trim(),
        msg,
        ...(data && Object.keys(data).length ? data : {}),
      });
      (level === 'ERROR' || level === 'WARN')
        ? process.stderr.write(line + '\n')
        : process.stdout.write(line + '\n');
      return;
    }

    const prefix = `[FACE:${this.component}] ${ts} ${level.padEnd(5)}`;
    const suffix = (data && Object.keys(data).length)
      ? '  ' + JSON.stringify(data)
      : '';
    const line = `${prefix} ${msg}${suffix}`;

    (level === 'ERROR' || level === 'WARN')
      ? process.stderr.write(line + '\n')
      : process.stdout.write(line + '\n');
  }

  // ── Public API ───────────────────────────────────────────────

  info (msg, data = {}) { this._emit('INFO',  msg, data); }
  warn (msg, data = {}) { this._emit('WARN',  msg, data); }
  error(msg, data = {}) { this._emit('ERROR', msg, data); }

  /** Only emitted when FACE_DEBUG=1 */
  debug(msg, data = {}) {
    if (DEBUG_ENABLED) this._emit('DEBUG', msg, data);
  }

  /**
   * Start a named timer.  Call .end(extraData) to log the elapsed ms.
   *
   * @example
   *   const t = log.timer('SCRFD inference');
   *   await runInference();
   *   t.end({ faces: 3 });
   *   // → INFO  SCRFD inference  {"ms":123,"faces":3}
   */
  timer(label) {
    const start = process.hrtime.bigint();
    return {
      end: (data = {}) => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        this._emit('INFO', label, { ms: Math.round(ms * 10) / 10, ...data });
        return ms;
      },
    };
  }

  /**
   * Log an operation result in a standardised format.
   * Useful for queue/batch events: log.event('INDEXED', 'photo.jpg', {faces:2}).
   */
  event(kind, subject, data = {}) {
    this._emit('INFO', `${kind} ${subject}`, data);
  }
}

module.exports = { FaceLogger };
