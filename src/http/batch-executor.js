'use strict';

/**
 * BatchExecutor — owns the batch execution loop and concurrency clamping
 * concerns for the delegated task queue.
 *
 * Responsibilities:
 *   - Model-probe interval clamping (modelProbeIntervalMs) — keeps the
 *     probe cadence inside sane bounds regardless of what the caller asks.
 *   - backgroundResultRetryMode — decides whether a freshly-collected
 *     result warrants a resubmit, a re-collect, or no action.
 *   - Per-result helpers (_isReviewableTaskResult, _isSuccessfulTaskResult,
 *     _isEchoedTaskResult, _hasStrongCompletionEvidence) used by the
 *     retry-mode decision.
 *   - createQueuedTask — a no-op factory hook (the full body still lives
 *     on Gateway, but tests / callers can stub it cleanly).
 *
 * The class is stateless; it exists as a composition point so the
 * orchestrator can wire dependencies in one place. It delegates
 * classification work to the QueueStateMachine via dependency injection.
 */

const DEFAULT_MODEL_PROBE_INTERVAL_MS = 60000;

class BatchExecutor {
  constructor({
    logger = console,
    stateMachine = null,
  } = {}) {
    this.logger = logger;
    this.stateMachine = stateMachine;
  }

  // ── model-probe interval helper ────────────────────────────────────────

  modelProbeIntervalMs(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MODEL_PROBE_INTERVAL_MS;
    return Math.max(15000, Math.min(parsed, 10 * 60 * 1000));
  }

  // ── result retry mode (used by background poller + finalizer) ─────────

  /**
   * Decide whether a freshly-collected result warrants a retry, a re-collect,
   * or no action. Returns:
   *   - 'resubmit' → send the task again (driver returned a failed result)
   *   - 'collect'  → call collectResponse again (transient/timed out)
   *   - null       → no retry needed, proceed with finalize
   */
  backgroundResultRetryMode(result, task = null) {
    if (!result || result.needsApproval) return null;
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (result.modelError || this._isFailedResultText(text)) return 'resubmit';
    if (this._isEchoedTaskResult(result, task)) return 'collect';
    const needsWorkflowCheckpoint = task?.reviewRequired === true
      || task?.autoContinue === true
      || (Array.isArray(task?.followupTasks) && task.followupTasks.length > 0);
    if (needsWorkflowCheckpoint && !this._isReviewableTaskResult(result, task)) return 'collect';
    if (this._isSuccessfulTaskResult(result, task)) return null;
    if (result.timedOut || result.truncated || result.streaming || result.stable !== true || !this._hasMeaningfulResultText(text)) return 'collect';
    return null;
  }

  // Keep these helpers inline because they're only used by
  // backgroundResultRetryMode — they used to live as private methods on
  // Gateway and only ever fed into the retry-mode decision.

  _isReviewableTaskResult(result, task = null) {
    if (!result || result.streaming || result.truncated || result.modelError) return false;
    if (result.reviewGatePending && result.stable !== true) return false;
    if (result.stable !== true && result.timedOut !== true) return false;
    return (this._isReviewableResult(result) || this._hasStrongCompletionEvidence(result?.text))
      && !this._isFailedResultText(result?.text || '')
      && !this._isEchoedTaskResult(result, task);
  }

  _isSuccessfulTaskResult(result, task = null) {
    if (!result || result.reviewGatePending || result.streaming || result.truncated || result.modelError) return false;
    if (result.stable !== true && result.timedOut !== true) return false;
    return (this._isSuccessfulResult(result) || this._hasStrongCompletionEvidence(result?.text))
      && !this._isFailedResultText(result?.text || '')
      && !this._isEchoedTaskResult(result, task);
  }

  _isReviewableResult(result) {
    return this.stateMachine ? this.stateMachine.isReviewableResult(result) : false;
  }

  _isSuccessfulResult(result) {
    return this.stateMachine ? this.stateMachine.isSuccessfulResult(result) : false;
  }

  _isFailedResultText(text) {
    return this.stateMachine ? this.stateMachine._isFailedResultText(text) : false;
  }

  _hasMeaningfulResultText(text) {
    return this.stateMachine ? this.stateMachine._hasMeaningfulResultText(text) : false;
  }

  _isEchoedTaskResult(result, task = null) {
    const text = typeof result?.text === 'string' ? result.text : '';
    const taskText = typeof task?.task === 'string' ? task.task : '';
    if (text.length < 40 || taskText.length < 40) return false;

    const normalize = value => String(value || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}\s/._:-]+/gu, '')
      .trim();
    const normalizedText = normalize(text);
    const normalizedTask = normalize(taskText);
    if (normalizedText.length < 40 || normalizedTask.length < 40) return false;

    if (normalizedText.includes(normalizedTask) && normalizedText.length <= normalizedTask.length + 120) {
      return true;
    }

    const taskPrefix = normalizedTask.slice(0, Math.min(normalizedTask.length, 160));
    return normalizedText.includes(taskPrefix) && normalizedText.length <= normalizedTask.length * 1.25;
  }

  _hasStrongCompletionEvidence(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    // 120 = minimum text length (chars) we trust as completion evidence;
    // shorter output is too thin to prove the task actually finished.
    if (value.length < 120) return false;
    // "Strong completion" phrases (Chinese + English): completion summary /
    // final report, "all N tests passed", "N/N 已完成…总结", etc. Any one
    // match counts as evidence that the agent reported a real completion
    // rather than just echoing progress.
    return [
      /任务完成|完成总结|最终报告|final report|delivery summary|completed successfully/i,
      /(?:all|全部)\s+\d+\s+tests?\s+pass(?:ed)?/i,
      /all tests pass(?:ed)?|所有测试通过|测试已通过/i,
      /\d+\s*\/\s*\d+\s*已完成.*(?:final report|summary|总结|报告)/i,
      /(?:tests?|测试).{0,80}(?:pass(?:ed)?|通过|0\s+fail)/i
    ].some(pattern => pattern.test(value));
  }

  // ── task creation (placeholder for the bigger migration in A4) ─────────
  //
  // The full `_createQueuedTask` body still lives on Gateway because it
  // touches many Gateway-only helpers (driver, history, persist, etc.).
  // We expose a no-op factory hook here so callers can stub it cleanly
  // in tests without hitting Gateway internals.

  createQueuedTask(body, queueStatus) {
    throw new Error('createQueuedTask must be supplied via the owning gateway; this is a marker for A2 only');
  }
}

module.exports = { BatchExecutor };