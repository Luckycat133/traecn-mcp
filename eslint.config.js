// Flat ESLint v9 config for TRAECNclaw.
//
// Scope: source code under src/, mcp-server.js, scripts/, and integrations/.
// Tests (*.test.js) are excluded — they keep their own assertion shape and a
// shared test-runner harness (no test framework).
//
// Note on sourceType: this project is CommonJS (require/module.exports). Using
// 'commonjs' makes ESLint recognise require/module/exports/__dirname/__filename
// as built-in globals — without it, every CommonJS file emits hundreds of
// no-undef false positives.
import js from '@eslint/js';

const NODE_GLOBALS = {
  // CommonJS built-ins (auto-recognised with sourceType: 'commonjs', listed here
  // for clarity and to silence the few rules that don't honour the source type).
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  module: 'readonly',
  require: 'readonly',
  exports: 'writable',
  global: 'readonly',
  globalThis: 'readonly',
  // Timers
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  // Web-platform globals now native in Node 22+
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  WebSocket: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  performance: 'readonly',
  crypto: 'readonly',
  structuredClone: 'readonly',
};

const SHARED_RULES = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'no-console': 'off',
  'prefer-const': 'warn',
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'object-shorthand': 'warn',
};

export default [
  js.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      'audit-logs/**',
      'coverage/**',
      '.coverage/**',
      '**/*.test.js',
      'inspect-report.json',
      'demo-output/**',
      'logs/**',
      '.claude/**',
      'skills/**',
      '.agents/**',
      '.codex/**',
      '.trae/**',
    ],
  },
  {
    files: [
      'src/**/*.js',
      'mcp-server.js',
      'scripts/**/*.js',
      'integrations/**/*.js',
      'coverage-summary.js',
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: SHARED_RULES,
  },
];
