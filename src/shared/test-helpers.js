'use strict';

/**
 * Shared test helpers.
 *
 * Originally defined inline in src/http/gateway.test.js; lifted out so
 * the per-handler test files (and any future test files) can reuse the
 * same minimal req/res factory without duplicating boilerplate.
 *
 * The factory builds a Node `Readable` that yields a single JSON body
 * chunk (so HTTP handlers that await parseBody keep working) and a
 * res-shaped object whose `writeHead` / `end` capture the response for
 * later assertions.
 */

const { Readable } = require('stream');

function makeReqRes(headers = {}, url = '/api/status', method = 'GET', body = null) {
  const payload = body === null || body === undefined ? '' : JSON.stringify(body);
  const req = new Readable({
    read() {
      if (payload) this.push(payload);
      this.push(null);
    }
  });
  req.method = method;
  req.url = url;
  req.headers = {
    host: '127.0.0.1',
    ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
    ...headers
  };
  req.socket = { remoteAddress: '127.0.0.1' };

  const resHeaders = {};
  const res = {
    statusCode: 200,
    _writtenHead: null,
    _body: null,
    setHeader(name, value) { resHeaders[name.toLowerCase()] = value; },
    getHeader(name) { return resHeaders[name.toLowerCase()]; },
    removeHeader(name) { delete resHeaders[name.toLowerCase()]; },
    writeHead(code, h) {
      res.statusCode = code;
      res._writtenHead = { ...resHeaders, ...h };
    },
    end(responseBody) {
      res._body = responseBody;
      res._ended = true;
    }
  };
  return { req, res, resHeaders };
}

module.exports = { makeReqRes };