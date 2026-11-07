'use strict';

/* global window */

const { evaluate } = require('./browser-dom');

const STATUS_CHANNEL = 'vscode:sandbox::main-invoke-fetchCheckinCreditsStatus';
const CLAIM_CHANNEL = 'vscode:sandbox::main-invoke-claimCheckinCredits';
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijingDay(now) {
  return new Date(now + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

// Runs in the Trae workbench renderer. Only the fields below cross CDP.
async function invokeCheckIn(channel) {
  const loginGate = window.document?.querySelector('.icube-login-modal, button[class*="accountLoginButton"]');
  if (loginGate?.getClientRects?.().length) return { kind: 'login_required' };
  const ipc = window.vscode?.ipcRenderer;
  if (typeof ipc?.invoke !== 'function') return { kind: 'ipc_unavailable' };

  try {
    // Passing account_menu, banner_popup or sidebar_banner to claim can attach
    // a lottery entry. Keep the native invocation argument-free.
    const reply = await ipc.invoke(channel);
    const data = reply?.data;
    const credit = value => typeof value === 'number' && value > 0 && value <= Number.MAX_SAFE_INTEGER
      ? value : undefined;
    return {
      kind: 'reply',
      status: Number.isInteger(reply?.status) && reply.status >= 100 && reply.status <= 599
        ? reply.status : null,
      day: typeof reply?.beijingDayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reply.beijingDayKey)
        ? reply.beijingDayKey : undefined,
      rejected: data != null && Object.prototype.hasOwnProperty.call(data, 'code') && data.code !== 0,
      enabled: typeof data?.enable === 'boolean' ? data.enable : undefined,
      checkedIn: typeof data?.checked_in === 'boolean' ? data.checked_in : undefined,
      deviceCheckedIn: data?.did_checked_in === true,
      credits: credit(data?.credits),
      extraCredits: credit(data?.extra_credits)
    };
  } catch (error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    const login = window.document?.querySelector('icube-user-card')?.shadowRoot
      ?.querySelector('.icube-user-card__login__button');
    if (login || /\b(?:401|unauthenticated|unauthorized|login required|not logged in)\b|未登录|请登录/i.test(message)) {
      return { kind: 'login_required' };
    }
    if (/No handler registered|Unsupported event IPC channel/i.test(message)) {
      return { kind: 'ipc_unavailable', invoked: true };
    }
    if (message.includes('Checkin credits is unavailable')) return { kind: 'checkin_not_available' };
    return { kind: 'ipc_failed' };
  }
}

function statusResult(reply, day) {
  if (reply?.kind === 'login_required' || reply?.status === 401) {
    return { state: 'login_required', day, checkedIn: null };
  }
  if (reply?.kind === 'ipc_unavailable' || reply?.kind === 'checkin_not_available' || reply?.status === 403) {
    return { state: 'unavailable', day, checkedIn: null, reason: reply.kind === 'reply' ? 'forbidden' : reply.kind };
  }
  if (reply?.status !== 200 || reply.rejected || typeof reply.enabled !== 'boolean' || typeof reply.checkedIn !== 'boolean') {
    return { state: 'unknown', day, checkedIn: null, reason: 'status_unverified' };
  }
  const result = {
    day,
    checkedIn: reply.checkedIn,
    ...(reply.credits !== undefined && { credits: reply.credits }),
    ...(reply.extraCredits !== undefined && { extraCredits: reply.extraCredits })
  };
  if (reply.checkedIn) return { state: 'already_claimed', ...result };
  if (reply.deviceCheckedIn) return { state: 'unavailable', ...result, reason: 'device_already_checked_in' };
  if (!reply.enabled) return { state: 'unavailable', ...result, reason: 'checkin_disabled' };
  return { state: 'ready', ...result };
}

class CheckInDriver {
  constructor(client, { now = Date.now } = {}) {
    this.client = client;
    this.now = now;
    this.claimInFlight = null;
  }

  async #invoke(channel) {
    try {
      return await evaluate(this.client, invokeCheckIn, [channel]);
    } catch {
      return { kind: 'ipc_failed' };
    }
  }

  async status() {
    const day = beijingDay(this.now());
    const reply = await this.#invoke(STATUS_CHANNEL);
    if (day !== beijingDay(this.now())) {
      return { state: 'unknown', day, checkedIn: null, reason: 'business_day_changed' };
    }
    return statusResult(reply, day);
  }

  claim() {
    if (!this.claimInFlight) {
      this.claimInFlight = this.#claimOnce().finally(() => { this.claimInFlight = null; });
    }
    return this.claimInFlight;
  }

  async #claimOnce() {
    const before = await this.status();
    if (before.state !== 'ready') return before;
    if (before.day !== beijingDay(this.now())) {
      return { state: 'unknown', day: before.day, checkedIn: null, reason: 'business_day_changed' };
    }

    // Even if CDP drops the response, Trae may already have sent the claim.
    // Read status once, never follow a failed write with another write.
    const reply = await this.#invoke(CLAIM_CHANNEL);
    if (reply?.kind === 'ipc_unavailable') {
      return { ...statusResult(reply, before.day), ...(reply.invoked && { attempted: true }) };
    }
    const after = await this.status();
    if (before.day !== after.day || (reply?.day && reply.day !== before.day)) {
      return { state: 'unknown', day: before.day, checkedIn: null, attempted: true, reason: 'business_day_changed' };
    }
    if (after.checkedIn === true) {
      const confirmedClaim = reply?.status === 200 && !reply.rejected && reply.day === before.day;
      return { ...after, state: confirmedClaim ? 'claimed' : 'already_claimed', attempted: true };
    }
    return {
      state: after.state === 'login_required' ? 'login_required' : 'unknown',
      day: before.day,
      checkedIn: null,
      attempted: true,
      reason: 'claim_unverified'
    };
  }
}

module.exports = { CheckInDriver };
