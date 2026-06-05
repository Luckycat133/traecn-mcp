'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m'
};

const CONFIG_FILE = path.join(os.homedir(), '.traecnrc');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;

let config = null;

function color(col, text) {
  return COLORS[col] + text + COLORS.reset;
}

function loadConfig() {
  if (config) return config;

  const defaults = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    token: process.env.TRAECN_GATEWAY_TOKEN || ''
  };

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(content);
      config = { ...defaults, ...parsed };
    } else {
      config = defaults;
    }
  } catch {
    config = defaults;
  }

  if (process.env.TRAECN_HOST) config.host = process.env.TRAECN_HOST;
  if (process.env.TRAECN_PORT) config.port = parseInt(process.env.TRAECN_PORT, 10);
  if (process.env.TRAECN_GATEWAY_TOKEN) config.token = process.env.TRAECN_GATEWAY_TOKEN;

  return config;
}

function saveConfig(newConfig) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
    return true;
  } catch {
    return false;
  }
}

function apiRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const cfg = loadConfig();
    const options = {
      hostname: cfg.host,
      port: cfg.port,
      path: endpoint,
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 60000
    };

    if (cfg.token) {
      options.headers['Authorization'] = `Bearer ${cfg.token}`;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function showProgress(current, total, label = '') {
  const width = 30;
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const percent = Math.round((current / total) * 100);
  process.stdout.write(`\r${color('cyan', label)} [${bar}] ${percent}% (${current}/${total})`);
  if (current === total) {
    process.stdout.write('\n');
  }
}

function showHelp() {
  console.log(`
${color('bold', 'TraeCN CLI')} - Command line interface for TraeCN Gateway

${color('bold', 'USAGE:')}
  traecn <command> [options]

${color('bold', 'COMMANDS:')}
  ${color('green', 'delegate')} <task>      Execute a task
  ${color('green', 'delegate')} -f <file>    Execute task from file
  ${color('green', 'status')}                Show gateway status
  ${color('green', 'capabilities')}          Show compact agent capability catalog
  ${color('green', 'preflight')} [cmd] [json] One-call readiness/queue/dialog preflight
  ${color('green', 'plan')} <command> [json] Create operation confirmation plan
  ${color('green', 'models')}                List available models
  ${color('green', 'config')} get <key>      Get config value
  ${color('green', 'config')} set <key> <value>  Set config value
  ${color('green', 'batch')} submit <file>   Submit batch tasks from JSON file
  ${color('green', 'batch')} status <id>     Check batch status
  ${color('green', 'batch')} cancel <id>    Cancel batch
  ${color('green', 'logs')} [lines]          View recent logs
  ${color('green', 'help')}                 Show this help

${color('bold', 'OPTIONS:')}
  -h, --help              Show help
  -o, --output <format>   Output format (json, text) [default: text]
  -w, --wait              Wait for result (default for delegate)
  --no-wait               Return immediately without waiting
  -p, --priority <n>      Task priority (1-10) for batch [default: 5]
  -s, --strategy <mode>   Batch strategy: parallel, sequential, priority
  -c, --concurrency <n>   Max concurrent tasks for batch [default: 5]
  --callback <url>        Callback URL for batch completion

${color('bold', 'EXAMPLES:')}
  traecn delegate "Write a hello world program"
  traecn delegate -f task.txt
  traecn status
  traecn capabilities
  traecn preflight delegate_async '{"task":"..."}'
  traecn plan settings_set '{"label":"Auto Save","value":true}'
  traecn models
  traecn config get host
  traecn config set host 192.168.1.100
  traecn batch submit tasks.json
  traecn batch status batch_123456_abc
  traecn logs 100

${color('bold', 'CONFIG FILE:')}
  Config is stored at ${CONFIG_FILE}
  Supported keys: host, port, token

${color('bold', 'ENVIRONMENT:')}
  TRAECN_HOST, TRAECN_PORT, TRAECN_GATEWAY_TOKEN
`);
}

function parseJsonArg(raw, label) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.error(color('red', `Error: ${label} must be valid JSON`));
    process.exit(1);
  }
}

