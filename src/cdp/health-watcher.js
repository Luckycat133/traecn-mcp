'use strict';

/**
 * CDPHealthWatcher — keeps a live `client` connection alive by watching for
 * WS disconnects (and periodic liveness probes) and triggering gateway-level
 * recovery (e.g. `_attemptTraeRecovery`) when the target appears gone.
 *
 * Design constraints:
 * - Opt-in: `enabled` defaults to false so interactive users are not surprised
 *   by a watcher yanking a half-typed prompt out of the running TraeCN.
 * - Bounded: `maxRecoveries` caps back-to-back recovery attempts; after that
 *   the watcher stops itself and emits `auto-recovery-giveup` so an operator
 *   can investigate.
 * - Idempotent: only one recovery runs at a time. Re-entrancy is coalesced.
 * - Cooperative cooldown: shares the gateway's `lastTraeRecoveryAt` /
 *   `traeRecoveryCooldownMs` so manual `_attemptTraeRecovery` calls and the
 *   watcher never step on each other.
 * - Cheap liveness probe: `Target.getTargets` is the smallest CDP round-trip
 *   that exercises the full WS path without depending on the page being
 *   loaded.
 *
 * The watcher never throws. All failures are logged and emitted as events.
 */

const { EventEmitter } = require('events');
const { parsePositiveInt } = require('../shared/utils');

const DEFAULT_PROBE_INTERVAL_MS = 30000;
const DEFAULT_MAX_RECOVERIES = 5;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const PROBE_METHOD = 'Target.getTargets';

class CDPHealthWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.gateway = options.gateway || null;
    this.enabled = options.enabled === true;
    this.probeIntervalMs = parsePositiveInt(options.probeIntervalMs, DEFAULT_PROBE_INTERVAL_MS);
    this.maxRecoveries = parsePositiveInt(options.maxRecoveries, DEFAULT_MAX_RECOVERIES);
    this.probeTimeoutMs = parsePositiveInt(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
    this.logger = options.logger || console;
    this._label = options.label || 'cdp';
    this._recoverFn = typeof options.recoverFn === 'function' ? options.recoverFn : null;

    this._client = null;
    this._probeTimer = null;
    this._probeInFlight = null;
    this._recovering = false;
    this._consecutiveFailures = 0;
    this._stopped = false;
  }

  /**
   * Attach to a live client. Detaches any previous client first. Calling
   * `start` with a null/undefined client is a no-op.
   */
  start(client) {
    this._stopped = false;
    if (!this.enabled) return;
    if (!client) return;
    if (this._client === client && this._probeTimer) return;

    this._detachClient();
    this._client = client;
    this._attachClient();

    if (this.probeIntervalMs > 0) {
      this._probeTimer = setInterval(() => {
        this._runProbe().catch(() => { /* swallowed — _runProbe logs */ });
      }, this.probeIntervalMs);
      if (this._probeTimer.unref) this._probeTimer.unref();
    }

    this.logger.log?.(`[${this._label}] health watcher started`);
  }

  /**
   * Stop watching the current client and clear timers. Safe to call multiple
   * times. After `stop`, the watcher will not start again unless `start` is
   * called with a fresh client.
   */
  stop() {
    this._stopped = true;
    if (this._probeTimer) {
      clearInterval(this._probeTimer);
      this._probeTimer = null;
    }
    if (this._probeInFlight) {
      // Best-effort: do not block stop on a slow probe. The in-flight promise
      // will resolve and find `_stopped = true` / `_client = null` and exit.
      this._probeInFlight.catch(() => { /* ignore */ });
    }
    this._detachClient();
    this._client = null;
  }

  /**
   * Force a single liveness probe outside the periodic schedule. Used by
   * tests and by manual recovery triggers.
   */
  async forceProbe() {
    if (!this._client) return { ok: false, reason: 'no-client' };
    return this._runProbe();
  }

  _attachClient() {
    if (!this._client || typeof this._client.on !== 'function') return;
    this._handlers = {
      disconnect: (data) => this._handleDisconnect(data, 'ws-disconnect'),
      'reconnect-failed': (data) => this._handleDisconnect(data, 'reconnect-failed'),
      error: (err) => this._handleDisconnect({ error: err }, 'ws-error')
    };
    for (const [ev, fn] of Object.entries(this._handlers)) {
      this._client.on(ev, fn);
    }
  }

  _detachClient() {
    if (!this._client || !this._handlers) return;
    if (typeof this._client.off === 'function') {
      for (const [ev, fn] of Object.entries(this._handlers)) {
        this._client.off(ev, fn);
      }
    }
    this._handlers = null;
  }

  async _handleDisconnect(data, source) {
    if (this._stopped) return;
    if (!this._client) return;
    if (this._recovering) {
      this.logger.log?.(`[${this._label}] disconnect during in-flight recovery, ignoring source=${source}`);
      return;
    }
    this.logger.warn?.(`[${this._label}] CDP client unhealthy: source=${source} data=${summarize(data)}`);
    this._emitHealthEvent('unhealthy', { source, data });
    await this._attemptAutoRecovery(source);
  }

  async _runProbe() {
    if (this._stopped) return { ok: false, reason: 'stopped' };
    if (this._recovering) return { ok: false, reason: 'recovering' };
    const client = this._client;
    if (!client || !client.isConnected) {
      return this._handleProbeFailure(new Error('client-not-connected'), 'probe-not-connected');
    }
    if (typeof client.send !== 'function') {
      return this._handleProbeFailure(new Error('client-send-missing'), 'probe-send-missing');
    }
    this._probeInFlight = this._sendWithTimeout(client, PROBE_METHOD, {}, this.probeTimeoutMs);
    try {
      await this._probeInFlight;
      this._probeInFlight = null;
      this._consecutiveFailures = 0;
      return { ok: true };
    } catch (err) {
      this._probeInFlight = null;
      return this._handleProbeFailure(err, 'probe-error');
    }
  }

  async _sendWithTimeout(client, method, params, timeoutMs) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`probe-timeout-${timeoutMs}ms`)), timeoutMs);
      if (timer.unref) timer.unref();
    });
    try {
      return await Promise.race([client.send(method, params), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _handleProbeFailure(err, source) {
    if (this._stopped) return { ok: false, reason: 'stopped' };
    this.logger.warn?.(`[${this._label}] CDP liveness probe failed: source=${source} error=${err && err.message}`);
    this._emitHealthEvent('unhealthy', { source, error: err && err.message });
    // Fire-and-forget — the caller (`_runProbe`) does not need to await
    // recovery to resolve.
    this._attemptAutoRecovery(source).catch(() => { /* logged inside */ });
    return { ok: false, reason: source, error: err && err.message };
  }

  async _attemptAutoRecovery(source) {
    if (this._stopped) return { ok: false, reason: 'stopped' };
    if (this._recovering) return { ok: false, reason: 'recovering' };
    if (!this.gateway) return { ok: false, reason: 'no-gateway' };
    if (this.gateway.mockBridge) return { ok: false, reason: 'mock-bridge' };
    if (!this.gateway.autoStartTrae) return { ok: false, reason: 'auto-start-trae-off' };

    // Respect gateway cooldown. _attemptTraeRecovery enforces it itself, so
    // we just skip without scheduling a retry.
    const cooldownMs = this.gateway.traeRecoveryCooldownMs || 0;
    const lastAt = this.gateway.lastTraeRecoveryAt || 0;
    if (cooldownMs > 0 && Date.now() - lastAt < cooldownMs) {
      this.logger.log?.(`[${this._label}] auto-recovery suppressed by gateway cooldown (${cooldownMs}ms)`);
      this._emitHealthEvent('cooldown', { source, cooldownMs });
      return { ok: false, reason: 'cooldown' };
    }

    this._recovering = true;
    this._consecutiveFailures += 1;
    this.logger.log?.(`[${this._label}] auto-recovery attempt #${this._consecutiveFailures} (source=${source})`);
    this._emitHealthEvent('recovery-start', { source, attempt: this._consecutiveFailures });

    let recoveryOk = false;
    let newClient;
    try {
      const reason = new Error(`auto-recovery:${source}`);
      if (this._recoverFn) {
        // Test/seam path: caller supplies the entire recovery sequence
        // (typically `_attemptTraeRecovery` + `discoverTarget` + `connectToTarget`
        // + driver swap). Returning a falsy value means "skip this attempt".
        const result = await this._recoverFn({ gateway: this.gateway, reason, source });
        if (!result) {
          this.logger.warn?.(`[${this._label}] recoverFn returned falsy (cooldown/binary/giveup)`);
          this._emitHealthEvent('recovery-skip', { source, attempt: this._consecutiveFailures });
          return this._maybeGiveUp(source, { ok: false, reason: 'gateway-skip' });
        }
        if (result && result.ok) {
          newClient = result.client || null;
          if (newClient) {
            const driver = result.driver || (this.gateway && this.gateway.driver) || null;
            await this._replaceClient(newClient, driver);
          }
          recoveryOk = true;
        }
      } else {
        const attempted = await this.gateway._attemptTraeRecovery(reason);
        if (!attempted) {
          this.logger.warn?.(`[${this._label}] _attemptTraeRecovery returned false (cooldown/binary/giveup)`);
          this._emitHealthEvent('recovery-skip', { source, attempt: this._consecutiveFailures });
          return this._maybeGiveUp(source, { ok: false, reason: 'gateway-skip' });
        }
        // _attemptTraeRecovery waits for the CDP surface, so discover + connect
        // should normally succeed. Still guard against race conditions.
        const { discoverTarget, connectToTarget } = require('./discovery');
        const { DomDriver } = require('./dom-driver');
        const discovered = await discoverTarget();
        newClient = await connectToTarget(discovered, discovered.client);
        await this._replaceClient(newClient, new DomDriver(newClient));
        recoveryOk = true;
      }
    } catch (err) {
      this.logger.error?.(`[${this._label}] auto-recovery failed: ${err && err.message}`);
      this._emitHealthEvent('recovery-error', { source, attempt: this._consecutiveFailures, error: err && err.message });
    } finally {
      this._recovering = false;
    }

    if (recoveryOk) {
      this._consecutiveFailures = 0;
      this._emitHealthEvent('recovery-success', { source });
      this.logger.log?.(`[${this._label}] auto-recovery succeeded`);
      return { ok: true };
    }

    if (this._consecutiveFailures >= this.maxRecoveries) {
      this._stopped = true;
      if (this._probeTimer) {
        clearInterval(this._probeTimer);
        this._probeTimer = null;
      }
      this._emitHealthEvent('auto-recovery-giveup', { source, attempts: this._consecutiveFailures });
      this.logger.error?.(`[${this._label}] auto-recovery giving up after ${this._consecutiveFailures} attempts`);
      return { ok: false, reason: 'giveup' };
    }

    return { ok: false, reason: 'recovery-failed' };
  }

  /**
   * Apply the giveup rule uniformly to early-return skip paths. Returns the
   * payload the caller would have returned; if the failure count crosses
   * maxRecoveries, also flips the watcher into stopped state and emits the
   * giveup event.
   */
  _maybeGiveUp(source, payload) {
    if (this._consecutiveFailures >= this.maxRecoveries) {
      this._stopped = true;
      if (this._probeTimer) {
        clearInterval(this._probeTimer);
        this._probeTimer = null;
      }
      this._emitHealthEvent('auto-recovery-giveup', { source, attempts: this._consecutiveFailures });
      this.logger.error?.(`[${this._label}] auto-recovery giving up after ${this._consecutiveFailures} attempts`);
      return { ok: false, reason: 'giveup' };
    }
    return payload;
  }

  async _replaceClient(newClient, newDriver) {
    const oldClient = this._client;
    const gateway = this.gateway;

    if (oldClient && typeof oldClient.close === 'function') {
      try {
        await oldClient.close();
      } catch (e) {
        this.logger.warn?.(`[${this._label}] old client close failed (continuing): ${e.message}`);
      }
    }
    if (gateway) {
      gateway.client = newClient;
      gateway.driver = newDriver;
    }
    this.start(newClient);
  }

  _emitHealthEvent(type, data) {
    try {
      this.emit('health-event', { type, ...data, ts: Date.now() });
    } catch { /* listener errors must not break the watcher */ }
    if (this.gateway && this.gateway.globalMetrics && typeof this.gateway.globalMetrics.recordError === 'function') {
      // recordError expects a type label; we use a dedicated namespace.
      try {
        this.gateway.globalMetrics.recordError(`cdp_auto_recover:${type}`);
      } catch { /* metrics must never break the watcher */ }
    }
  }

  get state() {
    return {
      enabled: this.enabled,
      running: !!this._client && !this._stopped,
      consecutiveFailures: this._consecutiveFailures,
      probeIntervalMs: this.probeIntervalMs,
      maxRecoveries: this.maxRecoveries,
      stopped: this._stopped
    };
  }
}

function summarize(data) {
  if (!data) return 'null';
  if (data.error) {
    const err = data.error;
    if (err && err.message) return `error=${err.message}`;
    return `error=${String(err)}`;
  }
  if (typeof data.code !== 'undefined') {
    return `code=${data.code}`;
  }
  try {
    return JSON.stringify(data).slice(0, 200);
  } catch {
    return 'unserializable';
  }
}

module.exports = {
  CDPHealthWatcher,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_MAX_RECOVERIES,
  DEFAULT_PROBE_TIMEOUT_MS,
  PROBE_METHOD
};
