'use strict';

const RUNTIME_ENV_SPECS = [
  {
    name: 'TRAECN_GATEWAY_HOST',
    section: 'Gateway',
    default: '127.0.0.1',
    aliases: ['TRAECN_HOST', 'HOST', 'TRAE_GATEWAY_HOST', 'TRAE_HOST'],
    type: 'host',
    description: 'Gateway bind host. A non-loopback value requires TRAECN_GATEWAY_TOKEN.'
  },
  {
    name: 'TRAECN_GATEWAY_PORT',
    section: 'Gateway',
    default: '8788',
    aliases: ['TRAECN_PORT', 'PORT', 'TRAE_GATEWAY_PORT', 'TRAE_PORT'],
    type: 'port',
    description: 'Gateway HTTP port.'
  },
  {
    name: 'TRAECN_GATEWAY_TOKEN',
    section: 'Gateway',
    default: '',
    emptyLabel: 'empty (loopback only)',
    aliases: ['TRAE_GATEWAY_TOKEN'],
    type: 'secret',
    description: 'Bearer token. Optional only while the gateway binds to loopback.'
  },
  {
    name: 'TRAECN_GATEWAY_TIMEOUT_MS',
    section: 'Gateway',
    default: '30000',
    aliases: ['TRAE_GATEWAY_TIMEOUT_MS', 'TRAECN_TIMEOUT'],
    type: 'milliseconds',
    description: 'Timeout used by MCP and CLI gateway clients.'
  },
  {
    name: 'TRAECN_CDP_HOST',
    section: 'TraeCN and CDP',
    default: '127.0.0.1',
    aliases: ['TRAE_CDP_HOST'],
    type: 'host',
    description: 'Host exposing the TraeCN Chrome DevTools Protocol endpoint.'
  },
  {
    name: 'TRAECN_REMOTE_DEBUGGING_PORT',
    section: 'TraeCN and CDP',
    default: '9222',
    aliases: ['TRAE_REMOTE_DEBUGGING_PORT', 'TRAECN_QUICKSTART_REMOTE_DEBUGGING_PORT', 'TRAE_QUICKSTART_REMOTE_DEBUGGING_PORT'],
    type: 'port',
    description: 'Single CDP port used by launch, discovery, quickstart, doctor, and services.'
  },
  {
    name: 'TRAECN_QUICKSTART_PROFILE_MODE',
    section: 'TraeCN and CDP',
    default: 'existing',
    aliases: ['TRAE_QUICKSTART_PROFILE_MODE'],
    type: 'enum',
    enum: ['existing', 'isolated'],
    description: 'Reuse the logged-in profile by default; isolated is for disposable testing.'
  },
  {
    name: 'TRAECN_AUTO_START_TRAE',
    section: 'TraeCN and CDP',
    default: '0',
    aliases: ['TRAE_AUTO_START_TRAE', 'TRAECN_AUTOSTART'],
    type: 'boolean',
    description: 'Opt in to automatic TraeCN launch/recovery. quickstart also accepts --launch-trae.'
  },
  {
    name: 'TRAECN_AUTO_CHECK_IN',
    section: 'TraeCN and CDP',
    default: '0',
    aliases: [],
    type: 'boolean',
    description: 'Opt in to daily check-in using the current logged-in TraeCN desktop session.'
  },
  {
    name: 'TRAECN_RESPONSE_TIMEOUT_MS',
    section: 'Task lifecycle',
    default: '1800000',
    aliases: ['TRAE_RESPONSE_TIMEOUT_MS'],
    type: 'milliseconds',
    description: 'Maximum response-collection window (30 minutes).'
  },
  {
    name: 'TRAECN_QUEUE_WAIT_TIMEOUT_MS',
    section: 'Task lifecycle',
    default: '60000',
    aliases: ['TRAE_QUEUE_WAIT_TIMEOUT_MS'],
    type: 'milliseconds',
    description: 'Timeout for one low-level queue wait operation; it is not the total task lifetime.'
  },
  {
    name: 'TRAECN_QUEUE_PER_TASK_TIMEOUT_MS',
    section: 'Task lifecycle',
    default: '600000',
    aliases: ['TRAE_QUEUE_PER_TASK_TIMEOUT_MS'],
    type: 'milliseconds',
    description: 'Deadline-extension window while a task remains in an external model queue.'
  },
  {
    name: 'TRAECN_QUEUE_MAX_WAIT_MS',
    section: 'Task lifecycle',
    default: '',
    emptyLabel: 'empty (unlimited)',
    aliases: ['TRAE_QUEUE_MAX_WAIT_MS'],
    type: 'optional-milliseconds',
    description: 'Optional total local queue cap. Empty means external queues may wait indefinitely.'
  },
  {
    name: 'TRAECN_TERMINAL_IDEMPOTENCY_TTL_MS',
    section: 'Task lifecycle',
    default: '86400000',
    aliases: ['TRAE_TERMINAL_IDEMPOTENCY_TTL_MS'],
    type: 'milliseconds',
    description: 'Retention window for terminal task idempotency replays (24 hours).'
  },
  {
    name: 'TRAECN_ENABLE_MOCK_BRIDGE',
    section: 'Task lifecycle',
    default: '0',
    aliases: ['TRAE_ENABLE_MOCK_BRIDGE'],
    type: 'boolean',
    description: 'Use the mock bridge for tests that do not require a live TraeCN instance.'
  }
];

