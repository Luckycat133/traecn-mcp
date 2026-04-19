'use strict';

function renderChatUI() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TraeCN Bridge Chat</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; }
    .sidebar { width: 260px; background: #16213e; padding: 20px; border-right: 1px solid #2a2a4a; display: flex; flex-direction: column; }
    .sidebar h2 { color: #7c8aff; margin-bottom: 15px; font-size: 18px; }
    .sidebar .status { padding: 10px; background: #1a1a2e; border-radius: 8px; margin-bottom: 15px; font-size: 13px; }
    .sidebar .status .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .sidebar .status .dot.connected { background: #4caf50; }
    .sidebar .status .dot.disconnected { background: #f44336; }
    .sidebar .info { font-size: 12px; color: #888; line-height: 1.8; }
    .sidebar .info code { background: #1a1a2e; padding: 2px 6px; border-radius: 3px; color: #7c8aff; }
    .main { flex: 1; display: flex; flex-direction: column; }
    .header { padding: 15px 20px; background: #16213e; border-bottom: 1px solid #2a2a4a; display: flex; align-items: center; justify-content: space-between; }
    .header h1 { font-size: 16px; color: #7c8aff; }
    .header .token-input { display: flex; gap: 8px; }
    .header .token-input input { background: #1a1a2e; border: 1px solid #2a2a4a; color: #e0e0e0; padding: 6px 10px; border-radius: 4px; font-size: 12px; width: 200px; }
    .header .token-input button { background: #7c8aff; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .messages { flex: 1; overflow-y: auto; padding: 20px; }
    .message { margin-bottom: 15px; padding: 12px 16px; border-radius: 8px; max-width: 80%; white-space: pre-wrap; word-break: break-word; }
    .message.user { background: #2a2a4a; margin-left: auto; }
    .message.assistant { background: #1e2a4a; border: 1px solid #2a2a4a; }
    .message .role { font-size: 11px; color: #888; margin-bottom: 4px; }
    .input-area { padding: 15px 20px; background: #16213e; border-top: 1px solid #2a2a4a; display: flex; gap: 10px; }
    .input-area textarea { flex: 1; background: #1a1a2e; border: 1px solid #2a2a4a; color: #e0e0e0; padding: 10px; border-radius: 8px; resize: none; font-size: 14px; font-family: inherit; min-height: 44px; max-height: 120px; }
    .input-area button { background: #7c8aff; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; }
    .input-area button:disabled { background: #444; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="sidebar">
    <h2>TraeCN Bridge</h2>
    <div class="status">
      <span class="dot disconnected" id="statusDot"></span>
      <span id="statusText">Disconnected</span>
    </div>
    <div class="info">
      <p>Gateway: <code>localhost:8788</code></p>
      <p>CDP Port: <code>9222</code></p>
      <p>Mode: <span id="modeText">--</span></p>
    </div>
  </div>
  <div class="main">
    <div class="header">
      <h1>TraeCN Bridge Chat</h1>
      <div class="token-input">
        <input type="password" id="tokenInput" placeholder="Gateway Token (optional)">
        <button onclick="saveToken()">Save</button>
      </div>
    </div>
    <div class="messages" id="messages"></div>
    <div class="input-area">
      <textarea id="messageInput" placeholder="Type a message to send to TraeCN..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage();}"></textarea>
      <button id="sendBtn" onclick="sendMessage()">Send</button>
    </div>
  </div>
  <script>
    const API_BASE = window.location.origin;
    let token = localStorage.getItem('traecn_bridge_token') || '';

    function saveToken() {
      token = document.getElementById('tokenInput').value;
      localStorage.setItem('traecn_bridge_token', token);
    }

    function getHeaders() {
      const h = { 'Content-Type': 'application/json' };
      if (token) h['Authorization'] = 'Bearer ' + token;
      return h;
    }

    async function checkStatus() {
      try {
        const res = await fetch(API_BASE + '/api/status');
        const data = await res.json();
        const dot = document.getElementById('statusDot');
        const text = document.getElementById('statusText');
        if (data.status === 'connected') {
          dot.className = 'dot connected';
          text.textContent = 'Connected';
        } else {
          dot.className = 'dot disconnected';
          text.textContent = 'Disconnected';
        }
        document.getElementById('modeText').textContent = data.mockBridge ? 'Mock' : 'Live';
      } catch {
        document.getElementById('statusDot').className = 'dot disconnected';
        document.getElementById('statusText').textContent = 'Error';
      }
    }

    async function sendMessage() {
      const input = document.getElementById('messageInput');
      const text = input.value.trim();
      if (!text) return;

      addMessage('user', text);
      input.value = '';

      const btn = document.getElementById('sendBtn');
      btn.disabled = true;

      try {
        const sessionRes = await fetch(API_BASE + '/api/sessions', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({})
        });
        const session = await sessionRes.json();

        const delegateRes = await fetch(API_BASE + '/api/sessions/' + session.sessionId + '/delegate', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ task: text })
        });
        const result = await delegateRes.json();
        addMessage('assistant', result.text || result.error || 'No response');
      } catch (err) {
        addMessage('assistant', 'Error: ' + err.message);
      }

      btn.disabled = false;
    }

    function addMessage(role, content) {
      const div = document.createElement('div');
      div.className = 'message ' + role;
      div.innerHTML = '<div class="role">' + (role === 'user' ? 'You' : 'TraeCN') + '</div>' + escapeHtml(content);
      document.getElementById('messages').appendChild(div);
      document.getElementById('messages').scrollTop = 999999;
    }

    function escapeHtml(text) {
      const d = document.createElement('div');
      d.textContent = text;
      return d.innerHTML;
    }

    checkStatus();
    setInterval(checkStatus, 10000);
  </script>
</body>
</html>`;
}

module.exports = { renderChatUI };
