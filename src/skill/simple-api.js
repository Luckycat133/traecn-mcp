'use strict';

const { TraeCNSkill } = require('./traecn-skill');
const promptLayers = require('./prompt-layers');
const { buildCodeReviewTask } = require('./review');

let _instance = null;

function getSkill(context = {}) {
  if (!_instance) {
    _instance = new TraeCNSkill(context);
  }
  return _instance;
}

async function runTask(task, opts = {}) {
  const skill = getSkill();
  const result = await skill.run(task, opts);
  if (result.error) {
    throw new Error(result.error);
  }
  return result.text;
}

async function queueTask(task, opts = {}) {
  const skill = getSkill();
  const result = await skill.queue(task, opts);
  return result.taskId;
}

async function pollTask(taskId = null) {
  const skill = getSkill();
  const result = await skill.poll(taskId);
  return result;
}

async function waitTask(taskId = null, opts = {}) {
  const skill = getSkill();
  return await skill.wait(taskId, opts);
}

async function cancelTask(taskId = null) {
  const skill = getSkill();
  return await skill.cancel(taskId);
}

async function checkStatus() {
  const skill = getSkill();
  const status = await skill.status();
  return status.connected;
}

async function getCapabilities() {
  const skill = getSkill();
  return await skill.getCapabilities();
}

async function planOperation(command, params = {}, opts = {}) {
  const skill = getSkill();
  return await skill.planOperation(command, params, opts);
}

async function preflight(options = {}) {
  const skill = getSkill();
  return await skill.preflight(options);
}

async function switchModel(name) {
  const skill = getSkill();
  return await skill.switchModel(name);
}

async function switchMode(m) {
  const skill = getSkill();
  return await skill.switchMode(m);
}

async function newChat() {
  const skill = getSkill();
  return await skill.newChat();
}

async function getSettings(section = null) {
  const skill = getSkill();
  return await skill.getSettings(section);
}

async function setSetting(label, value, section = null) {
  const skill = getSkill();
  return await skill.setSetting(label, value, section);
}

async function approveDialog(action = 'auto', wait = false) {
  const skill = getSkill();
  return await skill.approveDialog(action, wait);
}

async function checkDialog() {
  const skill = getSkill();
  return await skill.checkDialog();
}

async function checkQueue() {
  const skill = getSkill();
  return await skill.queueStatus();
}

async function openProject(path) {
  const skill = getSkill();
  return await skill.openProject(path);
}

async function reviewCode(input, opts = {}) {
  const skill = getSkill();
  const result = await skill.reviewCode(input, opts);
  return opts.queue === true ? result.taskId : result.text;
}

async function vibeWorkflow(input, opts = {}) {
  const skill = getSkill();
  const result = await skill.vibeWorkflow({ ...input, ...opts });
  return result.taskId;
}

function reset() {
  _instance = null;
}

const t = runTask;
const q = queueTask;
const p = pollTask;
const w = waitTask;
const s = checkStatus;
const capabilities = getCapabilities;
const plan = planOperation;
const pf = preflight;
const model = switchModel;
const mode = switchMode;
const settings = getSettings;
const set = setSetting;
const approve = approveDialog;
const dialog = checkDialog;
const queueCheck = checkQueue;
const open = openProject;
const cancel = cancelTask;
const review = reviewCode;
const vibe = vibeWorkflow;

module.exports = {
  runTask,
  queueTask,
  pollTask,
  waitTask,
  cancelTask,
  checkStatus,
  getCapabilities,
  planOperation,
  preflight,
  switchModel,
  switchMode,
  newChat,
  getSettings,
  setSetting,
  approveDialog,
  checkDialog,
  checkQueue,
  openProject,
  reviewCode,
  vibeWorkflow,
  reset,
  getSkill,
  TraeCNSkill,
  buildCodeReviewTask,
  t,
  q,
  p,
  w,
  s,
  capabilities,
  plan,
  pf,
  model,
  mode,
  settings,
  set,
  approve,
  dialog,
  queueCheck,
  open,
  cancel,
  review,
  vibe,
  promptLayers
};