async function cmdDelegate(args) {
  const cfg = loadConfig();
  let task = '';
  let waitForResult = true;
  let outputFormat = 'text';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' || args[i] === '--file') {
      const filePath = args[++i];
      try {
        task = fs.readFileSync(filePath, 'utf8');
      } catch {
        console.error(color('red', `Error: Cannot read file ${filePath}`));
        process.exit(1);
      }
    } else if (args[i] === '-o' || args[i] === '--output') {
      outputFormat = args[++i] || 'text';
    } else if (args[i] === '--no-wait') {
      waitForResult = false;
    } else if (!args[i].startsWith('-')) {
      task = args.slice(i).join(' ');
      break;
    }
  }

  if (!task.trim()) {
    console.error(color('red', 'Error: Task is required'));
    console.error(color('gray', 'Usage: traecn delegate <task>'));
    process.exit(1);
  }

  console.log(color('cyan', 'Executing task...'));
  console.log(color('dim', task.substring(0, 200) + (task.length > 200 ? '...' : '')));

  try {
    const result = await apiRequest('POST', '/api/delegate-async', {
      task,
      waitForQueue: waitForResult
    });

    if (result.status === 202 && result.data.status === 'queued') {
      console.log(color('yellow', '⚠ Task queued, use traecn status to check progress'));
      console.log(color('dim', `Task ID: ${result.data.taskId}`));
      if (outputFormat === 'json') {
        console.log(JSON.stringify(result.data, null, 2));
      }
      return;
    }

    if (result.status === 202 && result.data.status === 'running') {
      console.log(color('yellow', '⚠ Trae is busy, task queued'));
      console.log(color('dim', `Task ID: ${result.data.taskId}`));
      if (outputFormat === 'json') {
        console.log(JSON.stringify(result.data, null, 2));
      }
      return;
    }

    if (result.data.status === 'done') {
      console.log(color('green', '✓ Task completed'));
      if (outputFormat === 'json') {
        console.log(JSON.stringify(result.data, null, 2));
      } else {
        console.log(color('white', result.data.text || result.data.message));
        if (result.data.elapsedMs) {
          console.log(color('dim', `Elapsed: ${result.data.elapsedMs}ms`));
        }
      }
      if (result.data.needsApproval) {
        console.log(color('yellow', `⚠ Requires approval: ${result.data.question}`));
      }
    } else {
      console.error(color('red', `Error: ${result.data.error || 'Unknown error'}`));
      if (outputFormat === 'json') {
        console.log(JSON.stringify(result.data, null, 2));
      }
      process.exit(1);
    }
  } catch (err) {
    console.error(color('red', `Request failed: ${err.message}`));
    process.exit(1);
  }
}

async function cmdCapabilities(args) {
  const outputFormat = args.includes('--json') || args.includes('-o') && args[args.indexOf('-o') + 1] === 'json'
    ? 'json'
    : 'text';
  try {
    const result = await apiRequest('GET', '/api/capabilities');
    if (result.status !== 200) {
      console.error(color('red', `Error: ${result.data.error || 'Unable to read capabilities'}`));
      process.exit(1);
    }
    if (outputFormat === 'json') {
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }

    console.log(`\n${color('bold', '═══ TraeCN Capabilities ═══')}\n`);
    console.log(`  ${color('cyan', 'Version:')} ${result.data.version}`);
    console.log(`  ${color('cyan', 'Commands:')} ${result.data.commands.length}`);
    console.log(`  ${color('cyan', 'HTTP ops:')} ${result.data.http.length}`);
    console.log(`  ${color('cyan', 'Token flow:')} ${result.data.tokenStrategy.prefer.join(' → ')}`);
    console.log(`  ${color('cyan', 'Coverage:')} ${Object.entries(result.data.coverage).filter(([, value]) => value === true).map(([key]) => key).join(', ')}`);
    console.log('');
  } catch (err) {
    console.error(color('red', `Request failed: ${err.message}`));
    process.exit(1);
  }
}

