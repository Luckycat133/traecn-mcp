// Flat ESLint v9 config for TRAECNclaw.
// Scope: source code only. Tests/scripts use the existing node --check lint script.
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      'audit-logs/**',
      'coverage/**',
      '**/*.test.js',
      'scripts/**/*.test.js',
      'integrations/**/__tests__/**',
      'inspect-report.json',
    ],
  },
  {
    files: ['src/**/*.js', 'mcp-server.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        // Node.js globals commonly used in this codebase.
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'writable',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-console': 'off',
      'prefer-const': 'warn',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'object-shorthand': 'warn',
    },
  },
];