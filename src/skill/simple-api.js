'use strict';

const { TraeCNSkill } = require('./traecn-skill');

let _instance = null;

function getSkill(context = {}) {
  if (!_instance) {
    _instance = new TraeCNSkill(context);
  }
  return _instance;
}

async function t(task, opts = {}) {
  const skill = getSkill();
  const result = await skill.run(task, opts);
  if (result.error) {
    throw new Error(result.error);
  }
  return result.text;
}

async function q(task, opts = {}) {
  const skill = getSkill();
  const result = await skill.queue(task, opts);
  return result.taskId;
}

async function p(taskId = null) {
  const skill = getSkill();
  const result = await skill.poll(taskId);
  return result;
}

async function cancel(taskId = null) {
  const skill = getSkill();
  return await skill.cancel(taskId);
}

async function s() {
  const skill = getSkill();
  const status = await skill.status();
  return status.connected;
}

async function model(name) {
  const skill = getSkill();
  return await skill.switchModel(name);
}

async function mode(m) {
  const skill = getSkill();
  return await skill.switchMode(m);
}

async function newChat() {
  const skill = getSkill();
  return await skill.newChat();
}

async function settings(section = null) {
  const skill = getSkill();
  return await skill.getSettings(section);
}

async function set(label, value, section = null) {
  const skill = getSkill();
  return await skill.setSetting(label, value, section);
}

async function approve(action = 'auto', wait = false) {
  const skill = getSkill();
  return await skill.approveDialog(action, wait);
}

async function dialog() {
  const skill = getSkill();
  return await skill.checkDialog();
}

async function queueCheck() {
  const skill = getSkill();
  return await skill.queueStatus();
}

async function open(path) {
  const skill = getSkill();
  return await skill.openProject(path);
}

function reset() {
  _instance = null;
}

module.exports = {
  t,
  q,
  p,
  cancel,
  s,
  model,
  mode,
  newChat,
  settings,
  set,
  approve,
  dialog,
  queueCheck,
  open,
  reset,
  getSkill,
  TraeCNSkill
};
