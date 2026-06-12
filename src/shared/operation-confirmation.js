'use strict';

const HIGH_RISK_COMMANDS = new Set([
  'settings_set',
  'approve_dialog',
  'dismiss_dialog',
  'batch_cancel',
  'cancel_task',
  'stop_generation',
  'resolve_review_gate',
  'update_self',
  'restart_trae_debug'
]);

const MEDIUM_RISK_COMMANDS = new Set([
  'delegate',
  'delegate_async',
  'review_code',
  'switch_mode',
  'switch_model',
  'new_chat',
  'open_project',
  'batch_submit',
  'settings_navigate',
  'settings_back'
]);

const READ_ONLY_COMMANDS = new Set([
  'capabilities',
  'preflight',
  'status',
  'readiness',
  'task_status',
  'adopt_current_task',
  'review_gate_status',
  'queue_status',
  'settings_read',
  'settings_read_all',
  'dialog_status',
  'batch_status'
]);

function stableJson(value) {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, Object.keys(value || {}).sort());
  } catch {
    return String(value);
  }
}

function classifyCommand(command) {
  if (HIGH_RISK_COMMANDS.has(command)) return 'high';
  if (MEDIUM_RISK_COMMANDS.has(command)) return 'medium';
  if (READ_ONLY_COMMANDS.has(command)) return 'low';
  return 'unknown';
}

function buildChecklist(command, params = {}) {
  const checklist = ['Confirm gateway target host/port and token scope.'];

  if (['delegate', 'delegate_async', 'review_code', 'batch_submit'].includes(command)) {
    checklist.push('Check readiness and queue status before sending task content.');
    checklist.push('Prefer async delegation plus polling for long-running work.');
  }

  if (command === 'settings_set') {
    checklist.push('Read the target settings section before writing.');
    checklist.push(`Confirm setting label ${JSON.stringify(params.label || '')} and desired value ${JSON.stringify(params.value)}.`);
  }

  if (command === 'approve_dialog' || command === 'dismiss_dialog') {
    checklist.push('Call dialog_status first and compare dialog question/buttons with the intended action.');
    checklist.push('Use deny/cancel/dismiss for unexpected permission prompts.');
  }

  if (command === 'open_project') {
    checklist.push('Confirm projectPath is local, expected, and safe to open in Trae CN.');
  }

  if (command === 'switch_model' || command === 'switch_mode') {
    checklist.push('Confirm current task can tolerate model or mode changes.');
  }

  if (command === 'batch_cancel' || command === 'cancel_task' || command === 'stop_generation' || command === 'resolve_review_gate') {
    checklist.push('Confirm the task or batch ID and that cancellation is still desired.');
  }

  return checklist;
}

function buildConfirmationPlan(input = {}) {
  const command = String(input.command || '').trim();
  const params = input.params && typeof input.params === 'object' ? input.params : {};
  const risk = classifyCommand(command);
  const requiresConfirmation = risk === 'high' || input.forceConfirm === true;
  const idSource = `${command}:${stableJson(params)}:${requiresConfirmation}`;
  const confirmationId = Buffer.from(idSource).toString('base64url').slice(0, 32);

  return {
    command,
    risk,
    requiresConfirmation,
    confirmationId,
    sideEffects: risk === 'low' ? [] : describeSideEffects(command, params),
    preflight: buildChecklist(command, params),
    recommendedFlow: buildRecommendedFlow(command, risk, requiresConfirmation),
    tokenHint: risk === 'low'
      ? 'Safe to call directly after capabilities discovery.'
      : 'Send this compact plan to the user or supervising agent instead of replaying full task context.'
  };
}

function describeSideEffects(command, params) {
  switch (command) {
    case 'settings_set':
      return [`May change Trae CN setting ${JSON.stringify(params.label || '')}.`];
    case 'approve_dialog':
      return ['May grant permission, trust a project, or approve command execution in Trae CN.'];
    case 'dismiss_dialog':
      return ['May close an active confirmation or permission dialog.'];
    case 'delegate':
    case 'delegate_async':
    case 'review_code':
      return ['Sends task content to Trae CN and may cause generated code or tool actions inside the app.'];
    case 'open_project':
      return [`May open local project ${JSON.stringify(params.projectPath || '')} in Trae CN.`];
    case 'switch_model':
      return [`May switch active model to ${JSON.stringify(params.model || '')}.`];
    case 'switch_mode':
      return [`May switch Trae CN mode to ${JSON.stringify(params.mode || '')}.`];
    case 'batch_submit':
      return ['May enqueue multiple tasks and consume Trae CN model capacity.'];
    case 'batch_cancel':
    case 'cancel_task':
    case 'stop_generation':
      return ['May cancel queued work.'];
    case 'resolve_review_gate':
      return ['May keep or revert changes at Trae CN internal task review gate.'];
    case 'restart_trae_debug':
      return ['Quits Trae CN, then restarts it with remote debugging enabled and the existing logged-in profile.'];
    default:
      return ['May change Trae CN state.'];
  }
}

function buildRecommendedFlow(command, risk, requiresConfirmation) {
  const flow = ['traecn_capabilities'];
  if (risk !== 'low') flow.push('check_status', 'readiness');
  if (['delegate', 'delegate_async', 'review_code', 'batch_submit'].includes(command)) flow.push('check_queue');
  if (command === 'approve_dialog' || command === 'dismiss_dialog') flow.push('check_dialog');
  if (command === 'resolve_review_gate') flow.push('review_gate_status');
  if (command === 'settings_set') flow.push('get_settings');
  if (requiresConfirmation) flow.push('user_confirmation');
  flow.push(command || 'target_command');
  return flow;
}

module.exports = {
  buildConfirmationPlan,
  classifyCommand
};
