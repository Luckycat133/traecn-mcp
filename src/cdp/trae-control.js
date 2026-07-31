'use strict';

/**
 * TraeControl — extracted from Gateway.
 *
 * Owns the Trae-process recovery policy. Encapsulates the cooldown, the
 * "find binary / detect running / restart or relaunch" decision tree, and
 * the polling loop that waits for the CDP surface to come back up.
 *
 * The setup-wizard part of _ensureConnection stays on Gateway because it
 * touches the Driver / Client lifecycle. TraeControl is only responsible
 * for *process-level* recovery (kill / relaunch the Trae CN binary).
 */

const { findTraeCNBinary, isTraeCNRunning, restartTraeCNWithDebug, startTraeCN, getQuickstartConfig } = require('../config/quickstart');
const { discoverTarget } = require('./discovery');
const { getEnvWithFallback } = require('../shared/utils');
const { runtimeDefault } = require('../config/runtime-schema');

class TraeControl {
  constructor({
    configManager = null,
    isMockBridge = () => false,
    autoStartTrae = false,
    recoveryCooldownMs = 30000,
    recoveryWaitMs = 60000,
    logger = console,
    setTimeoutImpl = setTimeout,
  } = {}) {
    this.configManager = configManager;
    this.isMockBridge = typeof isMockBridge === 'function' ? isMockBridge : () => Boolean(isMockBridge);
    this.autoStartTrae = Boolean(autoStartTrae);
    this.recoveryCooldownMs = recoveryCooldownMs;
    this.recoveryWaitMs = recoveryWaitMs;
    this.logger = logger;
    this._setTimeoutImpl = setTimeoutImpl;
    this.lastRecoveryAt = 0;
  }

  /**
   * Whether a recovery is allowed right now (cooldown window has elapsed).
   */
  canRecover() {
    return Date.now() - this.lastRecoveryAt >= this.recoveryCooldownMs;
  }

  /**
   * Probe whether the underlying Trae process is currently running.
   * Delegates to the quickstart helper so the policy lives in one place.
   */
  isRunning() {
    try {
      return isTraeCNRunning();
    } catch {
      return false;
    }
  }

  /**
   * Attempt to recover Trae. Returns true if the CDP surface came back
   * within `recoveryWaitMs`, false otherwise.
   *
   * Honors the same env flags as the previous Gateway method:
   *   - TRAECN_TRAE_RECOVERY_NEW_INSTANCE (1 = force fresh profile)
   *   - TRAECN_RECOVERY_KILL_RUNNING (1 = kill existing Trae + relaunch)
   *   - TRAECN_REMOTE_DEBUGGING_PORT (override the default debug port)
   *
   * `onProgress` is an optional callback invoked once per poll iteration
   * with the elapsed-ms value. Useful for tests that want to verify the
   * retry loop without waiting the full timeout.
   */
  async attemptRecovery(reason, { onProgress } = {}) {
    if (this.isMockBridge() || !this.autoStartTrae) return false;

    if (!this.canRecover()) return false;
    this.lastRecoveryAt = Date.now();

    const binPath = findTraeCNBinary();
    if (!binPath) {
      this.logger.warn('[TraeControl] recovery skipped: binary not found');
      return false;
    }

    const quickstart = getQuickstartConfig();
    const requestedPort = getEnvWithFallback(
      'TRAECN_REMOTE_DEBUGGING_PORT',
      'TRAE_REMOTE_DEBUGGING_PORT',
      quickstart.remoteDebuggingPort || runtimeDefault('TRAECN_REMOTE_DEBUGGING_PORT')
    );
    process.env.TRAECN_REMOTE_DEBUGGING_PORT = requestedPort;

    try {
      const running = isTraeCNRunning();
      const recoveryNewInstance = getEnvWithFallback(
        'TRAECN_TRAE_RECOVERY_NEW_INSTANCE',
        'TRAE_TRAE_RECOVERY_NEW_INSTANCE',
        '0'
      ) === '1';
      // TRAECN_RECOVERY_KILL_RUNNING=1: aggressively kill the existing
      // TraeCN and relaunch with the debug port. Off by default so we
      // never trample an interactive user session; opt in for unattended
      // automation where lost session state is acceptable.
      const killRunning = getEnvWithFallback(
        'TRAECN_RECOVERY_KILL_RUNNING',
        'TRAE_RECOVERY_KILL_RUNNING',
        '0'
      ) === '1';

      if (running && !recoveryNewInstance && !killRunning) {
        this.logger.warn('[TraeControl] recovery skipped: normal Trae is already running without a reachable CDP endpoint; restart Trae CN with remote debugging enabled and existing profile.');
        return false;
      }

      let launched = null;
      let quit = null;
      if (killRunning && running) {
        // Use the canonical quit + relaunch path so the new instance
        // reuses the same profile and CDP port — no zombie process.
        const result = await restartTraeCNWithDebug({ binPath });
        quit = result.quit;
        launched = result.launched;
      } else {
        launched = await startTraeCN({
          binPath,
          newInstance: recoveryNewInstance,
          useIsolatedProfile: quickstart.profileMode === 'existing' ? false : quickstart.useIsolatedProfile
        });
      }
      this.logger.log('[TraeControl] recovery launched:', {
        reason: reason?.message || String(reason || 'unknown'),
        requestedPort,
        profileMode: quickstart.profileMode,
        recoveryNewInstance,
        killRunning,
        alreadyRunning: running,
        quit: quit ? { ok: quit.ok, alreadyStopped: quit.alreadyStopped } : null,
        pid: launched && launched.pid
      });
    } catch (err) {
      this.logger.error('[TraeControl] recovery failed:', err.message);
      return false;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.recoveryWaitMs) {
      try {
        await discoverTarget();
        return true;
      } catch (err) {
        if (typeof onProgress === 'function') {
          try { onProgress({ elapsedMs: Date.now() - startedAt, error: err.message }); } catch { /* ignore */ }
        }
        await new Promise(resolve => this._setTimeoutImpl(resolve, 1500));
      }
    }
    this.logger.warn('[TraeControl] recovery timed out waiting for CDP surface');
    return false;
  }
}

module.exports = { TraeControl };
