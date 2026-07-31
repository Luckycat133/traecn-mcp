'use strict';

const path = require('path');
const { getEnvWithFallback, parseSelectors, parsePositiveInt } = require('../shared/utils');
const { runtimeDefault } = require('../config/runtime-schema');

function parseOptionalPositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePathList(value) {
  return String(value || '')
    .split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean);
}

const DEFAULT_COMPOSER_SELECTORS = [
  '.chat-input-v2-input-box-editable',
  'textarea',
  "[contenteditable='true']",
  "input[type='text']",
  "[class*='chat-input']",
  "[class*='input-box']"
];

const DEFAULT_SEND_BUTTON_SELECTORS = [
  'button.chat-input-v2-send-button',
  "button[data-testid*='send']",
  "button[aria-label*='Send']",
  "button[aria-label*='发送']",
  "button[type='submit']",
  "[class*='send-button']",
  "[class*='send']"
];

// SOLO Coder (Trae CN domestic) response region selectors.
// The original selectors (.assistant-*, .agent-plan-*) targeted international/Cursor-style UIs
// but Trae CN uses a task-oriented interface. We keep original selectors as low-priority fallbacks.
const DEFAULT_RESPONSE_SELECTORS = [
  // SOLO Coder chat turn (task-oriented UI)
  '.solo-chat-turn',
  '.solo-chat-turn-content',
  '[class*="solo-chat"]',
  '[class*="solo-agent"]',
  '[class*="solo-task"]',
  '[class*="solo-plan"]',
  // Generic chat turn patterns
  '.chat-turn-content',
  '[class*="chat-turn"]',
  '[class*="message-content"]',
  '[class*="chat-message"]',
  '[class*="content-markdown"]',
  // SOLO task result / output
  '.solo-task-card',
  '.solo-task-output',
  '.solo-task-result',
  '.solo-response-content',
  '[class*="task-card"]',
  '[class*="task-output"]',
  '[class*="task-result"]',
  // Agent plan items
  '.solo-plan-item',
  '.solo-plan-content',
  '[class*="agent-plan"]',
  '[class*="plan-item"]',
  // Markdown rendered content (common in chat UIs)
  '.markdown-body',
  '[class*="markdown"]',
  // Generic response/output selectors
  '[class*="output-content"]',
  '[class*="response-content"]',
  '[class*="response"]',
  // Original selectors (kept for backward compat, low priority)
  '.assistant-chat-turn-content',
  '.agent-plan-items.assistant-chat-turn-element',
  ".icd-open-folder-card-desc",
  "[data-message-author-role='assistant']",
  "[data-testid*='assistant']",
  "[data-role='assistant']",
  "[data-author='assistant']",
  '.assistant',
  "[class*='assistant-chat']"
];

const DEFAULT_ACTIVITY_SELECTORS = [
  // SOLO Coder activity/loading areas
  '.chat-content-container',
  '.chat-list-wrapper',
  '.solo-panel',
  '.solo-main-content',
  '.solo-chat-panel',
  '[class*="solo-panel"]',
  '[class*="solo-main"]',
  '[class*="solo-content"]',
  "[class*='activity']",
  "[class*='chat-content']",
  "[class*='chat-list']"
];

const DEFAULT_NEW_CHAT_SELECTORS = [
  'a.codicon-icube-NewChat',
  "a[data-testid*='new-chat']",
  "button[data-testid*='new-chat']",
  "[aria-label*='New Chat']",
  "[aria-label*='新建对话']",
  "[class*='NewChat']",
  "[class*='new-task-button']",
  "[class*='new-task']"
];

const DEFAULT_MODE_TAB_SELECTORS = [
  '.icube-mode-tab-item',
  "[class*='icube-mode-tab-item']",
  "[data-testid*='mode-tab']",
  "[class*='mode-tab']"
];

// ── IDE mode task panel selectors ──────────────────────────────────────────
// When Trae CN is in IDE mode there is no .soloaisidebar;
// tasks appear inside the chat/assistant panel instead.
const DEFAULT_IDE_TASK_PANEL_SELECTORS = [
  '.chat-panel',
  '.assistant-panel',
  '[class*="chat-panel"]',
  '[class*="assistant-panel"]',
  '[class*="assistant-content"]',
  '[class*="chat-list"]',
  '[class*="chat-content"]',
  '[class*="panel"][class*="chat"]',
  '[class*="panel"][class*="assistant"]'
];

const DEFAULT_IDE_RESPONSE_SELECTORS = [
  '.chat-message',
  '.agent-message',
  '.chat-turn',
  '.assistant-chat-turn',
  '.chat-turn-content',
  '[class*="chat-message"]',
  '[class*="agent-message"]',
  '[class*="message-content"]',
  '[class*="assistant-chat-turn"]',
  '[class*="chat-turn-content"]',
  '.markdown-body',
  '[class*="markdown"]'
];