async function cmdPlan(args) {
  const command = args[0];
  if (!command) {
    console.error(color('red', 'Error: command is required'));
    console.error(color('gray', 'Usage: traecn plan <command> [params-json] [--force-confirm]'));
    process.exit(1);
  }
  const params = args[1] && !args[1].startsWith('-') ? parseJsonArg(args[1], 'params') : {};
  const forceConfirm = args.includes('--force-confirm');

  try {
    const result = await apiRequest('POST', '/api/confirm/plan', {
      command,
      params,
      forceConfirm
    });
    if (result.status !== 200) {
      console.error(color('red', `Error: ${result.data.error || 'Unable to create plan'}`));
      process.exit(1);
    }

    const plan = result.data;
    console.log(`\n${color('bold', '═══ Operation Plan ═══')}\n`);
    console.log(`  ${color('cyan', 'Command:')} ${plan.command}`);
    console.log(`  ${color('cyan', 'Risk:')}    ${plan.risk === 'high' ? color('red', plan.risk) : plan.risk === 'medium' ? color('yellow', plan.risk) : color('green', plan.risk)}`);
    console.log(`  ${color('cyan', 'Confirm:')} ${plan.requiresConfirmation ? color('yellow', 'required') : color('dim', 'not required')}`);
    console.log(`  ${color('cyan', 'ID:')}      ${plan.confirmationId}`);
    if (plan.sideEffects && plan.sideEffects.length) {
      console.log(`\n${color('bold', 'Side effects:')}`);
      plan.sideEffects.forEach(item => console.log(`  - ${item}`));
    }
    if (plan.preflight && plan.preflight.length) {
      console.log(`\n${color('bold', 'Preflight:')}`);
      plan.preflight.forEach(item => console.log(`  - ${item}`));
    }
    console.log(`\n${color('dim', plan.tokenHint || '')}\n`);
  } catch (err) {
    console.error(color('red', `Request failed: ${err.message}`));
    process.exit(1);
  }
}

async function cmdPreflight(args) {
  const command = args[0] && !args[0].startsWith('-') ? args[0] : null;
  const paramsArg = command && args[1] && !args[1].startsWith('-') ? args[1] : null;
  const params = paramsArg ? parseJsonArg(paramsArg, 'params') : {};
  const forceConfirm = args.includes('--force-confirm');
  const outputFormat = args.includes('--json') || args.includes('-o') && args[args.indexOf('-o') + 1] === 'json'
    ? 'json'
    : 'text';

  try {
    const result = await apiRequest('POST', '/api/preflight', {
      ...(command ? { command } : {}),
      ...(Object.keys(params).length ? { params } : {}),
      forceConfirm
    });
    if (result.status !== 200) {
      console.error(color('red', `Error: ${result.data.error || 'Unable to run preflight'}`));
      process.exit(1);
    }
    if (outputFormat === 'json') {
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }

    const data = result.data;
    console.log(`\n${color('bold', '═══ TraeCN Preflight ═══')}\n`);
    console.log(`  ${color('cyan', 'Connected:')} ${data.connected ? color('green', 'yes') : color('yellow', 'no')}`);
    console.log(`  ${color('cyan', 'Ready:')}     ${data.ready ? color('green', 'yes') : color('yellow', 'no')}`);
    console.log(`  ${color('cyan', 'Delegate:')}  ${data.canDelegate ? color('green', 'ready') : color('yellow', 'not yet')}`);
    console.log(`  ${color('cyan', 'Next:')}      ${data.nextAction}`);
    if (data.queue) {
      console.log(`  ${color('cyan', 'Queue:')}     ${data.queue.queued ? 'queued' : data.queue.running ? 'running' : 'idle'}`);
    }
    if (data.dialog) {
      console.log(`  ${color('cyan', 'Dialog:')}    ${data.dialog.hasDialog ? data.dialog.dialogType || 'present' : 'clear'}`);
    }
    if (data.commandPlan) {
      console.log(`  ${color('cyan', 'Command:')}   ${data.commandPlan.command} (${data.commandPlan.risk}, confirm=${data.commandPlan.requiresConfirmation})`);
      console.log(`  ${color('cyan', 'Plan ID:')}   ${data.commandPlan.confirmationId}`);
    }
    console.log(`\n${color('dim', data.tokenHint || '')}\n`);
  } catch (err) {
    console.error(color('red', `Request failed: ${err.message}`));
    process.exit(1);
  }
}

