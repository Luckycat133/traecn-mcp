'use strict';

/**
 * Queue probe text classification logic.
 *
 * Identifies the textual features of probe tasks such as "wait for queue /
 * check queue status", used at the gateway layer to intercept or recognize
 * non-real business tasks. This module's responsibilities are independent of
 * the generic helpers in src/shared/utils.js (sleep / sanitizeLog /
 * getEnvWithFallback, etc.); it is re-exported by utils.js to keep the public
 * interface unchanged.
 */

function normalizeQueueProbeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[，。！？、,.!?;:：]/g, ' ')
    .replace(/\b(?:rename|export|copy\s+session|delete\s+task)\b/g, ' ')
    .replace(/重命名|导出|复制会话|删除任务/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isQueueProbeStatusSuffix(value) {
  const suffix = String(value || '').trim();
  if (!suffix) return true;
  const withoutTime = suffix
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}\s+\d{2}\b/g, ' ')
    .replace(/\d{1,2}月\d{1,2}日/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutTime) return true;
  return /^(?:queued|queueing|queuing|running|waiting|processing|thinking|done|ready|进行中|思考中|生成中|排队中|等待中|任务中断|已中断|已完成|完成|请稍等)(?:\s+(?:queued|queueing|queuing|running|waiting|processing|thinking|done|ready|进行中|思考中|生成中|排队中|等待中|任务中断|已中断|已完成|完成|请稍等))*$/.test(withoutTime);
}

function isQueueProbeCommandText(value) {
  const normalized = normalizeQueueProbeText(value);
  if (!normalized) return false;
  const prefixMatch = normalized.match(/^(wait\s+for\s+(?:the\s+)?(?:trae\s+)?queue|wait\s+for\s+queue)\b(.*)$/);
  if (prefixMatch && isQueueProbeStatusSuffix(prefixMatch[2])) return true;
  if (/^check\s+(?:the\s+)?(?:trae\s+)?queue(?:\s+status)?$/.test(normalized)) return true;
  if (/^queue\s+status$/.test(normalized)) return true;
  if (/^排队$/.test(normalized)) return true;
  if (/^等(?:待)?排队$/.test(normalized)) return true;
  if (/^等待\s*(?:trae)?\s*队列$/.test(normalized)) return true;
  if (/^现在\s*(?:已经)?\s*排(?:到|到了|上了)$/.test(normalized)) return true;
  if (/^排队中(?:\s*请稍等)?$/.test(normalized)) return true;
  if (/^测试排队$/.test(normalized)) return true;
  if (/^换一个排队更久的模型测试排队$/.test(normalized)) return true;
  return false;
}

function extractQueueProbePayloads(taskText) {
  const text = String(taskText || '');
  const payloads = [];
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const payloadIndex = lines.findIndex(line => /^##\s+User Command Payload$/i.test(line));
  if (payloadIndex >= 0) {
    for (const line of lines.slice(payloadIndex + 1)) {
      if (/^raw params:/i.test(line)) continue;
      payloads.push(line);
      break;
    }
  }
  const rawTaskMatch = text.match(/"task"\s*:\s*"([^"]{1,240})"/i);
  if (rawTaskMatch) payloads.push(rawTaskMatch[1]);
  return payloads;
}

function isGenericQueueProbeTask(taskText) {
  if (isQueueProbeCommandText(taskText)) return true;
  return extractQueueProbePayloads(taskText).some(isQueueProbeCommandText);
}

function isForeignQueueProbeText(value) {
  const normalized = normalizeQueueProbeText(value);
  if (!normalized) return false;
  if (isQueueProbeCommandText(normalized)) return true;
  return /^wait\s+for\s+(?:the\s+)?(?:trae\s+)?queue\b/.test(normalized)
    || /^wait\s+for\s+queue\b/.test(normalized)
    || /^等待\s*(?:trae)?\s*队列\b/.test(normalized)
    || /^排队中\b/.test(normalized);
}

module.exports = {
  normalizeQueueProbeText,
  isQueueProbeStatusSuffix,
  isQueueProbeCommandText,
  extractQueueProbePayloads,
  isGenericQueueProbeTask,
  isForeignQueueProbeText
};