const DEFAULT_IDE_NEW_CHAT_SELECTORS = [
  // Same SOLO selectors (may overlap in IDE mode too)
  'a.codicon-icube-NewChat',
  "a[data-testid*='new-chat']",
  "button[data-testid*='new-chat']",
  "[aria-label*='New Chat']",
  "[aria-label*='新建对话']",
  "[class*='NewChat']",
  "[class*='new-task-button']",
  "[class*='new-task']",
  // IDE specific
  "[class*='new-chat']",
  "[aria-label*='新对话']",
  "[class*='clear-context']"
];

// ── Mode detection indicators ──────────────────────────────────────────────
// Presence of one or more of these suggests IDE mode
const DEFAULT_IDE_INDICATOR_SELECTORS = [
  '.monaco-editor',
  '.monaco-workbench',
  '[class*="editor-group"]',
  '[class*="terminal"]',
  '[class*="editor-tabs"]',
  "[aria-label*='编辑器']",
  "[aria-label*='终端']"
];

// Presence of this suggests SOLO mode (sidebar visible)
const DEFAULT_SOLO_INDICATOR_SELECTORS = [
  '.soloaisidebar'
];

function getConfig() {
  const projectPath = getEnvWithFallback('TRAECN_PROJECT_PATH', 'TRAE_PROJECT_PATH', '');
  const configuredFileRoots = parsePathList(getEnvWithFallback('TRAECN_FILE_ALLOWED_ROOTS', 'TRAE_FILE_ALLOWED_ROOTS', ''));
  const fileAllowedRoots = configuredFileRoots.length > 0
    ? configuredFileRoots
    : [projectPath, process.cwd()].filter(Boolean);

  return {
    composerSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_COMPOSER_SELECTORS', 'TRAE_COMPOSER_SELECTORS'),
      DEFAULT_COMPOSER_SELECTORS
    ),
    sendButtonSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_SEND_BUTTON_SELECTORS', 'TRAE_SEND_BUTTON_SELECTORS'),
      DEFAULT_SEND_BUTTON_SELECTORS
    ),
    responseSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_RESPONSE_SELECTORS', 'TRAE_RESPONSE_SELECTORS'),
      DEFAULT_RESPONSE_SELECTORS
    ),
    activitySelectors: parseSelectors(
      getEnvWithFallback('TRAECN_ACTIVITY_SELECTORS', 'TRAE_ACTIVITY_SELECTORS'),
      DEFAULT_ACTIVITY_SELECTORS
    ),
    newChatSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_NEW_CHAT_SELECTORS', 'TRAE_NEW_CHAT_SELECTORS'),
      DEFAULT_NEW_CHAT_SELECTORS
    ),
    modeTabSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_MODE_TAB_SELECTORS', 'TRAE_MODE_TAB_SELECTORS'),
      DEFAULT_MODE_TAB_SELECTORS
    ),
    // ── Dual UI / IDE mode additions ────────────────────────────────────
    ideTaskPanelSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_IDE_TASK_PANEL_SELECTORS', 'TRAE_IDE_TASK_PANEL_SELECTORS'),
      DEFAULT_IDE_TASK_PANEL_SELECTORS
    ),
    ideResponseSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_IDE_RESPONSE_SELECTORS', 'TRAE_IDE_RESPONSE_SELECTORS'),
      DEFAULT_IDE_RESPONSE_SELECTORS
    ),
    ideNewChatSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_IDE_NEW_CHAT_SELECTORS', 'TRAE_IDE_NEW_CHAT_SELECTORS'),
      DEFAULT_IDE_NEW_CHAT_SELECTORS
    ),
    ideIndicatorSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_IDE_INDICATOR_SELECTORS', 'TRAE_IDE_INDICATOR_SELECTORS'),
      DEFAULT_IDE_INDICATOR_SELECTORS
    ),
    soloIndicatorSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_SOLO_INDICATOR_SELECTORS', 'TRAE_SOLO_INDICATOR_SELECTORS'),
      DEFAULT_SOLO_INDICATOR_SELECTORS
    ),
    defaultMode: getEnvWithFallback('TRAECN_DEFAULT_MODE', 'TRAE_DEFAULT_MODE', 'solo'),
    modeSwitchWaitMs: parsePositiveInt(
      getEnvWithFallback('TRAECN_MODE_SWITCH_WAIT_MS', 'TRAE_MODE_SWITCH_WAIT_MS', '2000'), 2000
    ),
    // ── End dual UI additions ───────────────────────────────────────────
    sendTrigger: getEnvWithFallback('TRAECN_SEND_TRIGGER', 'TRAE_SEND_TRIGGER', 'button'),
    pollIntervalMs: parsePositiveInt(getEnvWithFallback('TRAECN_RESPONSE_POLL_INTERVAL_MS', 'TRAE_RESPONSE_POLL_INTERVAL_MS', '350'), 350),
    idleMs: parsePositiveInt(getEnvWithFallback('TRAECN_RESPONSE_IDLE_MS', 'TRAE_RESPONSE_IDLE_MS', '1200'), 1200),
    timeoutMs: parsePositiveInt(
      getEnvWithFallback('TRAECN_RESPONSE_TIMEOUT_MS', 'TRAE_RESPONSE_TIMEOUT_MS', runtimeDefault('TRAECN_RESPONSE_TIMEOUT_MS')),
      Number(runtimeDefault('TRAECN_RESPONSE_TIMEOUT_MS'))
    ),
    postActionDelayMs: parsePositiveInt(getEnvWithFallback('TRAECN_POST_ACTION_DELAY_MS', 'TRAE_POST_ACTION_DELAY_MS', '350'), 350),
    sessionPrepareTimeoutMs: parsePositiveInt(getEnvWithFallback('TRAECN_SESSION_PREPARE_TIMEOUT_MS', 'TRAE_SESSION_PREPARE_TIMEOUT_MS', '5000'), 5000),
    queuePollIntervalMs: parsePositiveInt(getEnvWithFallback('TRAECN_QUEUE_POLL_INTERVAL_MS', 'TRAE_QUEUE_POLL_INTERVAL_MS', '15000'), 15000),
    queueWaitTimeoutMs: parsePositiveInt(
      getEnvWithFallback('TRAECN_QUEUE_WAIT_TIMEOUT_MS', 'TRAE_QUEUE_WAIT_TIMEOUT_MS', runtimeDefault('TRAECN_QUEUE_WAIT_TIMEOUT_MS')),
      Number(runtimeDefault('TRAECN_QUEUE_WAIT_TIMEOUT_MS'))
    ),
    queuePerTaskTimeoutMs: parsePositiveInt(
      getEnvWithFallback('TRAECN_QUEUE_PER_TASK_TIMEOUT_MS', 'TRAE_QUEUE_PER_TASK_TIMEOUT_MS', runtimeDefault('TRAECN_QUEUE_PER_TASK_TIMEOUT_MS')),
      Number(runtimeDefault('TRAECN_QUEUE_PER_TASK_TIMEOUT_MS'))
    ),
    queueTimeoutExtensionMs: parsePositiveInt(getEnvWithFallback('TRAECN_QUEUE_TIMEOUT_EXTENSION_MS', 'TRAE_QUEUE_TIMEOUT_EXTENSION_MS', '600000'), 600000),
    queueMaxWaitMs: parseOptionalPositiveInt(getEnvWithFallback('TRAECN_QUEUE_MAX_WAIT_MS', 'TRAE_QUEUE_MAX_WAIT_MS')),
    fileAllowedRoots,
    allowUnsafeDiskAccess: getEnvWithFallback('TRAECN_FILE_ALLOW_UNSAFE_DISK_ACCESS', 'TRAE_FILE_ALLOW_UNSAFE_DISK_ACCESS', '0') === '1',
    // Approval / dialog handling
    approvalTimeoutMs: parsePositiveInt(getEnvWithFallback('TRAECN_APPROVAL_TIMEOUT_MS', 'TRAE_APPROVAL_TIMEOUT_MS', '120000'), 120000),
    approvalPollIntervalMs: parsePositiveInt(getEnvWithFallback('TRAECN_APPROVAL_POLL_INTERVAL_MS', 'TRAE_APPROVAL_POLL_INTERVAL_MS', '3000'), 3000)
  };
}

