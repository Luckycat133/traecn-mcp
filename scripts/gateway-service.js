'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getQuickstartConfig } = require('../src/config/quickstart');
const { runtimeDefault } = require('../src/config/runtime-schema');

const LABEL = 'com.traecnclaw.gateway';
const REPO_ROOT = path.resolve(__dirname, '..');
const NODE_PATH = process.execPath;
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'server.js');
const HOME_DIR = os.homedir();
const AGENT_DIR = path.join(HOME_DIR, 'Library', 'LaunchAgents');
const LOG_DIR = path.join(HOME_DIR, 'Library', 'Logs', 'TRAECNclaw');
const PLIST_PATH = path.join(AGENT_DIR, `${LABEL}.plist`);
const STDOUT_PATH = path.join(LOG_DIR, 'gateway.stdout.log');
const STDERR_PATH = path.join(LOG_DIR, 'gateway.stderr.log');
const UID = String(process.getuid());
const DOMAIN_TARGET = `gui/${UID}`;
const LABEL_TARGET = `${DOMAIN_TARGET}/${LABEL}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    ...options
  });

  return {
    command,
    args,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readExistingLaunchdEnv() {
  if (!fs.existsSync(PLIST_PATH)) return {};
  const content = fs.readFileSync(PLIST_PATH, 'utf8');
  const env = {};
  for (const key of [
    'TRAECN_ENABLE_MOCK_BRIDGE',
    'TRAECN_REMOTE_DEBUGGING_PORT',
    'TRAECN_QUICKSTART_PROFILE_MODE',
    'TRAECN_QUICKSTART_USE_ISOLATED_PROFILE',
    'TRAECN_TRAE_RECOVERY_NEW_INSTANCE',
    'TRAECN_AUTO_START_TRAE',
    'TRAECN_AUTO_RECOVER',
    'TRAECN_AUTO_CHECK_IN',
    'HOST',
    'PORT'
  ]) {
    const pattern = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`);
    const match = content.match(pattern);
    if (match && match[1]) {
      env[key] = match[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, '\'')
        .replace(/&amp;/g, '&');
    }
  }
  return env;
}

function buildEnvironmentVariables() {
  const quickstart = getQuickstartConfig();
  const existingEnv = readExistingLaunchdEnv();
  // IMPORTANT: TRAECN_AUTO_START_TRAE and TRAECN_AUTO_RECOVER default to '0'.
  // When '1', the gateway will relaunch Trae CN whenever its CDP target
  // disappears (e.g. user manually quits Trae). That auto-restart is the
  // reason Trae CN "comes back on its own" after being closed. Keep these
  // off by default; operators who want unattended recovery should set them
  // to '1' explicitly in the plist (or via `launchctl setenv`).
  const env = {
    TRAECN_ENABLE_MOCK_BRIDGE: process.env.TRAECN_ENABLE_MOCK_BRIDGE || existingEnv.TRAECN_ENABLE_MOCK_BRIDGE || '0',
    TRAECN_REMOTE_DEBUGGING_PORT: process.env.TRAECN_REMOTE_DEBUGGING_PORT || existingEnv.TRAECN_REMOTE_DEBUGGING_PORT || quickstart.remoteDebuggingPort || runtimeDefault('TRAECN_REMOTE_DEBUGGING_PORT'),
    TRAECN_RESPONSE_TIMEOUT_MS: process.env.TRAECN_RESPONSE_TIMEOUT_MS || existingEnv.TRAECN_RESPONSE_TIMEOUT_MS || runtimeDefault('TRAECN_RESPONSE_TIMEOUT_MS'),
    TRAECN_QUICKSTART_PROFILE_MODE: process.env.TRAECN_QUICKSTART_PROFILE_MODE || existingEnv.TRAECN_QUICKSTART_PROFILE_MODE || quickstart.profileMode || 'existing',
    TRAECN_QUICKSTART_USE_ISOLATED_PROFILE: process.env.TRAECN_QUICKSTART_USE_ISOLATED_PROFILE || existingEnv.TRAECN_QUICKSTART_USE_ISOLATED_PROFILE || (quickstart.useIsolatedProfile ? '1' : '0'),
    TRAECN_TRAE_RECOVERY_NEW_INSTANCE: process.env.TRAECN_TRAE_RECOVERY_NEW_INSTANCE || existingEnv.TRAECN_TRAE_RECOVERY_NEW_INSTANCE || '0',
    TRAECN_AUTO_START_TRAE: process.env.TRAECN_AUTO_START_TRAE || existingEnv.TRAECN_AUTO_START_TRAE || runtimeDefault('TRAECN_AUTO_START_TRAE'),
    TRAECN_AUTO_RECOVER: process.env.TRAECN_AUTO_RECOVER || existingEnv.TRAECN_AUTO_RECOVER || '0',
    TRAECN_AUTO_CHECK_IN: process.env.TRAECN_AUTO_CHECK_IN || existingEnv.TRAECN_AUTO_CHECK_IN || runtimeDefault('TRAECN_AUTO_CHECK_IN')
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || value === '') continue;
    if (key === 'HOST' || key === 'PORT' || key.startsWith('TRAECN_') || key.startsWith('TRAE_')) {
      env[key] = value;
    }
  }
  return env;
}

