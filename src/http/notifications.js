'use strict';

const { getEnvWithFallback } = require('../shared/utils');

async function notifyOpenClaw(chatId, message) {
  try {
    const openclawUrl = getEnvWithFallback('TRAECN_OPENCLAW_URL', 'TRAE_OPENCLAW_URL', 'http://127.0.0.1:18789/api/message/send');
    const body = JSON.stringify({ chatId, text: message });
    const res = await fetch(openclawUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) await res.text();
  } catch (e) {
    console.error('[OpenClaw] notify failed:', e.message);
  }
}

function formatResult(result) {
  if (!result) return '✅ Trae 完成（无详情）';
  if (result.needsConfirmation || result.needsApproval) {
    return `🤖 Trae 需要确认:\n${result.question}\n\n输入你的决定继续。`;
  }
  if (result.error) {
    return `❌ Trae 出错: ${result.error}`;
  }
  const msg = result.text || result.message || '';
  return `✅ Trae 完成: ${msg.substring(0, 200)}`;
}

module.exports = { notifyOpenClaw, formatResult };
