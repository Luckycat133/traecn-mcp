'use strict';

const { sleep, safeJsValue } = require('../shared/utils');
const { TraeCNAutomationError } = require('./errors');
const { BaseDriver } = require('./base-driver');

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
class GitDriver extends BaseDriver {
  constructor(client, config = {}, deps = {}) {
    super(client, config, deps);
    this.exec = deps.exec || null; // optional: function(cmd, args, opts) => Promise<{stdout,stderr,code}>
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
  async commitWithMessage(message, opts = {}) {
    if (typeof message !== 'string' || !message) {
      throw new TraeCNAutomationError('commit message is required', 'INVALID_INPUT', {});
    }
    // Open SCM panel
    await this._viaPalette('workbench.view.scm');
    await sleep(300);

    // Find the commit input
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(function() {
        const input = document.querySelector('.scm-viewlet textarea, .scm-editor textarea, [class*="commit-input"] textarea, [class*="scm-editor"] textarea, .scm-editor input.input');
        if (!input) return false;
        const tag = input.tagName;
        const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (!descriptor || typeof descriptor.set !== 'function') return false;
        descriptor.set.call(input, ${safeJsValue(message)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
      returnByValue: true
    });
    if (!r.result.value) {
      throw new TraeCNAutomationError('SCM commit input not found', 'SCM_INPUT_MISSING', {});
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
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const scm = document.querySelector('.scm-viewlet');
        if (!scm) return JSON.stringify({ ok: false, error: 'scm not open' });
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
        return JSON.stringify({ ok: true, items, branch });
      })()`,
      returnByValue: true
    });
    try { return JSON.parse(r.result.value); } catch { return { ok: false, error: 'parse failed' }; }
  }

  /**
   * Read the current branch name (from status bar or SCM header).
   */
  async readCurrentBranch() {
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const els = document.querySelectorAll('.statusbar [aria-label*="Git" i], .statusbar [title*="Git" i]');
        for (const e of els) {
          const t = e.getAttribute('aria-label') || e.title || '';
          const m = t.match(/\\b([a-z0-9._\\/-]+)/i);
          if (m) return m[1];
        }
        return null;
      })()`,
      returnByValue: true
    });
    return r.result.value;
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
