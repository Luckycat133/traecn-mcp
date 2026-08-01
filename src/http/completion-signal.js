'use strict';

const {
  formatResult,
  formatReviewRequiredMessage,
  notifyOpenClaw,
  sendTaskWebhook
} = require('./task-notify');

const TERMINAL_EVENTS = new Set([
  'task.completed',
  'task.error',
  'task.queue_timeout',
  'task.review_rejected'
]);
const ATTENTION_EVENTS = new Set([
  'task.review_required',
  'task.approval_required'
]);

function eventSummary(task = {}, extra = {}) {
  return String(
    task.result?.text
    || task.result?.question
    || task.error
    || extra.message
    || ''
  ).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function durableEvent(taskId, task, eventType, extra) {
  return {
    type: eventType,
    taskId,
    status: task.status,
    terminal: TERMINAL_EVENTS.has(eventType),
    attentionRequired: ATTENTION_EVENTS.has(eventType),
    resultAvailable: !!task.result,
    sessionId: task.sessionId || null,
    summary: eventSummary(task, extra)
  };
}

function openClawMessage(taskId, task, eventType) {
  if (eventType === 'task.review_required') {
    return formatReviewRequiredMessage(taskId, task.result, task.followupTasks?.length || 0);
  }
  if (eventType === 'task.approval_required') {
    return `🤖 Trae 需要处理受限模式或确认弹窗:\nTask ID: ${taskId}\n${task.result?.question || ''}`;
  }
  if (eventType === 'task.completed') return formatResult(task.result);
  if (eventType === 'task.error') return '❌ Trae 出错: ' + (task.error || 'unknown error');
  if (eventType === 'task.queue_timeout') return '❌ Trae 排队超时（超过限制），请稍后重试或切换模型';
  return null;
}

function webhookPayload(taskId, task, eventType, extra = {}) {
  return {
    event: eventType,
    data: {
      taskId,
      status: task.status,
      reviewDecision: task.reviewDecision || null,
      nextTaskId: task.nextTaskId || null,
      result: task.result ? {
        text: task.result.text || '',
        stable: task.result.stable || false,
        elapsedMs: task.result.elapsedMs || 0,
        timedOut: task.result.timedOut || false,
        needsApproval: task.result.needsApproval || false,
        question: task.result.question || '',
        dialogType: task.result.dialogType || null,
        buttons: task.result.buttons || [],
        options: task.result.options || []
      } : null,
      error: task.error || null,
      followupCount: task.followupTasks?.length || 0,
      ...extra
    }
  };
}

class CompletionSignal {
  constructor(options = {}) {
    this.getTaskEventStore = options.getTaskEventStore || (() => null);
    this.getWebSocketHandler = options.getWebSocketHandler || (() => null);
    this.notifyOpenClaw = options.notifyOpenClaw || notifyOpenClaw;
    this.sendTaskWebhook = options.sendTaskWebhook || sendTaskWebhook;
    this.logger = options.logger || console;
  }

  async emit(taskId, task, eventType, extra = {}) {
    const eventStore = this.getTaskEventStore();
    if (eventStore && typeof eventStore.append === 'function') {
      eventStore.append(durableEvent(taskId, task, eventType, extra));
    }

    const webSocketHandler = this.getWebSocketHandler();
    if (webSocketHandler) {
      webSocketHandler.broadcastEvent(eventType, { taskId, status: task.status, ...extra });
    }

    if (task.chatId) {
      const message = openClawMessage(taskId, task, eventType);
      if (message) await this.notifyOpenClaw(task.chatId, message);
    }

    if (task.notifyUrl) {
      try {
        await this.sendTaskWebhook(
          task.notifyUrl,
          webhookPayload(taskId, task, eventType, extra)
        );
      } catch (error) {
        this.logger.error('[TaskNotify] webhook failed:', error.message);
      }
    }
  }
}

module.exports = {
  CompletionSignal,
  durableEvent,
  eventSummary,
  openClawMessage,
  webhookPayload
};
