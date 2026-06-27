'use strict';

const { sleep, safeJsValue } = require('../shared/utils');
const { TraeCNAutomationError } = require('./errors');
const { BaseDriver } = require('./base-driver');
const nodeFs = require('fs');

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
class FileDriver extends BaseDriver {
  constructor(client, config = {}, deps = {}) {
    super(client, config, deps);
    this.fs = deps.fs || require('fs').promises; // optional injected for test
    this.path = deps.path || require('path');
    this.allowUnsafeDiskAccess = config.allowUnsafeDiskAccess === true;
    this.allowedRoots = this._normalizeAllowedRoots(config.fileAllowedRoots || config.diskAllowedRoots);
  }

  // ── Open / close / new (via command palette) ────────────────────────

  /**
   * Open a file by path within the workspace. Opens the Quick Open with the
   * path pre-typed, so the user can confirm.
   */
  async openFileByPath(filePath) {
    this._requirePalette('workbench.action.quickOpen');
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

  _normalizeAllowedRoots(rawRoots) {
    const values = Array.isArray(rawRoots)
      ? rawRoots
      : (typeof rawRoots === 'string' ? rawRoots.split(this.path.delimiter) : []);
    const roots = values
      .map(root => String(root || '').trim())
      .filter(Boolean);

    if (roots.length === 0) {
      roots.push(process.cwd());
    }

    const normalized = [];
    for (const root of roots) {
      const resolved = this.path.resolve(root);
      let real = resolved;
      try {
        real = nodeFs.realpathSync.native(resolved);
      } catch (_) {}
      if (!normalized.includes(real)) normalized.push(real);
    }
    return normalized;
  }

  _pathInsideRoot(candidate, root) {
    const relative = this.path.relative(root, candidate);
    return relative === '' || (!!relative && !relative.startsWith('..') && !this.path.isAbsolute(relative));
  }

  async _realPathForAccess(targetPath) {
    if (this.fs && typeof this.fs.realpath === 'function') {
      try {
        return await this.fs.realpath(targetPath);
      } catch (_) {}
    }

    let parent = this.path.dirname(targetPath);
    while (parent && parent !== this.path.dirname(parent)) {
      if (this.fs && typeof this.fs.realpath === 'function') {
        try {
          const realParent = await this.fs.realpath(parent);
          return this.path.join(realParent, this.path.relative(parent, targetPath));
        } catch (_) {}
      }
      parent = this.path.dirname(parent);
    }
    return null;
  }

  async _resolveDiskPath(inputPath, paramName = 'filePath') {
    if (typeof inputPath !== 'string' || !inputPath.trim()) {
      throw new TraeCNAutomationError(`${paramName} must be a non-empty string`, 'INVALID_PATH', { paramName });
    }

    if (this.allowUnsafeDiskAccess) return inputPath;

    const base = this.allowedRoots[0] || process.cwd();
    const resolved = this.path.resolve(this.path.isAbsolute(inputPath) ? inputPath : this.path.join(base, inputPath));
    const realCandidate = await this._realPathForAccess(resolved);
    const candidateForCheck = realCandidate || resolved;
    const allowed = this.allowedRoots.some(root =>
      this._pathInsideRoot(candidateForCheck, root) || this._pathInsideRoot(resolved, root)
    );
    if (!allowed) {
      throw new TraeCNAutomationError(
        'Disk path is outside allowed roots',
        'PATH_OUTSIDE_ALLOWED_ROOTS',
        { path: resolved, allowedRoots: this.allowedRoots }
      );
    }
    return resolved;
  }

  /**
   * Read a file from the local filesystem. Path can be absolute.
   * Useful for headless: agent reads / writes files outside the IDE workflow.
   */
  async readDisk(filePath) {
    let resolvedPath;
    try {
      resolvedPath = await this._resolveDiskPath(filePath);
      const data = await this.fs.readFile(resolvedPath, 'utf8');
      return { ok: true, path: resolvedPath, content: data };
    } catch (err) {
      return { ok: false, path: resolvedPath || filePath, error: err.message, code: err.code };
    }
  }

  /**
   * Write a file to the local filesystem. Creates or overwrites.
   */
  async writeDisk(filePath, content) {
    let resolvedPath;
    try {
      resolvedPath = await this._resolveDiskPath(filePath);
      await this.fs.writeFile(resolvedPath, content, 'utf8');
      return { ok: true, path: resolvedPath, length: content.length };
    } catch (err) {
      return { ok: false, path: resolvedPath || filePath, error: err.message, code: err.code };
    }
  }

  /**
   * Delete a file from the local filesystem.
   */
  async deleteDisk(filePath) {
    let resolvedPath;
    try {
      resolvedPath = await this._resolveDiskPath(filePath);
      await this.fs.unlink(resolvedPath);
      return { ok: true, path: resolvedPath };
    } catch (err) {
      return { ok: false, path: resolvedPath || filePath, error: err.message, code: err.code };
    }
  }

  /**
   * Create a directory recursively.
   */
  async mkdirDisk(dirPath) {
    let resolvedPath;
    try {
      resolvedPath = await this._resolveDiskPath(dirPath, 'dirPath');
      await this.fs.mkdir(resolvedPath, { recursive: true });
      return { ok: true, path: resolvedPath };
    } catch (err) {
      return { ok: false, path: resolvedPath || dirPath, error: err.message, code: err.code };
    }
  }

  /**
   * Recursively list a directory tree (depth-limited). Symlinks are not
   * followed to avoid infinite loops on circular links.
   */
  async listTreeDisk(rootPath, opts = {}) {
    let resolvedRoot;
    const maxDepth = opts.maxDepth || 4;
    const ignore = opts.ignore || ['node_modules', '.git', 'dist', 'build', '.cache', 'coverage', '.next', 'out'];
    const out = [];
    const fsPromises = this.fs;
    const pathLib = this.path;
    async function walk(dir, depth) {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        out.push({ type: 'error', path: dir, error: err.message });
        return;
      }
      for (const e of entries) {
        if (ignore.includes(e.name)) continue;
        const full = pathLib.join(dir, e.name);
        if (e.isSymbolicLink()) {
          // Record but don't recurse into symlinks — avoids infinite loops
          // on circular symlinks and keeps the tree bounded.
          out.push({ type: 'symlink', path: full, name: e.name });
        } else if (e.isDirectory()) {
          out.push({ type: 'dir', path: full, name: e.name });
          await walk(full, depth + 1);
        } else if (e.isFile()) {
          out.push({ type: 'file', path: full, name: e.name });
        }
      }
    }
    try {
      resolvedRoot = await this._resolveDiskPath(rootPath, 'rootPath');
      await walk(resolvedRoot, 0);
      return { ok: true, root: resolvedRoot, entries: out, count: out.length };
    } catch (err) {
      return { ok: false, root: resolvedRoot || rootPath, error: err.message, code: err.code };
    }
  }

  /**
   * Rename or move a file or directory.
   */
  async renameDisk(oldPath, newPath) {
    let resolvedOldPath;
    let resolvedNewPath;
    try {
      resolvedOldPath = await this._resolveDiskPath(oldPath, 'oldPath');
      resolvedNewPath = await this._resolveDiskPath(newPath, 'newPath');
      await this.fs.rename(resolvedOldPath, resolvedNewPath);
      return { ok: true, from: resolvedOldPath, to: resolvedNewPath };
    } catch (err) {
      return { ok: false, from: resolvedOldPath || oldPath, to: resolvedNewPath || newPath, error: err.message, code: err.code };
    }
  }
}

module.exports = { FileDriver };
