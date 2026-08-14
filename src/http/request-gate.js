'use strict';

/**
 * Request gate: low-level HTTP utilities shared by the Gateway and its
 * extracted handlers.
 *
 * Responsibilities:
 *   - URL safety (normalizeUrl, _redactUrl)
 *   - Body parsing (parseBody) with size cap and JSON validation
 *   - CORS / origin policy (corsHeaders, checkOrigin, isSameGatewayOrigin)
 *   - Authentication (authenticate) using a configured token + auth header
 *   - Rate limiting (RateLimiter, checkRateLimit, resolveRateLimitKey)
 *   - Idempotency cache (checkIdempotency / storeIdempotency)
 *   - Response helpers (jsonResponse with gzip, htmlResponse, HttpError)
 *
 * All functions are pure or accept their dependencies explicitly so this
 * module can be unit-tested in isolation, without spinning up a Gateway.
 *
 * The Gateway wires these helpers together via `buildRequestGate(ctx)`,
 * which closes over the Gateway's runtime config (token, allowedOrigins,
 * rate-limiter, idempotency map, auth header name).
 */

const zlib = require('zlib');
const { URL } = require('url');
const requestContext = require('../shared/request-context');
const { secureCompare, SENSITIVE_LOG_KEYS } = require('../shared/utils');

const DEFAULT_JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

const DEFAULT_HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
};

// 1 MiB body cap. Anything bigger becomes a 413 HttpError so the connection
// is reused (reject + destroy() rather than buffering forever).
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

// Only gzip responses bigger than 1 KiB — below that the gzip framing
// overhead costs more bytes than it saves.
const GZIP_MIN_BYTES = 1024;

/**
 * Percent-encode any non-ASCII bytes in a raw URL. Returned value is safe to
 * log without mangling the path or query.
 */
function normalizeUrl(rawUrl) {
  return rawUrl.replace(/[\x80-\xff]/g, ch => {
    const byteVal = Buffer.from(ch, 'latin1')[0];
    return '%' + byteVal.toString(16).toUpperCase().padStart(2, '0');
  });
}

/**
 * Strip sensitive query params (token, authorization, api_key, secret,
 * password) from a URL before it lands in a log line. Returns the path +
 * redacted query, or the original string if there is no query.
 */
function redactUrl(rawUrl) {
  if (!rawUrl || rawUrl.indexOf('?') === -1) return rawUrl;
  const qIdx = rawUrl.indexOf('?');
  const path = rawUrl.slice(0, qIdx);
  const query = rawUrl.slice(qIdx + 1);
  const redacted = query.replace(
    /(^|&)(token|authorization|api[_-]?key|secret|password)(=)/gi,
    (_match, sep, _key, _eq) => `${sep}${_key}=[REDACTED]`
  );
  return path + '?' + redacted;
}

/**
 * Sliding-window in-memory rate limiter.
 *
 * The window is keyed by an arbitrary string (the "identity"): typically an
 * API key id, IP, or "anonymous". `check(key)` is allowed to return false
 * only after `maxRequests` requests have landed inside the trailing
 * `windowMs`.
 */
class RateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map();
    this._lastCleanup = Date.now();
  }

  _cleanup() {
    const now = Date.now();
    if (now - this._lastCleanup < this.windowMs) return;
    this._lastCleanup = now;
    for (const [key, record] of this.requests) {
      if (now - record.startTime > this.windowMs) {
        this.requests.delete(key);
      }
    }
  }

  /**
   * Returns true if the request is allowed (and has been counted),
   * false if it should be rejected.
   */
  check(key) {
    this._cleanup();
    const now = Date.now();
    const record = this.requests.get(key);

    if (!record || now - record.startTime > this.windowMs) {
      this.requests.set(key, { startTime: now, count: 1 });
      return true;
    }

    record.count++;
    return record.count <= this.maxRequests;
  }

  getRemaining(key) {
    const record = this.requests.get(key);
    if (!record) return this.maxRequests;
    return Math.max(0, this.maxRequests - record.count);
  }
}

/**
 * Parse a JSON request body with a hard size cap. Anything bigger than
 * `maxBytes` (default 1 MiB) is rejected as 413 and the socket is destroyed
 * so the connection is closed promptly.
 */
function parseBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError('Request body too large', 413, 'REQUEST_BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new HttpError('Invalid JSON body', 400, 'INVALID_JSON'));
      }
    });

    req.on('error', reject);
  });
}

/**
 * Tagged error type. The Gateway's request pipeline catches these and
 * uses `statusCode` + `code` to drive the HTTP response (rather than letting
 * them bubble to the generic 500 handler).
 */