async function cmdStatus() {
  try {
    const result = await apiRequest('GET', '/api/status');
    const cfg = loadConfig();

    console.log(`\n${color('bold', '═══ TraeCN Gateway Status ═══')}\n`);
    console.log(`  ${color('cyan', 'Service:')}    traecn-cdp-http-bridge`);
    console.log(`  ${color('cyan', 'Version:')}    ${result.data.version || 'unknown'}`);
    console.log(`  ${color('cyan', 'Endpoint:')}   ${cfg.host}:${cfg.port}`);
    console.log(`  ${color('cyan', 'Status:')}     ${result.data.status === 'connected' ? color('green', '● Connected') : color('yellow', '● Disconnected')}`);
    console.log(`  ${color('cyan', 'Mock:')}       ${result.data.mockBridge ? color('yellow', 'Enabled') : color('dim', 'Disabled')}`);
    console.log(`  ${color('cyan', 'Uptime:')}     ${Math.round(result.data.uptime || 0)}s`);

    if (result.data.cdp) {
      console.log(`  ${color('cyan', 'CDP Browser:')} ${result.data.cdp.browser || 'unknown'}`);
    }

    console.log('');
  } catch (err) {
    console.error(color('red', `Error: ${err.message}`));
    process.exit(1);
  }
}

async function cmdModels() {
  try {
    const settings = await apiRequest('GET', '/api/settings/read?section=model');
    const readiness = await apiRequest('GET', '/api/readiness');

    console.log(`\n${color('bold', '═══ Available Models ═══')}\n`);

    if (settings.data.options) {
      const models = Array.isArray(settings.data.options)
        ? settings.data.options
        : [settings.data.options];

      models.forEach((model, index) => {
        const isActive = readiness.data.currentModel === model ||
                        (typeof model === 'object' && readiness.data.currentModel === model.id);
        const marker = isActive ? color('green', ' ● ') : '   ';
        const name = typeof model === 'string' ? model : model.name || model.id || JSON.stringify(model);
        console.log(`  ${marker} ${name}`);
      });
    } else if (settings.data.data) {
      console.log(color('dim', '  Model settings available, check UI for options'));
    } else {
      console.log(color('dim', '  No model information available'));
    }

    if (readiness.data.currentModel) {
      console.log(`\n  ${color('cyan', 'Current Model:')} ${color('white', readiness.data.currentModel)}`);
    }

    console.log('');
  } catch (err) {
    console.error(color('red', `Error: ${err.message}`));
    process.exit(1);
  }
}

async function cmdConfig(args) {
  const cfg = loadConfig();

  if (args.length === 0) {
    console.log(`\n${color('bold', '═══ TraeCN Configuration ═══')}\n`);
    console.log(`  ${color('cyan', 'host:')}   ${cfg.host}`);
    console.log(`  ${color('cyan', 'port:')}   ${cfg.port}`);
    console.log(`  ${color('cyan', 'token:')}  ${cfg.token ? color('green', '[set]') : color('dim', '[not set]')}`);
    console.log(`  ${color('dim', '\n  Config file:')} ${CONFIG_FILE}`);
    console.log('');
    return;
  }

  const action = args[0];

  if (action === 'get') {
    const key = args[1];
    if (!key) {
      console.error(color('red', 'Error: Key required'));
      console.error(color('gray', 'Usage: traecn config get <key>'));
      process.exit(1);
    }
    const value = cfg[key];
    if (value !== undefined) {
      console.log(value);
    } else {
      console.error(color('red', `Error: Key "${key}" not found`));
      process.exit(1);
    }
    return;
  }

  if (action === 'set') {
    const key = args[1];
    const value = args[2];

    if (!key || value === undefined) {
      console.error(color('red', 'Error: Key and value required'));
      console.error(color('gray', 'Usage: traecn config set <key> <value>'));
      process.exit(1);
    }

    if (!['host', 'port', 'token'].includes(key)) {
      console.error(color('red', `Error: Unknown config key "${key}"`));
      console.error(color('gray', 'Supported keys: host, port, token'));
      process.exit(1);
    }

    const newConfig = { ...cfg };
    if (key === 'port') {
      newConfig.port = parseInt(value, 10);
      if (isNaN(newConfig.port)) {
        console.error(color('red', 'Error: Port must be a number'));
        process.exit(1);
      }
    } else {
      newConfig[key] = value;
    }

    if (saveConfig(newConfig)) {
      console.log(color('green', `✓ ${key} set to "${value}"`));
    } else {
      console.error(color('red', `Error: Failed to save config`));
      process.exit(1);
    }
    return;
  }

  console.error(color('red', `Error: Unknown config command "${action}"`));
  console.error(color('gray', 'Usage: traecn config [get <key> | set <key> <value>]'));
  process.exit(1);
}

