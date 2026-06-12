'use strict';

const { sleep } = require('../shared/utils');
const { TraeCNAutomationError } = require('./errors');

/**
 * ExtensionDriver — manage TraeCN / VS Code extensions.
 *
 * Implementation strategy:
 *  - For "list / install / uninstall / enable / disable", use CommandPalette
 *    + the Extensions viewlet DOM.
 *  - For "search marketplace", type into the search input in the viewlet.
 *  - Optionally accepts a `exec` dep for direct `trae-cn --install-extension`
 *    / `trae-cn --list-extensions` / `trae-cn --uninstall-extension` calls.
 */
class ExtensionDriver {
  constructor(client, config = {}, deps = {}) {
    this.client = client;
    this.config = config;
    this.palette = deps.palette || null;
    this.exec = deps.exec || null; // function(cmd, args) => Promise<{stdout, stderr, code}>
  }

  setPalette(palette) { this.palette = palette; }

  _viaPalette(commandId) {
    if (!this.palette) {
      throw new TraeCNAutomationError('CommandPaletteDriver required', 'PALETTE_REQUIRED', { commandId });
    }
    return this.palette.run(commandId);
  }

  // ── Open / focus ────────────────────────────────────────────────────

  openExtensions() { return this._viaPalette('workbench.view.extensions'); }
  focusExtensions() { return this._viaPalette('workbench.extensions.action.focusExtensions'); }
  openMarketplace() { return this._viaPalette('workbench.extensions.action.openExtensionsView'); }

  // ── Standard extension actions ─────────────────────────────────────

  install() { return this._viaPalette('workbench.extensions.action.installExtension'); }
  uninstall() { return this._viaPalette('workbench.extensions.action.uninstallExtension'); }
  enable() { return this._viaPalette('workbench.extensions.action.enableExtension'); }
  enableAll() { return this._viaPalette('workbench.extensions.action.enableAllExtensions'); }
  enableAllWorkspace() { return this._viaPalette('workbench.extensions.action.enableAllWorkspaceExtensions'); }
  disable() { return this._viaPalette('workbench.extensions.action.disableExtension'); }
  disableAll() { return this._viaPalette('workbench.extensions.action.disableAllExtensions'); }
  disableAllWorkspace() { return this._viaPalette('workbench.extensions.action.disableAllWorkspaceExtensions'); }
  showInstalled() { return this._viaPalette('workbench.extensions.action.showInstalledExtensions'); }
  showEnabled() { return this._viaPalette('workbench.extensions.action.showEnabledExtensions'); }
  showDisabled() { return this._viaPalette('workbench.extensions.action.showDisabledExtensions'); }
  showOutdated() { return this._viaPalette('workbench.extensions.action.listOutdatedExtensions'); }
  updateAll() { return this._viaPalette('workbench.extensions.action.updateAllExtensions'); }

  // ── Search marketplace ────────────────────────────────────────────

  /**
   * Open Extensions view, type a query into the search input, return the
   * rendered search results.
   */
  async searchMarketplace(query, opts = {}) {
    if (typeof query !== 'string' || !query) {
      throw new TraeCNAutomationError('query is required', 'INVALID_INPUT', {});
    }
    const maxResults = opts.maxResults || 50;
    const timeoutMs = opts.timeoutMs || 15000;

    await this._viaPalette('workbench.view.extensions');
    await sleep(300);

    const r = await this.client.send('Runtime.evaluate', {
      expression: `(function() {
        const view = document.querySelector('.extensions-viewlet');
        if (!view) return false;
        const input = view.querySelector('input[placeholder*="Search" i], .extensions-search-input, input.input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(query)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
      returnByValue: true
    });
    if (!r.result.value) {
      throw new TraeCNAutomationError('Extensions search input not found', 'EXT_SEARCH_INPUT_MISSING', {});
    }

    // Wait for results
    const start = Date.now();
    let results = [];
    while (Date.now() - start < timeoutMs) {
      results = await this._readExtensionList(maxResults);
      if (results.count > 0) break;
      await sleep(400);
    }
    return { ok: true, query, ...results };
  }

  /**
   * Read the visible extensions list rows.
   */
  async _readExtensionList(max = 50) {
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const view = document.querySelector('.extensions-viewlet');
        if (!view) return JSON.stringify({ ok: false, count: 0, items: [] });
        const rows = Array.from(view.querySelectorAll('.extension-list-item, [class*="extension-list-item"]'));
        const out = rows.slice(0, ${max}).map(row => {
          const name = row.querySelector('.name')?.innerText?.trim() || '';
          const id = row.querySelector('.identifier')?.innerText?.trim() || '';
          const author = row.querySelector('.author')?.innerText?.trim() || '';
          const desc = row.querySelector('.description')?.innerText?.trim() || '';
          const version = row.querySelector('.version')?.innerText?.trim() || '';
          const installed = !!row.querySelector('.extension-list-item__installed, [class*="installed"]');
          return { name, id, author, desc: desc.slice(0, 200), version, installed };
        });
        return JSON.stringify({ ok: true, count: out.length, items: out });
      })()`,
      returnByValue: true
    });
    try { return JSON.parse(r.result.value); } catch { return { ok: false, count: 0, items: [] }; }
  }

  /**
   * Read the currently visible extensions (without changing the view's filter).
   */
  async readVisible(max = 50) {
    return this._readExtensionList(max);
  }

  // ── CLI fallback (uses trae-cn or code) ─────────────────────────────

  /**
   * List installed extensions via `trae-cn --list-extensions`.
   */
  async listViaCLI(opts = {}) {
    if (typeof this.exec !== 'function') {
      return { ok: false, error: 'no exec dep; pass deps.exec to constructor for CLI fallback' };
    }
    try {
      const result = await this.exec('trae-cn', ['--list-extensions', '--show-versions'], { ...opts });
      const lines = (result.stdout || '').split('\n').filter(Boolean);
      return { ok: true, code: result.code, count: lines.length, items: lines };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Install an extension via CLI: `trae-cn --install-extension <id>`.
   * If `version` is provided, appends `@version`.
   */
  async installViaCLI(extensionId, version) {
    if (typeof this.exec !== 'function') {
      return { ok: false, error: 'no exec dep' };
    }
    const arg = version ? `${extensionId}@${version}` : extensionId;
    try {
      const result = await this.exec('trae-cn', ['--install-extension', arg], { timeout: 120000 });
      return { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Uninstall an extension via CLI: `trae-cn --uninstall-extension <id>`.
   */
  async uninstallViaCLI(extensionId) {
    if (typeof this.exec !== 'function') {
      return { ok: false, error: 'no exec dep' };
    }
    try {
      const result = await this.exec('trae-cn', ['--uninstall-extension', extensionId]);
      return { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

module.exports = { ExtensionDriver };
