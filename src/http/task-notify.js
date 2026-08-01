'use strict';

/**
 * Task completion notifiers — the outbound notification channel for
 * finished async tasks: OpenClaw/Telegram push + task webhook delivery
 * + result message formatting.
 *
 * Extracted verbatim from gateway.js so that both gateway.js and
 * handlers/delegate.js can share a single implementation. Behavior is
 * `notifyOpenClaw` accepts an optional `logPrefix` so callers can keep
 * subsystem-specific error-log text.
 */

const { TraeCNAutomationError } = require('../cdp/errors');
const { getEnvWithFallback } = require('../shared/utils');

// Notify OpenClaw (Telegram gateway) when async task completes
async function notifyOpenClaw(chatId, message, logPrefix = '[OpenClaw] notify failed:') {
  try {
    const openclawUrl = getEnvWithFallback('TRAECN_OPENCLAW_URL', 'TRAE_OPENCLAW_URL', 'http://127.0.0.1:18789/api/message/send');
    const body = JSON.stringify({ chatId, text: message });
    const res = await fetch(openclawUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000)
    });
    // Consume response body to free the connection
    if (res.ok) await res.text();
  } catch (e) {
    console.error(logPrefix, e.message);
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

function formatReviewRequiredMessage(taskId, result, remainingFollowups = 0) {
  const preview = String(result?.text || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  const suffix = remainingFollowups > 0 ? `\n后续待续任务: ${remainingFollowups}` : '';
  return `📝 Trae 已完成并等待审查:\nTask ID: ${taskId}\n预览: ${preview || '（无文本预览）'}${suffix}\n\n审查通过后再继续后续排队任务。`;
}

async function sendTaskWebhook(url, payload) {
  if (!url) return;
  const body = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...payload
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'TraeCNclaw-TaskWebhook/1.0'
    },
    body,
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) {
    throw TraeCNAutomationError.webhookFailed(url, response.status, response.statusText);
  }
  await response.text().catch(() => {});
}

module.exports = {
  notifyOpenClaw,
  formatResult,
  formatReviewRequiredMessage,
  sendTaskWebhook
};
