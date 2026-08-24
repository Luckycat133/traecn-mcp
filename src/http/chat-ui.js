'use strict';

const fs = require('fs');
const path = require('path');

const WEB_CONSOLE_ROOT = path.join(__dirname, 'web-console');
const WEB_CONSOLE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const WEB_CONSOLE_ASSETS = new Map([
  [
    '/assets/web-console/styles.css',
    {
      file: 'styles.css',
      contentType: 'text/css; charset=utf-8',
    },
  ],
  [
    '/assets/web-console/state.js',
    {
      file: 'state.js',
      contentType: 'text/javascript; charset=utf-8',
    },
  ],
  [
    '/assets/web-console/app.js',
    {
      file: 'app.js',
      contentType: 'text/javascript; charset=utf-8',
    },
  ],
]);

function readConsoleFile(fileName) {
  return fs.readFileSync(path.join(WEB_CONSOLE_ROOT, fileName), 'utf8');
}

function renderChatUI() {
  return readConsoleFile('index.html');
}

function getWebConsoleAsset(pathname) {
  const descriptor = WEB_CONSOLE_ASSETS.get(pathname);
  if (!descriptor) return null;
  return {
    body: readConsoleFile(descriptor.file),
    contentType: descriptor.contentType,
  };
}

module.exports = {
  WEB_CONSOLE_ASSETS,
  WEB_CONSOLE_CSP,
  getWebConsoleAsset,
  renderChatUI,
};
