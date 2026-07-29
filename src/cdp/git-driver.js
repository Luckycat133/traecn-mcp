'use strict';

const { sleep } = require('../shared/utils');
const { TraeCNAutomationError } = require('./errors');
const { evaluate, evaluateJSON } = require('./browser-dom');

/**
 * GitDriver — drive Source Control (Git) operations.
 *
 * Implementation strategy:
 *  - For "open panel / status / sync / checkout" etc, use CommandPalette
 *    with VS Code Git extension command IDs.
 *  - For "commit" with a message, open SCM view, fill commit box, click
 *    commit button (or run `git.commit`).
 *  - For "stage all" / "unstage all", use command palette (`git.stageAll`,
 *    `git.unstageAll`).
 *  - For low-level read of status / diff, use the in-page SCM view DOM.
 *  - Optionally accepts a `git` child_process dep for direct CLI fallback.
 */
class GitDriver {
  constructor(client, config = {}, deps = {}) {
    this.client = client;
    this.config = config;
    this.palette = deps.palette || null;
    this.exec = deps.exec || null; // optional: function(cmd, args, opts) => Promise<{stdout,stderr,code}>
  }

  setPalette(palette) { this.palette = palette; }

  _viaPalette(commandId) {
    if (!this.palette) {
      throw new TraeCNAutomationError('CommandPaletteDriver required', 'PALETTE_REQUIRED', { commandId });
    }
    return this.palette.run(commandId);
  }

  // ── Open / focus ───────────────────────────────────────────────────

  openSCM() { return this._viaPalette('workbench.view.scm'); }
  focusSCM() { return this._viaPalette('workbench.scm.focus'); }
  refreshSCM() { return this._viaPalette('workbench.scm.action.refresh'); }

  // ── Standard git actions ───────────────────────────────────────────

  stageAll() { return this._viaPalette('workbench.scm.action.stageAll'); }
  unstageAll() { return this._viaPalette('workbench.scm.action.unstageAll'); }
  commit() { return this._viaPalette('workbench.scm.action.commit'); }
  commitAmend() { return this._viaPalette('git.commitAmend'); }
  commitSignedOff() { return this._viaPalette('git.commitSignedOff'); }
  push() { return this._viaPalette('workbench.scm.action.push'); }
  pull() { return this._viaPalette('workbench.scm.action.pull'); }
  sync() { return this._viaPalette('workbench.scm.action.sync'); }
  fetch() { return this._viaPalette('workbench.scm.action.fetch'); }
  clone() { return this._viaPalette('git.clone'); }
  init() { return this._viaPalette('git.init'); }
  checkout() { return this._viaPalette('git.checkout'); }
  branch() { return this._viaPalette('git.branch'); }
  merge() { return this._viaPalette('git.merge'); }
  rebase() { return this._viaPalette('workbench.scm.action.rebase'); }
  stash() { return this._viaPalette('workbench.scm.action.stash'); }
  stashPop() { return this._viaPalette('workbench.scm.action.stashPop'); }
  stashApply() { return this._viaPalette('workbench.scm.action.stashApply'); }
  showOutput() { return this._viaPalette('workbench.scm.action.showOutputChannel'); }
  showLog() { return this._viaPalette('workbench.scm.action.showGraph'); }
  diff() { return this._viaPalette('workbench.scm.action.diff'); }

  // ── Commit with message (in-page) ──────────────────────────────────

  /**
   * Open SCM, type commit message, click commit.
   */
  async commitWithMessage(message, _opts = {}) {
    if (typeof message !== 'string' || !message) {
      throw new TraeCNAutomationError('commit message is required', 'INVALID_INPUT', {});
    }
    // Open SCM panel
    await this._viaPalette('workbench.view.scm');
    await sleep(300);

    // Find the commit input
    const inputFound = await evaluate(
      this.client,
      `(message) => {
        const input = document.querySelector('.scm-viewlet textarea, .scm-editor textarea, [class*="commit-input"] textarea, [class*="scm-editor"] textarea, .scm-editor input.input');
        if (!input) return false;
        const tag = input.tagName;
        const setter = Object.getOwnPropertyDescriptor(
          tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
          'value'
        ).set;
        setter.call(input, message);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }`,
      [message]
    );
    if (!inputFound) {
      throw TraeCNAutomationError('SCM commit input not found', 'SCM_INPUT_MISSING', {});
    }
    await sleep(200);

    // Run commit command
    return this._viaPalette('workbench.scm.action.commit');
  }

  // ── Status / diff (in-page read) ───────────────────────────────────

  /**
   * Read the current SCM view: changed files + their add/modify/delete markers.
   */
  async readStatus() {
    try {
      return await evaluateJSON(
        this.client,
        `() => {
          const scm = document.querySelector('.scm-viewlet');
          if (!scm) return { ok: false, error: 'scm not open' };
          const groups = Array.from(scm.querySelectorAll('.monaco-list-row'));
          const items = groups.slice(0, 500).map(g => {
            const fileName = g.querySelector('.label-name')?.innerText || (g.innerText || '').split('\\n')[0].trim();
            const fileIcon = g.querySelector('[class*="codicon-modified"], [class*="codicon-added"], [class*="codicon-deleted"]')?.className || '';
            const status = /modified/.test(fileIcon) ? 'M'
                         : /added|untracked/.test(fileIcon) ? 'A'
                         : /deleted/.test(fileIcon) ? 'D'
                         : /renamed/.test(fileIcon) ? 'R' : '?';
            return { file: fileName.slice(0, 200), status };
          });
          // Current branch + ahead/behind from the input placeholder or header
          const branchEl = scm.querySelector('.statusbar-item [aria-label*="Git"]') || document.querySelector('.statusbar-item [aria-label*="Git"]');
          const branch = branchEl?.getAttribute('aria-label') || '';
          return { ok: true, items, branch };
        }`
      );
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Read the current branch name (from status bar or SCM header).
   */
  async readCurrentBranch() {
    return evaluate(
      this.client,
      `() => {
        const els = document.querySelectorAll('.statusbar [aria-label*="Git" i], .statusbar [title*="Git" i]');
        for (const e of els) {
          const t = e.getAttribute('aria-label') || e.title || '';
          const m = t.match(/\\b([a-z0-9._\\/-]+)/i);
          if (m) return m[1];
        }
        return null;
      }`
    );
  }

  // ── CLI fallback (optional) ────────────────────────────────────────

  /**
   * If `deps.exec` was injected, run a git command directly.
   * Useful when the IDE git panel can't be reached (e.g. headless mode).
   */
  async execGit(args, opts = {}) {
    if (typeof this.exec !== 'function') {
      return { ok: false, error: 'no exec dep; pass deps.exec to constructor for CLI fallback' };
    }
    try {
      const result = await this.exec('git', args, { cwd: opts.cwd, maxBuffer: 10 * 1024 * 1024 });
      return { ok: true, code: result.code, stdout: result.stdout, stderr: result.stderr };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

module.exports = { GitDriver };
