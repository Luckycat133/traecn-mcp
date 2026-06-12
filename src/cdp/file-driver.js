'use strict';

const { sleep, safeJsValue } = require('../shared/utils');
const { TraeCNAutomationError } = require('./errors');

/**
 * FileDriver — file system operations against the open TraeCN workspace.
 *
 * Implementation strategy:
 *  - For commands like open / close / new / reveal, route through the
 *    CommandPaletteDriver (stable VS Code command IDs).
 *  - For listing trees and reading file content, use the in-page
 *    VS Code workbench service when exposed, otherwise fall back to
 *    direct Monaco model reads.
 *  - All file *content* operations (read/write at path) use a side-channel
 *    to Node-side `fs` (since the IDE's runtime cannot read arbitrary
 *    disk paths outside its sandbox).
 */
class FileDriver {
  constructor(client, config = {}, deps = {}) {
    this.client = client;
    this.config = config;
    this.palette = deps.palette || null;
    this.fs = deps.fs || require('fs').promises; // optional injected for test
    this.path = deps.path || require('path');
  }

  setPalette(palette) {
    this.palette = palette;
  }

  _viaPalette(commandId) {
    if (!this.palette) {
      throw new TraeCNAutomationError('CommandPaletteDriver is required for this operation', 'PALETTE_REQUIRED', { commandId });
    }
    return this.palette.run(commandId);
  }

  // ── Open / close / new (via command palette) ────────────────────────

  /**
   * Open a file by path within the workspace. Opens the Quick Open with the
   * path pre-typed, so the user can confirm.
   */
  async openFileByPath(filePath) {
    if (!this.palette) {
      throw new TraeCNAutomationError('CommandPaletteDriver required for openFileByPath', {
        code: 'PALETTE_REQUIRED'
      });
    }
    await this.palette.open();
    // Quick Open (not command palette) uses Ctrl+P / Cmd+P
    const safe = safeJsValue(filePath);
    await this.client.send('Runtime.evaluate', {
      expression: `(function() {
        const input = document.querySelector('.quick-input-widget input.input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${safe});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
      returnByValue: true
    });
    await sleep(200);
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13
    });
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13
    });
    await sleep(300);
    return { ok: true, filePath };
  }

  closeActive() { return this._viaPalette('workbench.action.closeActiveEditor'); }
  closeAll() { return this._viaPalette('workbench.action.closeAllEditors'); }
  closeOthers() { return this._viaPalette('workbench.action.closeOtherEditors'); }
  newFile() { return this._viaPalette('workbench.action.files.newUntitledFile'); }
  revertFile() { return this._viaPalette('workbench.action.files.revert'); }
  revealInExplorer() { return this._viaPalette('workbench.action.files.revealActiveFileInExplorer'); }
  copyPath() { return this._viaPalette('workbench.action.files.copyPathOfActiveFile'); }
  save() { return this._viaPalette('workbench.action.files.save'); }
  saveAll() { return this._viaPalette('workbench.action.files.saveAll'); }
  saveAs() { return this._viaPalette('workbench.action.files.saveAs'); }

  // ── Tree listing (in-page) ──────────────────────────────────────────

  /**
   * List the current open editors (file paths and languages).
   */
  async listOpenEditors() {
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const editors = window.monaco?.editor?.getEditors?.() || [];
        return JSON.stringify(editors.map(e => {
          const m = e.getModel();
          return {
            id: e.getId(),
            path: m?.uri?.toString?.() || m?.uri?.path || '',
            fsPath: m?.uri?.fsPath || '',
            language: m?.getLanguageId?.(),
            lineCount: m?.getLineCount?.() || 0,
            hasFocus: !!(e.hasTextFocus && e.hasTextFocus())
          };
        }));
      })()`,
      returnByValue: true
    });
    try { return JSON.parse(r.result.value); } catch { return []; }
  }

  /**
   * List the files visible in the Explorer panel.
   * Reads from the rendered tree DOM, not a reliable source for very large trees.
   */
  async listExplorerVisible() {
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const tree = document.querySelector('.explorer-viewlet .monaco-list, .explorer-viewlet [class*="list"]');
        if (!tree) return JSON.stringify({ ok: false, error: 'no explorer' });
        const rows = Array.from(tree.querySelectorAll('.monaco-list-row, [role="treeitem"]'));
        const items = rows.slice(0, 500).map(r => ({
          label: (r.querySelector('.label-name')?.innerText || r.innerText || '').trim().slice(0, 200),
          aria: r.getAttribute('aria-label') || '',
          expanded: r.getAttribute('aria-expanded') === 'true'
        }));
        return JSON.stringify({ ok: true, items });
      })()`,
      returnByValue: true
    });
    try { return JSON.parse(r.result.value); } catch { return { ok: false, error: 'parse failed' }; }
  }

  // ── Direct disk read/write (side-channel) ───────────────────────────

  /**
   * Read a file from the local filesystem. Path can be absolute.
   * Useful for headless: agent reads / writes files outside the IDE workflow.
   */
  async readDisk(filePath) {
    try {
      const data = await this.fs.readFile(filePath, 'utf8');
      return { ok: true, path: filePath, content: data };
    } catch (err) {
      return { ok: false, path: filePath, error: err.message };
    }
  }

  /**
   * Write a file to the local filesystem. Creates or overwrites.
   */
  async writeDisk(filePath, content) {
    try {
      await this.fs.writeFile(filePath, content, 'utf8');
      return { ok: true, path: filePath, length: content.length };
    } catch (err) {
      return { ok: false, path: filePath, error: err.message };
    }
  }

  /**
   * Delete a file from the local filesystem.
   */
  async deleteDisk(filePath) {
    try {
      await this.fs.unlink(filePath);
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, path: filePath, error: err.message };
    }
  }

  /**
   * Create a directory recursively.
   */
  async mkdirDisk(dirPath) {
    try {
      await this.fs.mkdir(dirPath, { recursive: true });
      return { ok: true, path: dirPath };
    } catch (err) {
      return { ok: false, path: dirPath, error: err.message };
    }
  }

  /**
   * Recursively list a directory tree (depth-limited).
   */
  async listTreeDisk(rootPath, opts = {}) {
    const maxDepth = opts.maxDepth || 4;
    const ignore = opts.ignore || ['node_modules', '.git', 'dist', 'build', '.cache', 'coverage', '.next', 'out'];
    const out = [];
    async function walk(dir, depth) {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = await require('fs').promises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        out.push({ type: 'error', path: dir, error: err.message });
        return;
      }
      for (const e of entries) {
        if (ignore.includes(e.name)) continue;
        const full = require('path').join(dir, e.name);
        if (e.isDirectory()) {
          out.push({ type: 'dir', path: full, name: e.name });
          await walk(full, depth + 1);
        } else if (e.isFile()) {
          out.push({ type: 'file', path: full, name: e.name });
        }
      }
    }
    try {
      await walk(rootPath, 0);
      return { ok: true, root: rootPath, entries: out, count: out.length };
    } catch (err) {
      return { ok: false, root: rootPath, error: err.message };
    }
  }

  /**
   * Rename or move a file or directory.
   */
  async renameDisk(oldPath, newPath) {
    try {
      await this.fs.rename(oldPath, newPath);
      return { ok: true, from: oldPath, to: newPath };
    } catch (err) {
      return { ok: false, from: oldPath, to: newPath, error: err.message };
    }
  }
}

module.exports = { FileDriver };