class HttpError extends Error {
  constructor(message, statusCode = 500, code = 'HTTP_ERROR') {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Write a JSON response with optional gzip compression for bodies larger
 * than 1 KiB when the client accepts it.
 */
function jsonResponse(res, data, statusCode = 200, headers = {}, req = null) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  const acceptEncoding = req ? (req.headers['accept-encoding'] || '') : '';
  const useGzip = body.length > GZIP_MIN_BYTES && acceptEncoding.includes('gzip');
  const responseHeaders = { ...DEFAULT_JSON_HEADERS, ...headers };

  if (useGzip) {
    responseHeaders['Content-Encoding'] = 'gzip';
    res.writeHead(statusCode, responseHeaders);
    zlib.gzip(body, (err, compressed) => {
      if (err) {
        res.end(body);
      } else {
        res.end(compressed);
      }
    });
  } else {
    res.writeHead(statusCode, responseHeaders);
    res.end(body);
  }
}

function htmlResponse(res, html, statusCode = 200, headers = {}) {
  res.writeHead(statusCode, {
    ...DEFAULT_HTML_HEADERS,
    ...headers
  });
  res.end(html);
}

/**
 * Resolve the rate-limit identity for a request.
 *
 * Preference order:
 *   1. authKeyId populated on the request context (an authenticated
 *      API-key call) — the only stable identifier when a single client
 *      funnels traffic through a shared egress.
 *   2. IP address — works for unauthenticated traffic, but NAT / proxies
 *      collapse many real callers into one bucket.
 *   3. 'anonymous' as a final fallback.
 */
function resolveRateLimitKey(req) {
  try {
    const authKeyId = requestContext.get('authKeyId');
    if (authKeyId && typeof authKeyId === 'string') {
      return `key:${authKeyId}`;
    }
  } catch { /* no active context — fall through */ }
  const ip = req?.socket?.remoteAddress;
  return ip ? `ip:${ip}` : 'anonymous';
}

/**
 * Build a `gate` object with all the per-request security checks the
 * Gateway needs. Captures the runtime config in a closure so handlers
 * don't need to thread it through every call.
 *
 * `config` shape:
 *   - token: string | null   (null disables auth)
 *   - authHeader: string     (header name to read; case-insensitive)
 *   - allowedOrigins: string (CSV; "*" or empty == same-origin only)
 *   - rateLimiter: RateLimiter
 *   - idempotencyKeys: Map<string, {statusCode, data}>
 */
function buildRequestGate(config) {
  const {
    token = null,
    authHeader = 'authorization',
    allowedOrigins = '',
    rateLimiter,
    idempotencyKeys = new Map(),
  } = config;

  const allowedOriginsList = allowedOrigins.split(',').map(o => o.trim()).filter(Boolean);

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!allowedOriginsList.length) {
      if (origin && isSameGatewayOrigin(req, origin)) {
        return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
      }
      return {};
    }
    if (allowedOriginsList.includes('*')) {
      return { 'Access-Control-Allow-Origin': '*' };
    }
    if (origin && allowedOriginsList.includes(origin)) {
      return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    }
    return {};
  }

  function authenticate(req) {
    if (!token) return true;
    const authHeaderValue = req.headers[authHeader.toLowerCase()] || '';
    if (authHeaderValue.startsWith('Bearer ')) {
      return secureCompare(authHeaderValue.slice(7), token);
    }
    const customToken = req.headers['x-traecn-token'];
    if (customToken) {
      return secureCompare(customToken, token);
    }
    return false;
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (!allowedOriginsList.length) return isSameGatewayOrigin(req, origin);
    return allowedOriginsList.includes(origin) || allowedOriginsList.includes('*');
  }

  function isSameGatewayOrigin(req, origin) {
    try {
      const parsed = new URL(origin);
      const host = String(req.headers.host || '').toLowerCase();
      if (!host) return false;
      return parsed.host.toLowerCase() === host;
    } catch {
      return false;
    }
  }

  function checkRateLimit(req) {
    const key = resolveRateLimitKey(req);
    return rateLimiter.check(key);
  }

  function checkIdempotency(req) {
    const key = req.headers['idempotency-key'];
    if (!key) return null;
    if (idempotencyKeys.has(key)) return idempotencyKeys.get(key);
    return null;
  }

  function storeIdempotency(key, response) {
    idempotencyKeys.set(key, response);
  }

  function json(req, res, data, statusCode = 200, headers = {}) {
    return jsonResponse(res, data, statusCode, { ...corsHeaders(req), ...headers }, req);
  }

  function html(req, res, body, statusCode = 200, headers = {}) {
    return htmlResponse(res, body, statusCode, { ...corsHeaders(req), ...headers });
  }

  return {
    corsHeaders,
    authenticate,
    checkOrigin,
    isSameGatewayOrigin,
    checkRateLimit,
    checkIdempotency,
    storeIdempotency,
    resolveRateLimitKey,
    json,
    html,
  };
}

module.exports = {
  // Pure helpers
  normalizeUrl,
  redactUrl,
  secureCompare,
  parseBody,
  jsonResponse,
  htmlResponse,
  resolveRateLimitKey,
  // Class
  RateLimiter,
  HttpError,
  // Closure factory
  buildRequestGate,
  // Constants (re-exported for tests + legacy callers)
  SENSITIVE_LOG_KEYS,
  DEFAULT_JSON_HEADERS,
  DEFAULT_HTML_HEADERS,
  DEFAULT_MAX_BODY_BYTES,
};