'use strict';

/**
 * Simple API facade for the TraeCN Skill.
 *
 * Previously this file duplicated the body of every method on top of a local
 * singleton; it now re-exports the layered `index.js` surface as a flat set of
 * function aliases so the documented public shape (runTask, queueTask, ...) is
 * preserved while delegating the actual work to a single implementation.
 *
 * Two helpers that have no direct equivalent in `index.js` (vibeWorkflow,
 * getCapabilities, planOperation) go through the underlying TraeCNSkill
 * instance — they're informational/configuration methods rather than task
 * runners, so they don't need the error-mapping wrappers the basic layer has.
 */

const layered = require('./index');
const { TraeCNSkill } = require('./traecn-skill');
const { buildCodeReviewTask } = require('./review');
const promptLayers = require('./prompt-layers');

let _instance = null;
function _skill() {
  if (!_instance) _instance = new TraeCNSkill();
  return _instance;
}

// ── Errors-out wrappers around `advanced.*` (index.js namespacing) ─────

async function cancelTask(taskId = null) {
  return layered.advanced.cancelTask(taskId);
}
async function switchMode(m) {
  return layered.advanced.switchMode(m);
}
async function newChat() {
  return layered.advanced.newChat();
}
async function listSoloChats() {
  return layered.advanced.listSoloChats();
}
async function switchSoloChat(criteria = {}) {
  return layered.advanced.switchSoloChat(criteria);
}
async function submitSoloChatTask(task, opts = {}) {
  return layered.advanced.submitSoloChatTask(task, opts);
}
async function openProject(p) {
  return layered.advanced.openProject(p);
}

// ── Config + dialog + batch passthroughs ─────────────────────────────────

async function getSettings(section = null) {
  return layered.config.getSettings(section);
}
async function setSetting(label, value, section = null) {
  return layered.config.setSetting(label, value, section);
}
async function approveDialog(action = 'auto', wait = false) {
  return layered.dialog.approveDialog(action, wait);
}
async function checkDialog() {
  return layered.dialog.checkDialog();
}
async function checkQueue() {
  return layered.dialog.checkQueue();
}

// ── Methods that only exist on TraeCNSkill (not surfaced by index.js) ────

async function getCapabilities() {
  return _skill().getCapabilities();
}
async function planOperation(command, params = {}, opts = {}) {
  return _skill().planOperation(command, params, opts);
}
async function vibeWorkflow(input = {}, opts = {}) {
  const result = await _skill().vibeWorkflow({ ...input, ...opts });
  return result.taskId;
}

// ── Flat single-letter aliases (kept for backward compatibility) ─────────

const t = layered.runTask;
const q = layered.queueTask;
const p = layered.pollTask;
const w = layered.waitTask;
const s = layered.checkStatus;
const capabilities = getCapabilities;
const plan = planOperation;
const pf = layered.preflight;
const model = layered.switchModel;
const mode = switchMode;
const soloChats = listSoloChats;
const soloSwitch = switchSoloChat;
const soloSubmit = submitSoloChatTask;
const settings = getSettings;
const set = setSetting;
const approve = approveDialog;
const dialog = checkDialog;
const queueCheck = checkQueue;
const open = openProject;
const cancel = cancelTask;
const review = layered.reviewCode;
const vibe = vibeWorkflow;

module.exports = {
  // basic
  runTask: layered.runTask,
  queueTask: layered.queueTask,
  pollTask: layered.pollTask,
  waitTask: layered.waitTask,
  cancelTask,
  checkStatus: layered.checkStatus,
  getCapabilities,
  planOperation,
  preflight: layered.preflight,
  switchModel: layered.switchModel,
  switchMode,
  newChat,
  listSoloChats,
  switchSoloChat,
  submitSoloChatTask,
  // config + dialog
  getSettings,
  setSetting,
  approveDialog,
  checkDialog,
  checkQueue,
  openProject,
  // higher level
  reviewCode: layered.reviewCode,
  vibeWorkflow,
  // lifecycle
  reset: layered.reset,
  getSkill: layered.getSkill,
  // types + raw skill
  TraeCNSkill: layered.TraeCNSkill,
  buildCodeReviewTask,
  // prompt layers (informational)
  promptLayers,
  // flat aliases
  t, q, p, w, s,
  capabilities, plan, pf,
  model, mode,
  soloChats, soloSwitch, soloSubmit,
  settings, set,
  approve, dialog, queueCheck,
  open, cancel, review, vibe,
};