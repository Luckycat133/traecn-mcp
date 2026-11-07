'use strict';

const { sleep } = require('../shared/utils');
const { TraeCNAutomationError } = require('./errors');
const { evaluate, evaluateJSON } = require('./browser-dom');

/**
 * SearchDriver — drive the Search panel and Find in Files.
 *
 * Implementation strategy:
 *  - Open / close / focus via CommandPalette (`workbench.view.search`,
 *    `workbench.action.findInFiles`).
 *  - For "find in files" with a query, open the panel, type into the
 *    `.search-widget .input`, press Enter to trigger.
 *  - Read results from `.search-results .monaco-list-row` rows.
 */
class SearchDriver {
  constructor(client, config = {}, deps = {}) {
    this.client = client;
    this.config = config;
    this.palette = deps.palette || null;
  }

  setPalette(palette) { this.palette = palette; }

  _viaPalette(commandId) {
    if (!this.palette) {
      throw new TraeCNAutomationError('CommandPaletteDriver required', 'PALETTE_REQUIRED', { commandId });
    }
    return this.palette.run(commandId);
  }

  // ── Open / focus (command palette) ──────────────────────────────────

  openSearch() { return this._viaPalette('workbench.view.search'); }
  findInFiles() { return this._viaPalette('workbench.action.findInFiles'); }
  closeSearch() { return this._viaPalette('workbench.action.closeSearchEditor'); }
  toggleCaseSensitive() { return this._viaPalette('workbench.action.toggleCaseSensitive'); }
  toggleWholeWord() { return this._viaPalette('workbench.action.toggleWholeWord'); }
  toggleRegex() { return this._viaPalette('workbench.action.toggleRegex'); }
  collapseAll() { return this._viaPalette('search.action.collapseSearchResults'); }

  // ── Run a find-in-files query and return results ─────────────────────

  /**
   * Open Find in Files with a query and (optionally) a file glob.
   * Then read the structured results.
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {string} [opts.include] Glob to include
   * @param {string} [opts.exclude] Glob to exclude
   * @param {number} [opts.maxResults=200] Cap on returned rows
   * @param {number} [opts.timeoutMs=15000] Time to wait for results
   */
  async find(query, opts = {}) {
    if (typeof query !== 'string' || !query) {
      throw new TraeCNAutomationError('query is required', 'INVALID_INPUT', {});
    }
    const maxResults = opts.maxResults || 200;
    const timeoutMs = opts.timeoutMs || 15000;

    // Open Find in Files view
    await this._viaPalette('workbench.action.findInFiles');
    await sleep(300);

    // Type query into the search input
    const typed = await this._typeIntoSearchInput(query, opts.include, opts.exclude);
    if (!typed) {
      throw new TraeCNAutomationError('Search input not found', 'SEARCH_INPUT_MISSING', {});
    }

    // Wait for results to populate
    const start = Date.now();
    let results = [];
    while (Date.now() - start < timeoutMs) {
      results = await this.readResults(maxResults);
      if (results.count > 0) break;
      await sleep(400);
    }
    return {
      ok: true,
      query,
      include: opts.include || null,
      exclude: opts.exclude || null,
      ...results
    };
  }

  /**
   * Read the current search results from the rendered DOM.
   */
  async readResults(maxResults = 200) {
    try {
      return await evaluateJSON(
        this.client,
        `(maxResults) => {
          const rows = document.querySelectorAll('.search-results .monaco-list-row');
          const out = [];
          for (let i = 0; i < Math.min(rows.length, maxResults); i++) {
            const row = rows[i];
            const file = row.querySelector('.file')?.innerText?.trim() || '';
            const line = row.querySelector('.line')?.innerText?.trim() || '';
            const match = row.querySelector('.match')?.innerText?.trim() || (row.innerText || '').trim();
            const aria = row.getAttribute('aria-label') || '';
            out.push({ file, line, match: match.slice(0, 400), aria });
          }
          const count = document.querySelector('.search-message')?.innerText?.trim() ||
                        document.querySelector('[class*="result-count"]')?.innerText?.trim() || '';
          return { ok: true, count: out.length, items: out, countText: count };
        }`,
        [maxResults]
      );
    } catch {
      return { ok: false, count: 0, items: [] };
    }
  }

  async _typeIntoSearchInput(query, include, exclude) {
    return evaluate(
      this.client,
      `(args) => {
        const view = document.querySelector('.search-view');
        if (!view) return false;
        const searchInput = view.querySelector('.search-widget .input[aria-label*="Search" i], .search-widget input.input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        if (searchInput) {
          setter.call(searchInput, args.query);
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (args.include) {
          const includeInput = view.querySelector('input[aria-label*="Include" i], input[placeholder*="Include" i]');
          if (includeInput) {
            setter.call(includeInput, args.include);
            includeInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        if (args.exclude) {
          const excludeInput = view.querySelector('input[aria-label*="Exclude" i], input[placeholder*="Exclude" i]');
          if (excludeInput) {
            setter.call(excludeInput, args.exclude);
            excludeInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        return !!searchInput;
      }`,
      [{ query, include, exclude }]
    );
  }
}

module.exports = { SearchDriver };
