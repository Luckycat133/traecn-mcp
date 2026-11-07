'use strict';

const { sleep } = require('../shared/utils');
const { TraeCNAutomationError } = require('./errors');
const { evaluate, evaluateJSON } = require('./browser-dom');

/**
 * TerminalDriver — drive TraeCN's integrated terminal panel.
 *
 * Implementation strategy:
 *  - Open / close / new terminal via CommandPalette (VS Code command IDs).
 *  - Send input via the xterm DOM: dispatch keyboard events to the
 *    xterm-helper-textarea (hidden, attached for IME input).
 *  - Read output via the xterm-rows innerText.
 *  - Track multiple terminals by aria-label / title in the terminal tab list.
 */
class TerminalDriver {
  constructor(client, config = {}, deps = {}) {
    this.client = client;
    this.config = config;
    this.palette = deps.palette || null;
  }

  setPalette(palette) {
    this.palette = palette;
  }

  _viaPalette(commandId) {
    if (!this.palette) {
      throw new TraeCNAutomationError('CommandPaletteDriver required', 'PALETTE_REQUIRED', { commandId });
    }
    return this.palette.run(commandId);
  }

  // ── Open / close / new (command palette) ───────────────────────────

  toggleTerminal() { return this._viaPalette('workbench.action.terminal.toggleTerminal'); }
  newTerminal() { return this._viaPalette('workbench.action.terminal.new'); }
  killTerminal() { return this._viaPalette('workbench.action.terminal.kill'); }
  clearTerminal() { return this._viaPalette('workbench.action.terminal.clear'); }
  splitTerminal() { return this._viaPalette('workbench.action.terminal.split'); }
  focusTerminal() { return this._viaPalette('workbench.action.terminal.focus'); }

  // ── State / read (DOM) ──────────────────────────────────────────────

  /**
   * Get a snapshot of the current terminal state.
   */
  async snapshot() {
    try {
      return await evaluateJSON(
        this.client,
        `() => {
          const wrappers = document.querySelectorAll('.terminal-wrapper');
          if (!wrappers.length) return { ok: false, error: 'no terminal' };
          const active = Array.from(wrappers).find(w => w.offsetParent !== null) || wrappers[0];
          const xterm = active.querySelector('.xterm');
          const rows = active.querySelector('.xterm-rows');
          const tabs = Array.from(document.querySelectorAll('[class*="terminal-tab"]')).map(t => ({
            title: t.title || t.getAttribute('aria-label') || (t.innerText || '').trim(),
            active: (t.className || '').includes('active') || t.getAttribute('aria-selected') === 'true'
          }));
          return {
            ok: true,
            present: true,
            output: rows ? (rows.innerText || '').slice(-8000) : '',
            rowCount: rows ? rows.querySelectorAll('.xterm-rows > div').length : 0,
            tabs
          };
        }`
      );
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Get the last N lines of the active terminal.
   */
  async tail(lines = 50) {
    const snap = await this.snapshot();
    if (!snap.ok) return snap;
    const all = (snap.output || '').split('\n');
    return {
      ok: true,
      tail: all.slice(-Math.max(1, lines)).join('\n'),
      totalLines: all.length
    };
  }

  // ── Send input ──────────────────────────────────────────────────────

  /**
   * Send text input to the active terminal. Types each character via
   * Input.insertText (works for plain ASCII; for special keys use sendKey).
   */
  async send(text) {
    if (typeof text !== 'string' || !text) {
      throw new TraeCNAutomationError('send requires non-empty string', 'INVALID_INPUT', {});
    }
    // Make sure terminal is focused
    const focused = await this._focusActiveTerminal();
    if (!focused) {
      throw new TraeCNAutomationError('No terminal to focus', 'NO_TERMINAL', {});
    }
    // Insert text in one go (much faster than per-char)
    await this.client.send('Input.insertText', { text });
    await sleep(60);
    return { ok: true, length: text.length };
  }

  /**
   * Send text followed by Enter.
   */
  async sendLine(text) {
    if (text !== undefined && text !== null) {
      await this.send(String(text));
    }
    await this.sendKey('Enter', 'Enter', 13);
    return { ok: true };
  }

  /**
   * Send a single key with the right key/code/windowsVirtualKeyCode.
   * Useful for: Enter, Escape, Ctrl+C, etc.
   */
  async sendKey(key, code, wvk, modifiers = 0) {
    const focused = await this._focusActiveTerminal();
    if (!focused) {
      throw new TraeCNAutomationError('No terminal to focus', 'NO_TERMINAL', {});
    }
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, windowsVirtualKeyCode: wvk, modifiers
    });
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: wvk, modifiers
    });
    return { ok: true, key };
  }

  /**
   * Send Ctrl+C (SIGINT) to the terminal.
   */
  async sendCtrlC() { return this.sendKey('c', 'KeyC', 67, 2); }

  /**
   * Send Ctrl+D (EOF).
   */
  async sendCtrlD() { return this.sendKey('d', 'KeyD', 68, 2); }

  /**
   * Send Ctrl+L (clear screen in many shells).
   */
  async sendCtrlL() { return this.sendKey('l', 'KeyL', 76, 2); }

  /**
   * Send Ctrl+Z (SIGTSTP).
   */
  async sendCtrlZ() { return this.sendKey('z', 'KeyZ', 90, 2); }

  /**
   * Switch to a terminal tab by its title (zsh/1, bash/2, etc).
   */
  async selectTab(title) {
    if (!this.palette && !title) {
      throw new TraeCNAutomationError('title required', 'INVALID_INPUT', {});
    }
    const action = await evaluate(
      this.client,
      '(title) => { const tabs = document.querySelectorAll(\'[class*="terminal-tab"]\'); for (const t of tabs) { const tabTitle = t.title || t.getAttribute("aria-label") || (t.innerText || "").trim(); if (tabTitle === title) { t.click(); return "clicked: " + tabTitle; } } return "not found"; }',
      [title]
    );
    return { ok: action !== 'not found', action };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  async _focusActiveTerminal() {
    return evaluate(
      this.client,
      `() => {
        const wrappers = document.querySelectorAll('.terminal-wrapper');
        for (const w of wrappers) {
          if (w.offsetParent === null) continue;
          const ta = w.querySelector('.xterm-helper-textarea');
          if (ta) { ta.focus(); return true; }
          // Fallback: click in the terminal area
          w.click();
          return true;
        }
        return false;
      }`
    );
  }
}

module.exports = { TerminalDriver };