const RUNTIME_ENV_SCHEMA = Object.freeze(Object.fromEntries(
  RUNTIME_ENV_SPECS.map(({ name, ...spec }) => [name, Object.freeze({
    ...spec,
    aliases: Object.freeze((spec.aliases || []).slice()),
    ...(spec.enum ? { enum: Object.freeze(spec.enum.slice()) } : {})
  })])
));

function runtimeSpec(name) {
  const spec = RUNTIME_ENV_SCHEMA[name];
  if (!spec) throw new Error(`Unknown runtime setting: ${name}`);
  return spec;
}

function runtimeDefault(name) {
  return runtimeSpec(name).default;
}

function readRuntimeEnv(name, env = process.env) {
  const spec = runtimeSpec(name);
  for (const candidate of [name, ...spec.aliases]) {
    if (Object.prototype.hasOwnProperty.call(env, candidate)
        && env[candidate] !== undefined
        && env[candidate] !== '') {
      return String(env[candidate]);
    }
  }
  return spec.default;
}

function renderEnvDefaultsBlock() {
  const lines = [
    '# BEGIN GENERATED: core runtime defaults',
    '# Generated from src/config/runtime-schema.js by scripts/sync-config-docs.js.'
  ];
  let currentSection = null;
  for (const [name, spec] of Object.entries(RUNTIME_ENV_SCHEMA)) {
    if (spec.section !== currentSection) {
      lines.push('', `# ${spec.section}`);
      currentSection = spec.section;
    }
    lines.push(`# ${spec.description}`, `${name}=${spec.default}`);
  }
  lines.push('# END GENERATED: core runtime defaults');
  return lines.join('\n');
}

function renderReadmeDefaultsBlock() {
  const lines = [
    '<!-- BEGIN GENERATED: runtime defaults -->',
    '| Variable | Default | Meaning |',
    '| --- | --- | --- |'
  ];
  for (const [name, spec] of Object.entries(RUNTIME_ENV_SCHEMA)) {
    const defaultValue = spec.default === '' ? spec.emptyLabel : `\`${spec.default}\``;
    lines.push(`| \`${name}\` | ${defaultValue} | ${spec.description.replace(/\|/g, '\\|')} |`);
  }
  lines.push('<!-- END GENERATED: runtime defaults -->');
  return lines.join('\n');
}

function renderConfigurationDocument() {
  const aliasRows = [];
  for (const [name, spec] of Object.entries(RUNTIME_ENV_SCHEMA)) {
    if (spec.aliases.length === 0) continue;
    aliasRows.push(`| \`${name}\` | ${spec.aliases.map(alias => `\`${alias}\``).join(', ')} |`);
  }
  return [
    '# Runtime configuration',
    '',
    '> Generated from `src/config/runtime-schema.js`. Run `npm run sync:config-docs` after changing the schema.',
    '',
    'Canonical variables and defaults:',
    '',
    renderReadmeDefaultsBlock(),
    '',
    'Canonical names take precedence over compatibility aliases. New configuration should use only the canonical names.',
    '',
    '| Canonical variable | Compatibility aliases |',
    '| --- | --- |',
    ...aliasRows,
    '',
    'Queue semantics: `TRAECN_QUEUE_WAIT_TIMEOUT_MS` bounds one low-level UI wait, while an empty `TRAECN_QUEUE_MAX_WAIT_MS` leaves the gateway-managed task alive for an external model queue. These settings are not two competing total-task deadlines.',
    '',
    'Idempotency semantics: a stable `Idempotency-Key` owns an accepted task across',
    'restart. After the task becomes terminal, its fingerprint and terminal response',
    'remain replayable for `TRAECN_TERMINAL_IDEMPOTENCY_TTL_MS` (24 hours by',
    'default); a different request using the same key is rejected instead of being',
    'submitted.',
    '',
    'Startup semantics: `npm run quickstart` performs a bounded TraeCN-identity CDP check before starting the gateway. It launches TraeCN only with `--launch-trae` or `TRAECN_AUTO_START_TRAE=1`. If TraeCN is already running without debug access, quit it and run `TRAECN_QUICKSTART_PROFILE_MODE=existing npm run start:traecn -- --force-new --use-existing-profile`.',
    '',
    'Security: the gateway refuses to bind a non-loopback address unless `TRAECN_GATEWAY_TOKEN` is non-empty.',
    ''
  ].join('\n');
}

module.exports = {
  RUNTIME_ENV_SCHEMA,
  runtimeSpec,
  runtimeDefault,
  readRuntimeEnv,
  renderEnvDefaultsBlock,
  renderReadmeDefaultsBlock,
  renderConfigurationDocument
};
