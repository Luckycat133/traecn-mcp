#!/usr/bin/env node
'use strict';

/**
 * One-shot handler extractor.
 *
 * For each named handler in src/http/gateway.js, find its definition (by
 * exact regex on the class method signature), extract the body, dedent
 * by 2 spaces, replace `this.` with `ctx.`, and write a function into a
 * generated handlers/<topic>.js module file. Then in gateway.js, replace
 * the original method with a delegating shim.
 *
 * Usage:
 *   node scripts/extract-handlers.js --topic <name> \
 *     --handler <H1> [--handler <H2>] \
 *     --out src/http/handlers/<topic>.js \
 *     [--routes 'JSON array']
 *
 * Example:
 *   node scripts/extract-handlers.js --topic sessions \
 *     --handler _handleCreateSession --handler _handleListSessions \
 *     --handler _handleGetSession --handler _handleDelegate \
 *     --out src/http/handlers/sessions.js \
 *     --routes '[{"method":"POST","path":"/api/sessions","handler":"_handleCreateSession"}]'
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GATEWAY = path.join(ROOT, 'src/http/gateway.js');

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { handlers: [], routes: '[]' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--handler') result.handlers.push(args[++i]);
    else if (args[i] === '--topic') result.topic = args[++i];
    else if (args[i] === '--out') result.out = args[++i];
    else if (args[i] === '--routes') result.routes = args[++i];
  }
  if (!result.handlers.length || !result.topic || !result.out) {
    console.error('usage: --topic <name> --handler <H> [--handler <H2>] --out <path> [--routes <json>]');
    process.exit(1);
  }
  return result;
}

function findHandlerRange(lines, name) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp('^  (async )?' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\(req, res(, [a-zA-Z]+)?\\) \\{$');
    if (re.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end !== -1) break;
  }
  return { start, end };
}

function transformBody(text) {
  // Rename the method and rewrite `this.` to `ctx.`. Detect async.
  const isAsync = /^  async /.test(text);
  // Strip the leading 2-space indent on every line.
  let out = text.split('\n').map(l => l.startsWith('  ') ? l.slice(2) : l).join('\n');
  // Replace `_handleFoo(req, res)` with `function handleFoo(req, res, ctx)`.
  // Always emit the `function` keyword (with optional `async`).
  out = out.replace(/^(async )?(_handle[A-Z]\w*)\(req, res(, [a-zA-Z]+)?\) \{/m, (m, a, name, params) => {
    return `${a ? a + 'function ' : 'function '}${name.replace('_handle', 'handle')}(req, res, ctx${params || ''}) {`;
  });
  // Replace `this.` with `ctx.`.
  out = out.replace(/\bthis\./g, 'ctx.');
  return out;
}

function buildModule(topic, handlerBodies, routes) {
  const lines = [];
  lines.push("'use strict';");
  lines.push('');
  // Auto-detect imports needed by the handler bodies. Known free
  // identifiers that the Gateway gets from its module-level requires and
  // that are used inside `_handle*` methods. We can't enumerate every
  // possible reference, but the common ones are listed here.
  const NEEDED = {
    'parseBody': "const { parseBody } = require('../request-gate');",
    'globalMetrics': "const { globalMetrics } = require('../../shared/metrics');",
    'parsePositiveInt': "const { parsePositiveInt } = require('../../shared/utils');",
    'buildConfirmationPlan': "const { buildConfirmationPlan } = require('../../shared/operation-confirmation');",
  };
  const allText = handlerBodies.join('\n');
  const addedImports = new Set();
  for (const [name, importLine] of Object.entries(NEEDED)) {
    // Use word-boundary to avoid matching inside identifiers.
    if (new RegExp('\\b' + name + '\\b').test(allText)) {
      lines.push(importLine);
      addedImports.add(name);
    }
  }
  if (addedImports.size) lines.push('');
  lines.push('/**');
  lines.push(` * ${topic} handlers.`);
  lines.push(' *');
  lines.push(' * Moved verbatim from src/http/gateway.js. Each handler is now an');
  lines.push(' * exported function with signature `function handleX(req, res, ctx, ...pathParams)`');
  lines.push(' * taking the gateway instance as `ctx`. Behavior is preserved 1:1.');
  lines.push(' *');
  lines.push(' * The Gateway retains thin delegating shims (e.g. `_handleCreateSession`) so');
  lines.push(' * existing gateway.test.js cases that call `gateway._handleCreateSession(...)`');
  lines.push(' * continue to work unchanged.');
  lines.push(' */');
  lines.push('');
  if (routes && routes.length) {
    lines.push('const ROUTES = ' + JSON.stringify(routes, null, 2).split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n') + ';');
    lines.push('');
  }
  lines.push(...handlerBodies);
  lines.push('');
  const exports = ['ROUTES', ...handlerBodies.map(b => b.match(/^(?:async )?function (handle\w+)/)?.[1]).filter(Boolean)];
  lines.push('module.exports = { ' + exports.join(', ') + ' };');
  return lines.join('\n');
}

function main() {
  const args = parseArgs();
  const text = fs.readFileSync(GATEWAY, 'utf8');
  const lines = text.split('\n');

  // Find ranges, sorted by start descending so we can splice without offset drift.
  const ranges = args.handlers.map(name => {
    const r = findHandlerRange(lines, name);
    if (!r) throw new Error(`handler not found: ${name}`);
    return { name, ...r };
  }).sort((a, b) => b.start - a.start);

  // Extract each handler body, then remove from gateway.js and replace with shim.
  const bodies = [];
  for (const r of ranges) {
    const block = lines.slice(r.start, r.end + 1).join('\n');
    bodies.push(transformBody(block));
    // Replace with delegating shim. The sig line looks like:
    //   "  async _handleCreateSession(req, res) {"
    //   "  _handleGetTask(req, res, taskId) {"
    // We capture the param list as text, then call the module function with
    // (req, res, this, ...pathParams).
    const sig = lines[r.start];
    const isAsync = /^  async /.test(sig);
    const paramListMatch = sig.match(/\(([^)]*)\)/);
    const rawParams = paramListMatch ? paramListMatch[1].trim() : 'req, res';
    // Split off the leading "req, res" — anything after is path-params.
    const paramParts = rawParams.split(',').map(p => p.trim());
    const pathParams = paramParts.slice(2); // taskId, sessionId, etc.
    const pathArgs = pathParams.length ? ', ' + pathParams.join(', ') : '';
    // Strip "_handle" prefix to get the bare name (e.g. "_handleCreateSession"
    // -> "CreateSession"). slice(7) is correct: "_handle" is 7 chars.
    const bare = r.name.slice('_handle'.length);
    // Hyphens in topic name would break identifier resolution. Replace
    // any non-identifier chars with camelCase transitions.
    const identTopic = args.topic.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => c ? c.toUpperCase() : '');
    const shim = [
      `  ${isAsync ? 'async ' : ''}_handle${bare}(${rawParams}) {`,
      `    return ${identTopic}Handlers.handle${bare}(req, res, this${pathArgs});`,
      `  }`,
    ];
    lines.splice(r.start, r.end - r.start + 1, ...shim);
  }
  // bodies were collected in descending order — reverse for module export order.
  bodies.reverse();

  fs.writeFileSync(GATEWAY, lines.join('\n'));

  // Build the module file
  const routes = JSON.parse(args.routes);
  const moduleText = buildModule(args.topic, bodies, routes);
  fs.writeFileSync(path.join(ROOT, args.out), moduleText);

  console.log(`Wrote ${args.out} with ${bodies.length} handler(s)`);
  console.log(`gateway.js: ${lines.length} lines`);
}

main();