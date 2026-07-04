'use strict';

/**
 * Shared utilities extracted from dom-driver.js.
 * Contains text-processing helpers and constants used across multiple handler classes.
 */

const { safeJsValue } = require('../shared/utils');

// ── Completion markers ──────────────────────────────────────────────────

function hasCompletionMarker(text) {
  if (!text) return false;
  const markers = [
    '任务完成',
    'Task completed',
    '已完成',
    '完成',
    'Done.',
    'All done',
    'finished',
    'finalized'
  ];
  return markers.some(m => text.includes(m));
}

// ── Final assistant result extraction ───────────────────────────────────

const FINAL_ASSISTANT_RESULT_MARKERS = [
  /TRAECNclaw\s+Code\s+Review\s*[—-]\s*Findings\s+First/i,
  /Code\s+Review\s*[—-]\s*Findings\s+First/i,
  /(^|\n)\s*Findings\s*\(ordered\s+by\s+severity\)/i,
  /(^|\n)\s*1\.\s+Findings\b/i,
  /(^|\n)\s*Findings\s*[:：]/i,
  /(?:Thought\s*)?Bug\s+found\s*(?:\(|[:：]|\b)/i,
  /\bLikely\s+bug\s*[:：]/i
];

function findLastMarkerIndex(value, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  let lastIndex = -1;
  let match;
  while ((match = globalPattern.exec(value)) !== null) {
    lastIndex = match.index;
    if (match[0] && match[0].startsWith('\n')) {
      lastIndex += 1;
    }
    const bugFoundOffset = match[0] ? match[0].search(/Bug\s+found/i) : -1;
    if (bugFoundOffset > 0) {
      lastIndex += bugFoundOffset;
    }
    if (match[0] === '') {
      globalPattern.lastIndex += 1;
    }
  }
  return lastIndex;
}

function extractFinalAssistantResultText(text) {
  const value = String(text || '').trim();
  if (!value) return '';

  const lower = value.toLowerCase();
  const hasProcessTranscript = (
    value.length > 1000 ||
    value.includes('调用技能') ||
    value.includes('思考过程') ||
    value.includes('任务完成') ||
    lower.includes('thought') ||
    lower.includes('tool') ||
    lower.includes('review complete')
  );
  if (!hasProcessTranscript) return value;

  let markerIndex = -1;
  for (const marker of FINAL_ASSISTANT_RESULT_MARKERS) {
    const foundIndex = findLastMarkerIndex(value, marker);
    if (foundIndex < 0) continue;
    if (markerIndex < 0 || foundIndex > markerIndex + 80) {
      markerIndex = foundIndex;
    } else if (foundIndex >= markerIndex) {
      markerIndex = Math.min(markerIndex, foundIndex);
    }
  }

  if (markerIndex > 0) {
    return value.slice(markerIndex).trim();
  }
  return value;
}

function cleanAssistantResultText(text) {
  const value = extractFinalAssistantResultText(text);
  if (!value) return '';
  return value
    .replace(/^(Agent|Assistant)\s*(Thought|思考过程)\s*/i, '')
    .replace(/^(Agent|Assistant)\s+/i, '')
    .replace(/\s*(任务完成|Task completed)\s*$/i, '')
    .trim();
}

// ── Dialog button selector ──────────────────────────────────────────────

const DIALOG_BUTTON_SELECTOR = [
  'button',
  'a[role="button"]',
  '[role="button"].monaco-button',
  '.monaco-button',
  '.monaco-text-button',
  '[role="button"]'
].join(', ');

module.exports = {
  hasCompletionMarker,
  findLastMarkerIndex,
  extractFinalAssistantResultText,
  cleanAssistantResultText,
  FINAL_ASSISTANT_RESULT_MARKERS,
  DIALOG_BUTTON_SELECTOR,
  safeJsValue
};
