'use strict';

function renderChatUI() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TraeCN Bridge Chat</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101314;
      --panel: #171c1d;
      --panel-strong: #202829;
      --border: #324044;
      --text: #eef3ef;
      --muted: #9ca8a4;
      --accent: #7fd1a8;
      --accent-strong: #46b887;
      --warn: #f0bd68;
      --danger: #e57373;
      --user: #263832;
      --assistant: #18232a;
      --radius: 8px;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr) minmax(280px, 360px);
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    button, input, textarea { font: inherit; }

    .sidebar {
      min-height: 100vh;
      padding: 20px;
      border-right: 1px solid var(--border);
      background: var(--panel);
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .brand h1 { font-size: 18px; font-weight: 700; }
    .brand p { margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.5; }

    .status {
      padding: 12px;
      background: var(--panel-strong);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      display: grid;
      gap: 10px;
    }

    .status-line { display: flex; align-items: center; gap: 8px; font-size: 14px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--danger); flex: none; }
    .dot.connected { background: var(--accent); }
    .meta { display: grid; gap: 6px; color: var(--muted); font-size: 12px; line-height: 1.4; }
    .meta code { color: var(--accent); background: #101818; border: 1px solid #263735; padding: 1px 5px; border-radius: 4px; }

    .sidebar-actions {
      display: grid;
      gap: 8px;
    }

    .sidebar-actions a {
      min-height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
      font-weight: 700;
    }

    .sidebar-actions a:hover { border-color: var(--accent); color: var(--accent); }

    .main {
      min-width: 0;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
    }

    .header {
      min-height: 66px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      background: rgba(23, 28, 29, 0.96);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }

    .header-title { display: grid; gap: 2px; }
    .header-title h2 { font-size: 15px; font-weight: 700; }
    .header-title span { color: var(--muted); font-size: 12px; }

    .token-input { display: flex; gap: 8px; align-items: center; }
    .token-input input {
      width: min(260px, 34vw);
      min-width: 150px;
      background: #0f1516;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 13px;
      outline: none;
    }
    .token-input input:focus, .input-area textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(127, 209, 168, 0.16); }

    .button {
      min-height: 36px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: var(--accent);
      color: #07110d;
      padding: 8px 13px;
      cursor: pointer;
      font-weight: 700;
      white-space: nowrap;
    }
    .button:hover { background: var(--accent-strong); }
    .button:disabled { background: #3f4948; color: #9aa5a2; cursor: not-allowed; }
    .button.secondary { background: transparent; border-color: var(--border); color: var(--text); }
    .button.secondary:hover { border-color: var(--accent); color: var(--accent); }

    .messages {
      overflow-y: auto;
      padding: 22px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .empty-state {
      margin: auto;
      max-width: 520px;
      text-align: center;
      color: var(--muted);
      line-height: 1.6;
      font-size: 14px;
    }

    .message {
      width: min(760px, 86%);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 12px 14px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.55;
      font-size: 14px;
    }
    .message.user { align-self: flex-end; background: var(--user); }
    .message.assistant { align-self: flex-start; background: var(--assistant); }
    .message.error { border-color: rgba(229, 115, 115, 0.55); color: #ffd6d6; }
    .role { color: var(--muted); font-size: 11px; font-weight: 700; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.08em; }

    .input-area {
      padding: 14px 18px;
      border-top: 1px solid var(--border);
      background: var(--panel);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: end;
    }
    .input-area textarea {
      min-height: 44px;
      max-height: 160px;
      resize: none;
      background: #0f1516;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 11px 12px;
      border-radius: var(--radius);
      outline: none;
      line-height: 1.45;
    }

    .console-panel {
      min-height: 100vh;
      border-left: 1px solid var(--border);
      background: #121718;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      min-width: 0;
    }

    .console-header {
      min-height: 66px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .console-title {
      min-width: 0;
      display: grid;
      gap: 2px;
    }

    .console-title h2 { font-size: 15px; font-weight: 700; }
    .console-title span { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .console-scroll {
      min-height: 0;
      overflow-y: auto;
      padding: 14px;
      display: grid;
      align-content: start;
      gap: 12px;
    }

    .console-card {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--panel);
      padding: 12px;
      display: grid;
      gap: 10px;
    }

    .console-card h3 {
      font-size: 12px;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 0.08em;
    }

    .kv {
      display: grid;
      gap: 8px;
      font-size: 12px;
      line-height: 1.4;
    }

    .kv-row {
      display: grid;
      grid-template-columns: minmax(82px, 0.8fr) minmax(0, 1.2fr);
      gap: 8px;
      align-items: start;
    }

    .kv dt { color: var(--muted); }
    .kv dd { color: var(--text); overflow-wrap: anywhere; }
    .kv dd.ok { color: var(--accent); }
    .kv dd.warn { color: var(--warn); }
    .kv dd.error { color: var(--danger); }

    .toast {
      position: fixed;
      right: 16px;
      bottom: 82px;
      max-width: min(420px, calc(100vw - 32px));
      background: var(--panel-strong);
      color: var(--text);
      border: 1px solid var(--border);
      border-left: 4px solid var(--accent);
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 13px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px);
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .toast.visible { opacity: 1; transform: translateY(0); }
    .toast.error { border-left-color: var(--danger); }

    @media (max-width: 760px) {
      body { grid-template-columns: 1fr; }
      .sidebar { min-height: auto; border-right: 0; border-bottom: 1px solid var(--border); padding: 14px 16px; }
      .status { grid-template-columns: 1fr; }
      .main { min-height: calc(100vh - 164px); }
      .console-panel { min-height: auto; border-left: 0; border-top: 1px solid var(--border); }
      .console-scroll { max-height: 60vh; }
      .header { flex-direction: column; align-items: stretch; }
      .token-input input { width: 100%; min-width: 0; }
      .messages { padding: 16px; }
      .message { width: 100%; }
      .input-area { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="brand">
      <h1>TraeCN Bridge</h1>
      <p>Local CDP gateway for TraeCN desktop automation.</p>
    </div>
    <section class="status" aria-label="Gateway status">
      <div class="status-line">
        <span class="dot" id="statusDot" aria-hidden="true"></span>
        <strong id="statusText">Disconnected</strong>
      </div>
      <div class="meta">
        <span>Gateway <code id="gatewayText">localhost:8788</code></span>
        <span>Mode <code id="modeText">--</code></span>
        <span>Uptime <code id="uptimeText">--</code></span>
      </div>
    </section>
    <nav class="sidebar-actions" aria-label="Bridge links">
      <a href="/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a>
    </nav>
  </aside>
  <main class="main">
    <header class="header">
      <div class="header-title">
        <h2>Bridge Chat</h2>
        <span>Send a task to TraeCN and read the returned response.</span>
      </div>
      <div class="token-input">
        <input type="password" id="tokenInput" autocomplete="off" placeholder="Gateway token">
        <button class="button secondary" id="saveTokenBtn" type="button">Save</button>
      </div>
    </header>
    <section class="messages" id="messages" aria-live="polite">
      <p class="empty-state" id="emptyState">No messages yet. Start with a concrete IDE task or a short question for TraeCN.</p>
    </section>
    <form class="input-area" id="messageForm">
      <textarea id="messageInput" placeholder="Type a message to send to TraeCN..." rows="1"></textarea>
      <button class="button" id="sendBtn" type="submit">Send</button>
    </form>
  </main>
  <aside class="console-panel" aria-label="Dev console">
    <header class="console-header">
      <div class="console-title">
        <h2>Dev Console</h2>
        <span id="consoleUpdated">Waiting for refresh</span>
      </div>
      <button class="button secondary" id="refreshConsoleBtn" type="button">Refresh</button>
    </header>
    <div class="console-scroll">
      <section class="console-card">
        <h3>Gateway</h3>
        <dl class="kv" id="consoleGateway"></dl>
      </section>
      <section class="console-card">
        <h3>Runtime</h3>
        <dl class="kv" id="consoleRuntime"></dl>
      </section>
      <section class="console-card">
        <h3>Activity</h3>
        <dl class="kv" id="consoleActivity"></dl>
      </section>
      <section class="console-card">
        <h3>Contract</h3>
        <dl class="kv" id="consoleContract"></dl>
      </section>
    </div>
  </aside>
  <div class="toast" id="toast" role="status"></div>
  <script>
    const API_BASE = window.location.origin;
    const TOKEN_KEY = 'traecn_bridge_token';
    let token = localStorage.getItem(TOKEN_KEY) || '';

    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const modeText = document.getElementById('modeText');
    const uptimeText = document.getElementById('uptimeText');
    const gatewayText = document.getElementById('gatewayText');
    const tokenInput = document.getElementById('tokenInput');
    const messages = document.getElementById('messages');
    const emptyState = document.getElementById('emptyState');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const toast = document.getElementById('toast');
    const refreshConsoleBtn = document.getElementById('refreshConsoleBtn');
    const consoleUpdated = document.getElementById('consoleUpdated');
    const consoleGateway = document.getElementById('consoleGateway');
    const consoleRuntime = document.getElementById('consoleRuntime');
    const consoleActivity = document.getElementById('consoleActivity');
    const consoleContract = document.getElementById('consoleContract');

    tokenInput.value = token;
    gatewayText.textContent = window.location.host;

    document.getElementById('saveTokenBtn').addEventListener('click', saveToken);
    refreshConsoleBtn.addEventListener('click', refreshConsole);
    document.getElementById('messageForm').addEventListener('submit', event => {
      event.preventDefault();
      sendMessage();
    });
    messageInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    messageInput.addEventListener('input', resizeInput);

    function saveToken() {
      token = tokenInput.value.trim();
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
      } else {
        localStorage.removeItem(TOKEN_KEY);
      }
      showToast('Token saved');
      refreshConsole();
    }

    function getHeaders() {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      return headers;
    }

    async function requestJson(path, options = {}) {
      const response = await fetch(API_BASE + path, {
        ...options,
        headers: { ...getHeaders(), ...(options.headers || {}) }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data.error || response.statusText || 'Request failed';
        throw new Error(message + ' (' + response.status + ')');
      }
      return data;
    }

    async function checkStatus() {
      try {
        const data = await requestJson('/api/status', { method: 'GET' });
        const connected = data.status === 'connected';
        statusDot.className = connected ? 'dot connected' : 'dot';
        statusText.textContent = connected ? 'Connected' : 'Disconnected';
        modeText.textContent = data.mockBridge ? 'Mock' : 'Live';
        uptimeText.textContent = formatUptime(data.uptime || 0);
      } catch (err) {
        statusDot.className = 'dot';
        statusText.textContent = 'Error';
        modeText.textContent = '--';
        uptimeText.textContent = '--';
      }
    }

    async function refreshConsole() {
      refreshConsoleBtn.disabled = true;
      refreshConsoleBtn.textContent = 'Refreshing';

      const [
        statusResult,
        configResult,
        openApiResult,
        modeResult,
        readinessResult,
        queueResult,
        dialogResult,
        historyResult
      ] = await Promise.all([
        settle(() => requestJson('/api/status', { method: 'GET' })),
        settle(() => requestJson('/api/config/diff', { method: 'GET' })),
        settle(() => requestJson('/openapi.json', { method: 'GET' })),
        settle(() => requestJson('/api/detect-mode', { method: 'GET' })),
        settle(() => requestJson('/api/readiness', { method: 'GET' })),
        settle(() => requestJson('/api/queue/status', { method: 'GET' })),
        settle(() => requestJson('/api/dialog/status', { method: 'GET' })),
        settle(() => requestJson('/api/tasks/history?limit=5', { method: 'GET' }))
      ]);

      const status = statusResult.value || {};
      const config = configResult.value || {};
      const openapi = openApiResult.value || {};
      const mode = modeResult.value || {};
      const readiness = readinessResult.value || {};
      const queue = queueResult.value || {};
      const dialog = dialogResult.value || {};
      const history = historyResult.value || {};

      renderKeyValues(consoleGateway, [
        ['Status', status.status || statusResult.error, status.status === 'connected' ? 'ok' : statusResult.ok ? 'warn' : 'error'],
        ['Bridge', status.mockBridge ? 'Mock' : 'Live', statusResult.ok ? 'ok' : 'warn'],
        ['CDP', status.cdp ? status.cdp.browser : 'Not connected', status.cdp ? 'ok' : 'warn'],
        ['Version', status.version || '--'],
        ['Uptime', status.uptime ? formatUptime(status.uptime) : '--']
      ]);

      renderKeyValues(consoleRuntime, [
        ['Mode', mode.mode || modeResult.error, modeResult.ok ? 'ok' : 'warn'],
        ['Confidence', mode.confidence == null ? '--' : String(mode.confidence)],
        ['Ready', readiness.ready == null ? readinessResult.error : String(readiness.ready), readiness.ready ? 'ok' : readinessResult.ok ? 'warn' : 'error'],
        ['Dialog', dialog.hasDialog == null ? dialogResult.error : (dialog.hasDialog ? dialog.dialogType || 'Present' : 'Clear'), dialog.hasDialog ? 'warn' : dialogResult.ok ? 'ok' : 'warn'],
        ['Queue', queue.queued ? 'Queued' : queue.running ? 'Running' : queueResult.ok ? 'Idle' : queueResult.error, queue.queued || queue.running ? 'warn' : queueResult.ok ? 'ok' : 'warn']
      ]);

      const historyItems = history.tasks || history.items || history.records || [];
      renderKeyValues(consoleActivity, [
        ['Tasks', Array.isArray(historyItems) ? String(historyItems.length) : historyResult.error, historyResult.ok ? 'ok' : 'warn'],
        ['Sessions', history.sessionCount == null ? '--' : String(history.sessionCount)],
        ['Composer', readiness.composer?.matchedSelector || '--', readiness.composer ? 'ok' : 'warn'],
        ['Send Button', readiness.sendButton?.matchedSelector || '--', readiness.sendButton ? 'ok' : 'warn'],
        ['Response', readiness.responseRegion?.matchedSelector || '--', readiness.responseRegion ? 'ok' : 'warn']
      ]);

      renderKeyValues(consoleContract, [
        ['OpenAPI', openapi.openapi || openApiResult.error, openApiResult.ok ? 'ok' : 'error'],
        ['API Version', openapi.info?.version || '--'],
        ['Paths', openapi.paths ? String(Object.keys(openapi.paths).length) : '--'],
        ['Config Diff', config.diff ? String(Object.keys(config.diff).length) : configResult.error, configResult.ok ? 'ok' : 'warn']
      ]);

      consoleUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString();
      refreshConsoleBtn.disabled = false;
      refreshConsoleBtn.textContent = 'Refresh';
    }

    async function settle(fn) {
      try {
        return { ok: true, value: await fn() };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    function renderKeyValues(container, entries) {
      container.replaceChildren();
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'kv-row';
        const term = document.createElement('dt');
        const detail = document.createElement('dd');
        term.textContent = entry[0];
        detail.textContent = entry[1] == null || entry[1] === '' ? '--' : String(entry[1]);
        if (entry[2]) detail.className = entry[2];
        row.append(term, detail);
        container.appendChild(row);
      }
    }

    async function sendMessage() {
      const text = messageInput.value.trim();
      if (!text || sendBtn.disabled) return;

      addMessage('user', text);
      messageInput.value = '';
      resizeInput();
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending';

      try {
        const session = await requestJson('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({})
        });
        const result = await requestJson('/api/sessions/' + encodeURIComponent(session.sessionId) + '/delegate', {
          method: 'POST',
          body: JSON.stringify({ task: text })
        });
        addMessage('assistant', result.text || result.error || 'No response');
      } catch (err) {
        addMessage('assistant', 'Error: ' + err.message, true);
        showToast(err.message, true);
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        messageInput.focus();
      }
    }

    function addMessage(role, content, isError = false) {
      emptyState.hidden = true;
      const wrapper = document.createElement('article');
      wrapper.className = 'message ' + role + (isError ? ' error' : '');

      const roleLabel = document.createElement('div');
      roleLabel.className = 'role';
      roleLabel.textContent = role === 'user' ? 'You' : 'TraeCN';

      const body = document.createElement('div');
      body.textContent = content;

      wrapper.append(roleLabel, body);
      messages.appendChild(wrapper);
      messages.scrollTop = messages.scrollHeight;
    }

    function resizeInput() {
      messageInput.style.height = 'auto';
      messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + 'px';
    }

    function formatUptime(seconds) {
      const total = Math.max(0, Math.floor(seconds));
      const minutes = Math.floor(total / 60);
      const remainingSeconds = total % 60;
      if (minutes < 60) return minutes + 'm ' + remainingSeconds + 's';
      const hours = Math.floor(minutes / 60);
      return hours + 'h ' + (minutes % 60) + 'm';
    }

    function showToast(message, isError = false) {
      toast.textContent = message;
      toast.className = 'toast visible' + (isError ? ' error' : '');
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(() => {
        toast.className = 'toast' + (isError ? ' error' : '');
      }, 2400);
    }

    resizeInput();
    checkStatus();
    refreshConsole();
    setInterval(checkStatus, 10000);
    setInterval(refreshConsole, 30000);
  </script>
</body>
</html>`;
}

module.exports = { renderChatUI };
