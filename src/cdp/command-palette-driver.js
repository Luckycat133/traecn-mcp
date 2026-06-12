'use strict';

const { sleep, safeJsValue } = require('../shared/utils');
const { TraeCNAutomationError } = require('./errors');
const dom = require('./browser-dom');

/**
 * CommandPaletteDriver — drives the VS Code command palette to execute any
 * registered commandId without DOM click brittleness. This is the universal
 * fallback that makes every VS Code / TraeCN / TraeCN-extension command
 * invocable by stable IDs.
 *
 * Implementation: open QuickOpen with `workbench.action.showCommands`
 * (triggered by Ctrl/Cmd+Shift+P), type the command ID, press Enter.
 * The page's Monaco/VSC workbench handles the rest.
 *
 * Common command IDs (stable, no monkey-patching needed):
 *   workbench.action.files.save
 *   workbench.action.files.saveAll
 *   workbench.action.files.newUntitledFile
 *   workbench.action.closeActiveEditor
 *   workbench.action.closeAllEditors
 *   workbench.action.terminal.toggleTerminal
 *   workbench.action.terminal.new
 *   workbench.action.quickOpen
 *   workbench.action.gotoLine
 *   workbench.action.findInFiles
 *   workbench.view.explorer
 *   workbench.view.search
 *   workbench.view.scm
 *   workbench.view.extensions
 *   workbench.action.debug.start
 *   workbench.action.debug.stop
 *   workbench.action.debug.run
 *   workbench.action.debug.stepOver
 *   workbench.action.debug.stepInto
 *   workbench.action.debug.stepOut
 *   workbench.action.debug.continue
 *   workbench.view.debug.state
 *   editor.action.formatDocument
 *   editor.action.formatSelection
 *   editor.action.commentLine
 *   editor.action.copyLinesDownAction
 *   editor.action.moveLinesUpAction
 *   editor.action.insertCursorAbove
 *   editor.action.insertCursorBelow
 *   editor.action.expandLineSelection
 *   editor.fold
 *   editor.unfold
 *   editor.foldAll
 *   editor.unfoldAll
 *   editor.action.showHover
 *   editor.action.revealDefinition
 *   editor.action.peekDefinition
 *   editor.action.referenceSearch.trigger
 *   editor.action.rename
 *   editor.action.triggerSuggest
 *   workbench.action.problems.focus
 *   workbench.action.output.toggleOutput
 *   workbench.action.tasks.runTask
 *   workbench.action.tasks.build
 *   workbench.action.tasks.test
 *   workbench.action.files.revert
 *   workbench.action.files.revertAll
 *   workbench.action.splitEditor
 *   workbench.action.toggleSidebarVisibility
 *   workbench.action.togglePanel
 *   workbench.action.showCommands
 *   git.commit
 *   git.commitAll
 *   git.push
 *   git.pull
 *   git.sync
 *   git.checkout
 *   git.branch
 *   git.clone
 *   git.init
 *   git.status
 *   git.log
 *   git.stash
 *   git.stashPop
 *   workbench.action.files.copyPathOfActiveFile
 *   workbench.action.files.revealActiveFileInExplorer
 *   workbench.action.reloadWindow
 *   workbench.action.quit
 */
class CommandPaletteDriver {
  constructor(client, config = {}) {
    this.client = client;
    this.config = config;
  }

  /**
   * Ensure the `__radixClick` helper is injected (shared with SettingsDriver).
   * Most actions use keyboard, but a few need DOM clicks.
   */
  async _ensureClickHelper() {
    await this.client.send('Runtime.evaluate', {
      expression: `(function() {
        if (window.__radixClick) return;
        window.__radixClick = function(el) {
          if (!el) return;
          el.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true, button: 0}));
          el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0}));
          el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, button: 0}));
          el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
        };
      })()`,
      returnByValue: true
    });
  }