async function cmdBatch(args) {
  if (args.length === 0) {
    console.error(color('red', 'Error: Batch command required'));
    console.error(color('gray', 'Usage: traecn batch [submit|status|cancel] [args]'));
    process.exit(1);
  }

  const action = args[0];

  if (action === 'submit') {
    const filePath = args[1];
    if (!filePath) {
      console.error(color('red', 'Error: File path required'));
      console.error(color('gray', 'Usage: traecn batch submit <file.json>'));
      process.exit(1);
    }

    let tasksData;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      tasksData = JSON.parse(content);
    } catch {
      console.error(color('red', `Error: Cannot read or parse ${filePath}`));
      process.exit(1);
    }

    let strategy = 'parallel';
    let maxConcurrency = 5;
    let callbackUrl = null;

    for (let i = 2; i < args.length; i++) {
      if (args[i] === '-s' || args[i] === '--strategy') {
        strategy = args[++i] || 'parallel';
      } else if (args[i] === '-c' || args[i] === '--concurrency') {
        maxConcurrency = parseInt(args[++i], 10) || 5;
      } else if (args[i] === '--callback') {
        callbackUrl = args[++i];
      }
    }

    let tasks;
    if (Array.isArray(tasksData)) {
      tasks = tasksData.map(t => typeof t === 'string' ? { task: t } : t);
    } else if (tasksData.tasks) {
      tasks = tasksData.tasks;
      strategy = tasksData.strategy || strategy;
      maxConcurrency = tasksData.maxConcurrency || maxConcurrency;
      callbackUrl = tasksData.onComplete || callbackUrl;
    } else {
      console.error(color('red', 'Error: Invalid batch file format'));
      process.exit(1);
    }

    console.log(color('cyan', `Submitting ${tasks.length} tasks...`));
    console.log(color('dim', `Strategy: ${strategy}, Concurrency: ${maxConcurrency}`));

    try {
      const result = await apiRequest('POST', '/api/tasks/batch', {
        tasks,
        strategy,
        maxConcurrency,
        onComplete: callbackUrl
      });

      if (result.status === 202) {
        console.log(color('green', `✓ Batch submitted successfully`));
        console.log(color('dim', `Batch ID: ${result.data.batchId}`));
        console.log(color('dim', `Status: ${result.data.status}`));

        let completed = 0;
        let total = tasks.length;

        while (true) {
          await new Promise(r => setTimeout(r, 1000));
          const status = await apiRequest('GET', `/api/tasks/batch/${result.data.batchId}`);
          completed = status.data.completedCount + status.data.failedCount;
          showProgress(completed, total, 'Progress');

          if (status.data.status === 'completed' || status.data.status === 'cancelled') {
            console.log(color('green', `\n✓ Batch ${status.data.status}`));
            console.log(color('dim', `Completed: ${status.data.completedCount}, Failed: ${status.data.failedCount}`));
            break;
          }
        }
      } else {
        console.error(color('red', `Error: ${result.data.error || 'Submission failed'}`));
        process.exit(1);
      }
    } catch (err) {
      console.error(color('red', `Request failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  if (action === 'status') {
    const batchId = args[1];
    if (!batchId) {
      console.error(color('red', 'Error: Batch ID required'));
      console.error(color('gray', 'Usage: traecn batch status <batchId>'));
      process.exit(1);
    }

    try {
      const result = await apiRequest('GET', `/api/tasks/batch/${batchId}`);

      if (result.status === 404) {
        console.error(color('red', `Error: Batch ${batchId} not found`));
        process.exit(1);
      }

      const batch = result.data;
      console.log(`\n${color('bold', `═══ Batch ${batch.batchId} ═══`)}\n`);
      console.log(`  ${color('cyan', 'Status:')}     ${batch.status === 'completed' ? color('green', '● Completed') : batch.status === 'cancelled' ? color('red', '● Cancelled') : color('yellow', '● ' + batch.status)}`);
      console.log(`  ${color('cyan', 'Strategy:')}   ${batch.strategy}`);
      console.log(`  ${color('cyan', 'Total:')}      ${batch.totalCount}`);
      console.log(`  ${color('green', 'Completed:')} ${batch.completedCount}`);
      console.log(`  ${color('red', 'Failed:')}      ${batch.failedCount}`);
      console.log(`  ${color('yellow', 'Pending:')} ${batch.pendingCount || 0}`);
      console.log(`  ${color('cyan', 'Running:')}    ${batch.executingCount || 0}`);

      console.log(`\n${color('bold', 'Tasks:')}`);
      batch.tasks.forEach((task, i) => {
        const statusIcon = task.status === 'done' ? color('green', '✓') : task.status === 'error' ? color('red', '✗') : task.status === 'executing' ? color('yellow', '▶') : color('dim', '○');
        const priorityLabel = task.priority ? color('dim', `[P${task.priority}]`) : '';
        console.log(`  ${statusIcon} ${priorityLabel} ${task.taskId}`);
        if (task.result && task.result.text) {
          console.log(color('dim', `    → ${task.result.text.substring(0, 100)}...`));
        }
        if (task.error) {
          console.log(color('red', `    → Error: ${task.error}`));
        }
      });
      console.log('');
    } catch (err) {
      console.error(color('red', `Request failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  if (action === 'cancel') {
    const batchId = args[1];
    if (!batchId) {
      console.error(color('red', 'Error: Batch ID required'));
      console.error(color('gray', 'Usage: traecn batch cancel <batchId>'));
      process.exit(1);
    }

    try {
      const result = await apiRequest('DELETE', `/api/tasks/batch/${batchId}`);

      if (result.status === 404) {
        console.error(color('red', `Error: Batch ${batchId} not found`));
        process.exit(1);
      }

      if (result.status === 400) {
        console.error(color('yellow', `Warning: ${result.data.error}`));
        process.exit(1);
      }

      console.log(color('green', `✓ Batch ${batchId} cancelled`));
    } catch (err) {
      console.error(color('red', `Request failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  console.error(color('red', `Error: Unknown batch command "${action}"`));
  console.error(color('gray', 'Usage: traecn batch [submit|status|cancel]'));
  process.exit(1);
}

async function cmdLogs(args) {
  const lines = parseInt(args[0], 10) || 50;

  try {
    const result = await apiRequest('GET', '/api/queue/status');

    console.log(`\n${color('bold', `═══ Recent Activity (${lines} entries) ═══`)}\n`);

    if (result.data.tasks && result.data.tasks.length > 0) {
      result.data.tasks.slice(-lines).forEach(task => {
        const time = new Date(task.createdAt).toLocaleTimeString();
        const statusColor = task.status === 'done' ? 'green' : task.status === 'error' ? 'red' : task.status === 'executing' ? 'yellow' : 'dim';
        console.log(`  ${color('dim', time)} ${color(statusColor, task.status.padEnd(12))} ${task.taskId}`);
        if (task.result && task.result.text) {
          console.log(color('dim', `    → ${task.result.text.substring(0, 100)}`));
        }
        if (task.error) {
          console.log(color('red', `    → ${task.error}`));
        }
      });
    } else {
      console.log(color('dim', '  No recent activity'));
    }
    console.log('');
  } catch (err) {
    console.error(color('red', `Error: ${err.message}`));
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    return;
  }

  const command = args[0];

  try {
    switch (command) {
      case 'delegate':
        await cmdDelegate(args.slice(1));
        break;
      case 'status':
        await cmdStatus();
        break;
      case 'capabilities':
        await cmdCapabilities(args.slice(1));
        break;
      case 'preflight':
        await cmdPreflight(args.slice(1));
        break;
      case 'plan':
        await cmdPlan(args.slice(1));
        break;
      case 'models':
        await cmdModels();
        break;
      case 'config':
        await cmdConfig(args.slice(1));
        break;
      case 'batch':
        await cmdBatch(args.slice(1));
        break;
      case 'logs':
        await cmdLogs(args.slice(1));
        break;
      default:
        console.error(color('red', `Error: Unknown command "${command}"`));
        console.error(color('gray', 'Run "traecn help" for usage'));
        process.exit(1);
    }
  } catch (err) {
    console.error(color('red', `Fatal error: ${err.message}`));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { apiRequest, loadConfig, saveConfig, COLORS };