function buildPlist() {
  const envVars = buildEnvironmentVariables();
  const envEntries = Object.entries(envVars).map(([key, value]) => [
    '    <key>', key, '</key>\n',
    '    <string>', escapeXml(value), '</string>\n'
  ].join('')).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(NODE_PATH)}</string>
    <string>${escapeXml(SERVER_PATH)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(REPO_ROOT)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(STDOUT_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(STDERR_PATH)}</string>
  <key>ProcessType</key>
  <string>Interactive</string>
${envEntries ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}  </dict>\n` : ''}</dict>
</plist>
`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function writePlist() {
  ensureDir(AGENT_DIR);
  ensureDir(LOG_DIR);
  fs.writeFileSync(PLIST_PATH, buildPlist(), 'utf8');
  const lint = run('/usr/bin/plutil', ['-lint', PLIST_PATH]);
  if (lint.status !== 0) {
    throw new Error(`launchd plist validation failed: ${lint.stderr || lint.stdout}`);
  }
}

function install() {
  writePlist();
  console.log(JSON.stringify({
    ok: true,
    action: 'install',
    label: LABEL,
    plistPath: PLIST_PATH,
    stdoutLog: STDOUT_PATH,
    stderrLog: STDERR_PATH
  }, null, 2));
}

function start() {
  writePlist();

  const bootout = run('/bin/launchctl', ['bootout', LABEL_TARGET]);
  const bootstrap = run('/bin/launchctl', ['bootstrap', DOMAIN_TARGET, PLIST_PATH]);
  if (bootstrap.status !== 0) {
    throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr || bootstrap.stdout}`);
  }

  const kickstart = run('/bin/launchctl', ['kickstart', '-k', LABEL_TARGET]);
  if (kickstart.status !== 0) {
    throw new Error(`launchctl kickstart failed: ${kickstart.stderr || kickstart.stdout}`);
  }

  console.log(JSON.stringify({
    ok: true,
    action: 'start',
    label: LABEL,
    plistPath: PLIST_PATH,
    bootout: summarizeRun(bootout),
    bootstrap: summarizeRun(bootstrap),
    kickstart: summarizeRun(kickstart),
    stdoutLog: STDOUT_PATH,
    stderrLog: STDERR_PATH
  }, null, 2));
}

function stop() {
  const result = run('/bin/launchctl', ['bootout', LABEL_TARGET]);
  if (result.status !== 0) {
    throw new Error(`launchctl bootout failed: ${result.stderr || result.stdout}`);
  }

  console.log(JSON.stringify({
    ok: true,
    action: 'stop',
    label: LABEL,
    bootout: summarizeRun(result)
  }, null, 2));
}

function uninstall() {
  const bootout = run('/bin/launchctl', ['bootout', LABEL_TARGET]);
  if (fs.existsSync(PLIST_PATH)) {
    fs.unlinkSync(PLIST_PATH);
  }

  console.log(JSON.stringify({
    ok: true,
    action: 'uninstall',
    label: LABEL,
    plistPath: PLIST_PATH,
    plistRemoved: !fs.existsSync(PLIST_PATH),
    bootout: summarizeRun(bootout)
  }, null, 2));
}

function status() {
  const printResult = run('/bin/launchctl', ['print', LABEL_TARGET]);
  const listener = run('/usr/sbin/lsof', ['-iTCP:8788', '-sTCP:LISTEN', '-n', '-P']);

  const payload = {
    ok: true,
    action: 'status',
    label: LABEL,
    plistPath: PLIST_PATH,
    plistExists: fs.existsSync(PLIST_PATH),
    loaded: printResult.status === 0,
    listeningOn8788: listener.status === 0,
    stdoutLog: STDOUT_PATH,
    stderrLog: STDERR_PATH,
    launchctl: summarizeRun(printResult),
    listener: summarizeRun(listener)
  };

  if (fs.existsSync(STDOUT_PATH)) {
    payload.stdoutTail = tailFile(STDOUT_PATH, 20);
  }
  if (fs.existsSync(STDERR_PATH)) {
    payload.stderrTail = tailFile(STDERR_PATH, 20);
  }

  console.log(JSON.stringify(payload, null, 2));
}

function summarizeRun(result) {
  return {
    status: result.status,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
    error: result.error ? result.error.message : null
  };
}

function trimOutput(text) {
  const value = String(text || '').trim();
  return value.length > 600 ? `${value.slice(0, 600)}...` : value;
}

function tailFile(filePath, lines) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').slice(-lines).join('\n').trim();
}

function printHelp() {
  console.log(`Usage: node scripts/gateway-service.js <install|start|stop|status|uninstall>

Commands:
  install     Write the launchd plist without starting the service
  start       Write the plist, bootstrap the LaunchAgent, and kickstart it
  stop        Stop the running LaunchAgent
  status      Print launchd/listener status and recent logs
  uninstall   Stop the LaunchAgent and remove its plist
`);
}

async function main() {
  const command = process.argv[2] || 'help';

  try {
    switch (command) {
      case 'install':
        install();
        break;
      case 'start':
        start();
        break;
      case 'stop':
        stop();
        break;
      case 'status':
        status();
        break;
      case 'uninstall':
        uninstall();
        break;
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      command,
      error: err.message
    }, null, 2));
    process.exit(1);
  }
}

main();