  /**
   * Open the command palette (Quick Open > Show Commands).
   * Triggered by `Cmd+Shift+P` (mac) / `Ctrl+Shift+P` (other).
   * Retries up to 3 times if the first attempt doesn't open the widget.
   */
  async open() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Use the keyboard shortcut to avoid relying on a menu
      await this._dispatchKeyCombo('P', ['Shift', 'Meta']);
      await sleep(600);
      let visible = await this._isPaletteOpen();
      if (!visible) {
        // Fallback: try Ctrl+Shift+P
        await this._dispatchKeyCombo('P', ['Shift', 'Control']);
        await sleep(600);
        visible = await this._isPaletteOpen();
      }
      if (visible) {
        // Give the input element a moment to mount inside the widget
        await sleep(250);
        return true;
      }
      // wait before retry
      await sleep(300);
    }
    return false;
  }

  /**
   * Close the command palette if open.
   */
  async close() {
    if (await this._isPaletteOpen()) {
      await this._dispatchKey('Escape', 'Escape');
      await sleep(200);
    }
  }

  /**
   * Run a command by ID. Opens palette, types the command, presses Enter.
   *
   * @param {string} commandId The command ID to execute.
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=5000] Time to wait for palette to open.
   * @returns {Promise<{ok: boolean, commandId: string, paletteOpened: boolean}>}
   */
  async run(commandId, opts = {}) {
    if (typeof commandId !== 'string' || !commandId) {
      throw new TraeCNAutomationError('commandId is required', 'INVALID_COMMAND_ID', {});
    }
    const timeoutMs = opts.timeoutMs || 5000;

    const opened = await this.open();
    if (!opened) {
      throw new TraeCNAutomationError('Command palette did not open', 'PALETTE_OPEN_FAILED', {});
    }

    // Clear existing input, then type commandId
    const input = await this._findPaletteInput();
    if (!input) {
      throw new TraeCNAutomationError('Command palette input not found', 'PALETTE_INPUT_MISSING', {});
    }

    // Clear and type
    await this._setInputValue(input, '');
    await this._setInputValue(input, commandId);
    await sleep(300);

    // Press Enter
    await this._dispatchKey('Enter', 'Enter', 13);
    await sleep(300);

    return { ok: true, commandId, paletteOpened: true };
  }

  /**
   * Run a sequence of commands in order. Useful for compound operations like
   * "open search then focus input".
   */
  async runSequence(commandIds) {
    const results = [];
    for (const id of commandIds) {
      results.push(await this.run(id));
    }
    return results;
  }

  /**
   * Whether the command palette quick-input is currently visible.
   */
  async _isPaletteOpen() {
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const q = document.querySelector('.quick-input-widget, [class*="quick-input-widget"]');
        if (!q) return false;
        const r = q.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && q.offsetParent !== null;
      })()`,
      returnByValue: true
    });
    return !!r.result.value;
  }

  /**
   * Get the text input element inside the command palette.
   */
  async _findPaletteInput() {
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const inputs = document.querySelectorAll('.quick-input-widget input.input, .quick-input-widget textarea, .quick-input-widget [contenteditable="true"]');
        if (!inputs.length) return null;
        // Return the first one with a stable identifier
        for (const i of inputs) {
          if (i.offsetParent !== null) return true;
        }
        return true;
      })()`,
      returnByValue: true
    });
    return !!r.result.value;
  }

  /**
   * Set the value of the palette input via DOM dispatch.
   * (The palette uses contenteditable, so we need to use insertText.)
   */
  async _setInputValue(hasInput, text) {
    // Use Runtime.evaluate to find and set the palette input directly.
    const safeText = safeJsValue(text);
    await this.client.send('Runtime.evaluate', {
      expression: `(function() {
        const inputs = document.querySelectorAll('.quick-input-widget input.input, .quick-input-widget textarea, .quick-input-widget [contenteditable="true"]');
        for (const inp of inputs) {
          if (inp.offsetParent === null) continue;
          if (inp.tagName === 'INPUT' || inp.tagName === 'TEXTAREA') {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
                        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
            if (setter && setter.set) {
              setter.set.call(inp, ${safeText});
              inp.dispatchEvent(new Event('input', { bubbles: true }));
            }
          } else if (inp.getAttribute('contenteditable') === 'true') {
            inp.textContent = ${safeText};
            inp.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return true;
        }
        return false;
      })()`,
      returnByValue: true
    });
  }

  /**
   * Dispatch a single key event with mac/win modifiers.
   */
  async _dispatchKey(key, code, windowsVirtualKeyCode) {
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: windowsVirtualKeyCode || 0
    });
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: windowsVirtualKeyCode || 0
    });
  }

  /**
   * Dispatch a key combo like Cmd+Shift+P. `keys` is an array of modifier
   * names from ['Meta','Control','Shift','Alt'] and a final non-modifier.
   * Order: meta keys down, then key, then key up, meta up reverse.
   */
  async _dispatchKeyCombo(letter, modifiers = []) {
    const mod = (m) => ({ Meta: 1, Control: 2, Shift: 4, Alt: 8 }[m] || 0);
    const modSum = modifiers.reduce((s, m) => s | mod(m), 0);
    const code = 'Key' + letter.toUpperCase();
    const wvk = letter.toUpperCase().charCodeAt(0);

    // Modifier downs
    for (const m of modifiers) {
      await this.client.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        modifiers: mod(m),
        key: m,
        code: m === 'Shift' ? 'ShiftLeft' : m === 'Meta' ? 'MetaLeft' : m === 'Control' ? 'ControlLeft' : 'AltLeft'
      });
    }
    // Key down + char
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: modSum,
      key: letter,
      code,
      windowsVirtualKeyCode: wvk
    });
    if (/^[a-zA-Z]$/.test(letter)) {
      await this.client.send('Input.dispatchKeyEvent', {
        type: 'char',
        modifiers: modSum,
        text: letter
      });
    }
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: modSum,
      key: letter,
      code,
      windowsVirtualKeyCode: wvk
    });
    // Modifier ups (reverse)
    for (const m of [...modifiers].reverse()) {
      await this.client.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        modifiers: 0,
        key: m,
        code: m === 'Shift' ? 'ShiftLeft' : m === 'Meta' ? 'MetaLeft' : m === 'Control' ? 'ControlLeft' : 'AltLeft'
      });
    }
  }
}

module.exports = { CommandPaletteDriver };
