'use strict';

const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * Read the request body as a UTF-8 string with a hard size limit.
 *
 * Returns one of:
 *   { ok: true,  text }     on success
 *   { ok: false, status, error } when the body is too large or stream errors
 *
 * The check is enforced in two places:
 *   1. The Content-Length header, if present and parseable, must be <= max.
 *   2. The actual bytes read are counted; the stream is destroyed as soon
 *      as the limit is exceeded. This defends against missing/wrong headers.
 */
function readBodyWithLimit(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const declared = parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      resolve({
        ok: false,
        status: 413,
        error: `Request body too large (declared ${declared} > limit ${maxBytes})`
      });
      return;
    }
    let size = 0;
    const chunks = [];
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        // Best-effort: stop reading further bytes.
        try { req.destroy(); } catch { /* ignore */ }
        resolve({
          ok: false,
          status: 413,
          error: `Request body too large (> ${maxBytes} bytes)`
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', (err) => {
      if (aborted) return;
      aborted = true;
      resolve({ ok: false, status: 400, error: 'Failed to read body: ' + err.message });
    });
  });
}

/**
 * Read a JSON body. On top of readBodyWithLimit, this also enforces:
 *   - Content-Type contains 'application/json' (case-insensitive)
 *   - The body must be a non-null object
 *   - Optional schema check (lightweight, no extra dep)
 */
async function readJsonBody(req, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_MAX_BODY_BYTES;
  const ctype = (req.headers['content-type'] || '').toLowerCase();
  if (options.requireJsonContentType !== false && !ctype.includes('application/json')) {
    return { ok: false, status: 415, error: 'Content-Type must be application/json' };
  }
  const result = await readBodyWithLimit(req, maxBytes);
  if (!result.ok) return result;
  if (!result.text) {
    return { ok: false, status: 400, error: 'Request body is empty' };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch (e) {
    return { ok: false, status: 400, error: 'Invalid JSON: ' + e.message };
  }
  if (options.mustBeObject !== false && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
    return { ok: false, status: 400, error: 'Request body must be a JSON object' };
  }
  if (options.schema) {
    const validation = validateSchema(parsed, options.schema);
    if (!validation.ok) return validation;
  }
  return { ok: true, body: parsed };
}

/**
 * Tiny schema validator. Supports:
 *   - { type: 'string'|'number'|'boolean'|'object'|'array' }
 *   - { required: true, type: 'string' }
 *   - { type: 'string', minLength, maxLength, pattern }
 *   - { type: 'number', min, max, integer: true }
 *   - { type: 'array', items: <schema> }
 *   - { type: 'object', properties: { key: <schema> }, required: [...] }
 *
 * Returns { ok: true } when valid, or { ok: false, status, error } otherwise.
 */
function validateSchema(value, schema) {
  if (!schema || typeof schema !== 'object') return { ok: true };

  if (schema.required && value === undefined) {
    return { ok: false, status: 400, error: 'Missing required field' };
  }
  if (value === undefined) return { ok: true };

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        return { ok: false, status: 400, error: 'Expected string' };
      }
      if (schema.minLength != null && value.length < schema.minLength) {
        return { ok: false, status: 400, error: `String shorter than ${schema.minLength}` };
      }
      if (schema.maxLength != null && value.length > schema.maxLength) {
        return { ok: false, status: 400, error: `String longer than ${schema.maxLength}` };
      }
      if (schema.pattern && !(new RegExp(schema.pattern).test(value))) {
        return { ok: false, status: 400, error: 'String does not match required pattern' };
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, status: 400, error: 'Expected number' };
      }
      if (schema.integer && !Number.isInteger(value)) {
        return { ok: false, status: 400, error: 'Expected integer' };
      }
      if (schema.min != null && value < schema.min) {
        return { ok: false, status: 400, error: `Number less than ${schema.min}` };
      }
      if (schema.max != null && value > schema.max) {
        return { ok: false, status: 400, error: `Number greater than ${schema.max}` };
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { ok: false, status: 400, error: 'Expected boolean' };
      }
      break;
    case 'array':
      if (!Array.isArray(value)) {
        return { ok: false, status: 400, error: 'Expected array' };
      }
      if (schema.minItems != null && value.length < schema.minItems) {
        return { ok: false, status: 400, error: `Array shorter than ${schema.minItems}` };
      }
      if (schema.maxItems != null && value.length > schema.maxItems) {
        return { ok: false, status: 400, error: `Array longer than ${schema.maxItems}` };
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const v = validateSchema(value[i], schema.items);
          if (!v.ok) return { ok: false, status: v.status, error: `items[${i}]: ${v.error}` };
        }
      }
      break;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, status: 400, error: 'Expected object' };
      }
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (!(key in value)) {
            return { ok: false, status: 400, error: `Missing required field: ${key}` };
          }
        }
      }
      if (schema.properties) {
        for (const [key, sub] of Object.entries(schema.properties)) {
          if (key in value) {
            const v = validateSchema(value[key], sub);
            if (!v.ok) return { ok: false, status: v.status, error: `${key}: ${v.error}` };
          }
        }
      }
      break;
    }
    default:
      // Unknown type — treat as opaque.
      break;
  }
  return { ok: true };
}

module.exports = {
  readBodyWithLimit,
  readJsonBody,
  validateSchema,
  DEFAULT_MAX_BODY_BYTES,
};