function sanitizeActivityText(text) {
  if (!text) return '';
  return text
    .replace(/正在思考…/g, '')
    .replace(/思考中…/g, '')
    .replace(/Generating…/g, '')
    .replace(/Thinking…/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTruncationSignal(text) {
  if (!text) return false;
  const truncatePatterns = [
    'Builder手动终止输出',
    '手动终止输出',
    '输出已终止',
    '生成已停止',
    '等待中...',
    '等待中…',
    '排队提醒',
    '正在分析问题...',
    '正在分析问题…'
  ];
  return truncatePatterns.some(p => text.includes(p));
}

module.exports = {
  DEFAULT_COMPOSER_SELECTORS,
  DEFAULT_SEND_BUTTON_SELECTORS,
  DEFAULT_RESPONSE_SELECTORS,
  DEFAULT_ACTIVITY_SELECTORS,
  DEFAULT_NEW_CHAT_SELECTORS,
  DEFAULT_MODE_TAB_SELECTORS,
  DEFAULT_IDE_TASK_PANEL_SELECTORS,
  DEFAULT_IDE_RESPONSE_SELECTORS,
  DEFAULT_IDE_NEW_CHAT_SELECTORS,
  DEFAULT_IDE_INDICATOR_SELECTORS,
  DEFAULT_SOLO_INDICATOR_SELECTORS,
  getConfig,
  sanitizeActivityText,
  isTruncationSignal
};
