'use strict';

const { safeJsValue } = require('../shared/utils');
const { TraeCNAutomationError } = require('./errors');
const {
  evaluate,
  evaluateJSON,
  clickByPredicate
} = require('./browser-dom');

/**
 * EditorDriver — drives the Monaco / TraeCN code editor for accept/reject,
 * navigation, formatting, commenting, multi-cursor, selection, undo/redo.
 *
 * Implementation strategy:
 *  - For "accept/reject AI edit" use the visible `.icube-apply-action-container`
 *    buttons (stable TraeCN-specific class).
 *  - For everything else, route through VS Code workbench commands via the
 *    CommandPaletteDriver (stable, no DOM click brittleness).
 *
 * All VS Code command IDs are documented in command-palette-driver.js.
 */
class EditorDriver {
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
      throw new TraeCNAutomationError('CommandPaletteDriver is required for this operation', 'PALETTE_REQUIRED', { commandId });
    }
    return this.palette.run(commandId);
  }

  // ── AI Edit Accept / Reject (TraeCN-specific) ────────────────────────

  /**
   * Find an apply-action container (AI's suggested edit) on the page.
   * Returns one or more apply containers with their visible buttons.
   */
  async _findApplyContainers() {
    try {
      const parsed = await evaluateJSON(
        this.client,
        `() => {
          const containers = document.querySelectorAll('.icube-apply-action-container');
          const out = [];
          for (const c of containers) {
            if (c.offsetParent === null) continue;
            const buttons = Array.from(c.querySelectorAll('button, [role="button"], .action-label'))
              .filter(b => b.offsetParent !== null)
              .map(b => ({
                text: (b.innerText || '').trim(),
                title: b.title || '',
                aria: b.getAttribute('aria-label') || '',
                class: b.className || ''
              }));
            // Strip the DOM node; only serialize metadata.
            out.push({ containerClass: c.className, buttons });
          }
          return out;
        }`
      );
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Click a button in an apply-action container by fuzzy text/aria match.
   *
   * Migration: now routes through `clickByPredicate` with the caller's
   * predicate serialised as JS source. The selector list is the same
   * as the legacy implementation, and the radix click helper is
   * auto-installed by the helper so callers no longer need to invoke
   * `_ensureClickHelper` first.
   */
  async _clickApplyButton(predicate) {
    const predicateSource = predicate.toString();
    const result = await clickByPredicate(
      this.client,
      predicateSource,
      {
        selectors: [
          '.icube-apply-action-container button',
          '.icube-apply-action-container [role="button"]',
          '.icube-apply-action-container .action-label'
        ],
        click: 'radix'
      }
    );
    if (result.ok) return 'clicked: ' + result.matchedText;
    if (result.reason === 'not_found') return 'not found';
    return result.reason || 'unknown';
  }

  async _ensureClickHelper() {
    // Centralised in browser-dom's clickByTextEx / clickByPredicate.
    // Kept as a no-op for callers that still rely on the explicit
    // pre-call. The new helpers auto-install the radix shim on demand,
    // so this method is safe to leave as a thin wrapper.
    return evaluate(
      this.client,
      `() => {
        if (window.__radixClick) return;
        window.__radixClick = function(el) {
          if (!el) return;
          el.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true, button: 0}));
          el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0}));
          el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, button: 0}));
          el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
        };
      }`
    );
  }

  /**
   * Accept all pending AI edits across the workspace. TraeCN's apply container
   * has typical Chinese labels: 接受 / Accept / Apply / 全部接受.
   */
  async acceptAll() {
    const clicked = await this._clickApplyButton((t, ti, a) =>
      /^(接受|accept|apply|应用|应用全部|全部接受|accept all|apply all)$/i.test((t || ti || a || '').trim())
    );
    return { ok: clicked !== 'not found', clicked };
  }

  /**
   * Reject all pending AI edits. Labels: 拒绝 / 拒绝全部 / Reject / Discard.
   */
  async rejectAll() {
    const clicked = await this._clickApplyButton((t, ti, a) =>
      /^(拒绝|拒绝全部|reject|discard|revert|undo|取消|撤销|reject all|discard all)$/i.test((t || ti || a || '').trim())
    );
    return { ok: clicked !== 'not found', clicked };
  }

  /**
   * Accept the first AI edit suggestion (don't apply all).
   * Looks for inline Accept/Apply buttons (typically per-edit).
   */
  async acceptNext() {
    // Apply singular vs "next" pending
    const clicked = await this._clickApplyButton((t, ti, a) =>
      /^(接受|accept|apply|应用)$/i.test((t || ti || a || '').trim())
    );
    return { ok: clicked !== 'not found', clicked };
  }

  /**
   * Reject the first AI edit suggestion.
   */
  async rejectNext() {
    const clicked = await this._clickApplyButton((t, ti, a) =>
      /^(拒绝|reject|discard|取消|撤销)$/i.test((t || ti || a || '').trim())
    );
    return { ok: clicked !== 'not found', clicked };
  }

  /**
   * Read all visible apply containers' state — useful for diagnostics.
   */
  async readApplyState() {
    return await this._findApplyContainers();
  }

  // ── File operations via command palette ──────────────────────────────

  save() { return this._viaPalette('workbench.action.files.save'); }
  saveAll() { return this._viaPalette('workbench.action.files.saveAll'); }
  saveAs() { return this._viaPalette('workbench.action.files.saveAs'); }
  revertFile() { return this._viaPalette('workbench.action.files.revert'); }
  revertAll() { return this._viaPalette('workbench.action.files.revertAll'); }
  closeActive() { return this._viaPalette('workbench.action.closeActiveEditor'); }
  closeAll() { return this._viaPalette('workbench.action.closeAllEditors'); }
  newFile() { return this._viaPalette('workbench.action.files.newUntitledFile'); }
  revealInExplorer() { return this._viaPalette('workbench.action.files.revealActiveFileInExplorer'); }
  copyPathOfActive() { return this._viaPalette('workbench.action.files.copyPathOfActiveFile'); }
  reloadWindow() { return this._viaPalette('workbench.action.reloadWindow'); }
  toggleSidebar() { return this._viaPalette('workbench.action.toggleSidebarVisibility'); }
  togglePanel() { return this._viaPalette('workbench.action.togglePanel'); }
  splitEditor() { return this._viaPalette('workbench.action.splitEditor'); }
  showCommands() { return this._viaPalette('workbench.action.showCommands'); }

  // ── Editor text operations ──────────────────────────────────────────

  undo() { return this._viaPalette('undo'); }
  redo() { return this._viaPalette('redo'); }
  formatDocument() { return this._viaPalette('editor.action.formatDocument'); }
  formatSelection() { return this._viaPalette('editor.action.formatSelection'); }
  commentLine() { return this._viaPalette('editor.action.commentLine'); }
  commentToggle() { return this._viaPalette('editor.action.commentLine'); }
  copyLinesDown() { return this._viaPalette('editor.action.copyLinesDownAction'); }
  copyLinesUp() { return this._viaPalette('editor.action.copyLinesUpAction'); }
  moveLinesDown() { return this._viaPalette('editor.action.moveLinesDownAction'); }
  moveLinesUp() { return this._viaPalette('editor.action.moveLinesUpAction'); }
  insertCursorAbove() { return this._viaPalette('editor.action.insertCursorAbove'); }
  insertCursorBelow() { return this._viaPalette('editor.action.insertCursorBelow'); }
  insertCursorAtEachMatchSelection() { return this._viaPalette('editor.action.insertCursorAtEndOfEachLineSelected'); }
  expandLineSelection() { return this._viaPalette('editor.action.expandLineSelection'); }
  shrinkSelection() { return this._viaPalette('editor.action.shrinkSelection'); }
  addSelectionToNextFindMatch() { return this._viaPalette('editor.action.addSelectionToNextFindMatch'); }
  addSelectionToPreviousFindMatch() { return this._viaPalette('editor.action.addSelectionToPreviousFindMatch'); }
  selectAll() { return this._viaPalette('editor.action.selectAll'); }
  triggerSuggest() { return this._viaPalette('editor.action.triggerSuggest'); }
  showHover() { return this._viaPalette('editor.action.showHover'); }
  gotoLine() { return this._viaPalette('workbench.action.gotoLine'); }

  // ── Symbol / definition / refactor ──────────────────────────────────

  revealDefinition() { return this._viaPalette('editor.action.revealDefinition'); }
  peekDefinition() { return this._viaPalette('editor.action.peekDefinition'); }
  showReferences() { return this._viaPalette('editor.action.referenceSearch.trigger'); }
  renameSymbol() { return this._viaPalette('editor.action.rename'); }
  findAllReferences() { return this._viaPalette('editor.action.referenceSearch.trigger'); }
  implementInterface() { return this._viaPalette('editor.action.codeAction'); }
  quickFix() { return this._viaPalette('editor.action.quickFix'); }
  refactor() { return this._viaPalette('editor.action.refactor'); }

  // ── Code folding ────────────────────────────────────────────────────

  fold() { return this._viaPalette('editor.fold'); }
  unfold() { return this._viaPalette('editor.unfold'); }
  foldAll() { return this._viaPalette('editor.foldAll'); }
  unfoldAll() { return this._viaPalette('editor.unfoldAll'); }
  foldRecursively() { return this._viaPalette('editor.foldRecursively'); }
  unfoldRecursively() { return this._viaPalette('editor.unfoldRecursively'); }

  // ── Monaco editor direct read/write (low-level) ─────────────────────

  /**
   * Read the active editor's text content.
   *
   * Migration: page-side function returns the object directly;
   * `evaluateJSON` handles the JSON-stringify/parse transport.
   */
  async readActive() {
    try {
      return await evaluateJSON(this.client, `() => {
        const monaco = window.monaco?.editor;
        if (!monaco) return { ok: false, error: 'monaco not present' };
        const editors = monaco.getEditors ? monaco.getEditors() : [];
        let active = editors.find(e => { try { return e.hasTextFocus && e.hasTextFocus(); } catch { return false; } });
        if (!active && editors.length > 0) active = editors[0];
        // Fallback: editors haven't been registered yet but a model is loaded in
        // the DOM (this happens when the workbench just opened a file before
        // Monaco has had a chance to attach its editor instance to the pane).
        // We pick the model whose URI appears in the visible .monaco-editor
        // elements and read the content straight from the model.
        if (!active && monaco.getModels) {
          const visibleDom = Array.from(document.querySelectorAll('.monaco-editor[data-uri], .monaco-editor'))
            .find(el => el && el.offsetParent !== null);
          if (visibleDom) {
            const uriAttr = visibleDom.getAttribute('data-uri') || null;
            const models = monaco.getModels();
            const model = uriAttr
              ? models.find(m => m.uri && m.uri.toString() === uriAttr)
              : (models.find(m => m.getLineCount() > 0) || null);
            if (model) {
              return {
                ok: true,
                value: model.getValue(),
                language: model.getLanguageId ? model.getLanguageId() : undefined,
                source: 'model-fallback',
                uri: model.uri && model.uri.toString()
              };
            }
          }
        }
        if (!active) return { ok: false, error: 'no editor' };
        const model = active.getModel();
        if (!model) return { ok: false, error: 'no model' };
        return {
          ok: true,
          value: model.getValue(),
          language: model.getLanguageId ? model.getLanguageId() : undefined,
          source: 'editor',
          uri: model.uri && model.uri.toString()
        };
      }`);
    } catch {
      return { ok: false, error: 'parse failed' };
    }
  }

  /**
   * Replace the active editor's text content.
   *
   * Migration: keeps the `safeJsValue` step (Pattern D) — `value` must
   * reach the page as a JS literal, not a string arg, because it's
   * spliced directly into the `applyEdits` text field. The page-side
   * function now returns an object directly.
   */
  async writeActive(value) {
    const safeValue = safeJsValue(value);
    try {
      return await evaluateJSON(this.client, `() => {
        const monaco = window.monaco?.editor;
        if (!monaco) return { ok: false, error: 'monaco not present' };
        const editors = monaco.getEditors ? monaco.getEditors() : [];
        let active = editors.find(e => { try { return e.hasTextFocus && e.hasTextFocus(); } catch { return false; } });
        if (!active && editors.length > 0) active = editors[0];
        // Same fallback as readActive: if Monaco hasn't attached an editor
        // instance yet, write straight to the model that has a visible DOM.
        let model = active ? active.getModel() : null;
        if (!model && monaco.getModels) {
          const visibleDom = Array.from(document.querySelectorAll('.monaco-editor'))
            .find(el => el && el.offsetParent !== null);
          if (visibleDom) {
            const uriAttr = visibleDom.getAttribute('data-uri') || null;
            const models = monaco.getModels();
            model = uriAttr
              ? models.find(m => m.uri && m.uri.toString() === uriAttr)
              : (models.find(m => m.getLineCount() > 0) || null);
          }
        }
        if (!model) return { ok: false, error: 'no model' };
        const fullRange = model.getFullModelRange();
        model.applyEdits([{ range: fullRange, text: ${safeValue}, forceMoveMarkers: true }]);
        return {
          ok: true,
          length: ${safeValue}.length,
          uri: model.uri && model.uri.toString()
        };
      }`);
    } catch {
      return { ok: false, error: 'parse failed' };
    }
  }

  /**
   * List the languages currently in use across open editors.
   *
   * Migration: uses `evaluateJSON` so the page can return the array
   * of editor rows directly.
   */
  async listActive() {
    try {
      const rows = await evaluateJSON(this.client, `() => {
        const monaco = window.monaco?.editor;
        if (!monaco) return [];
        const editors = monaco.getEditors ? monaco.getEditors() : [];
        const editorRows = editors.map(e => ({
          id: e.getId(),
          language: e.getModel()?.getLanguageId?.(),
          uri: e.getModel()?.uri?.toString?.(),
          lineCount: e.getModel()?.getLineCount?.() || 0
        }));
        // Augment with models that don't yet have an attached editor instance.
        // Each entry carries a hasEditor flag so the caller can tell apart
        // a fully wired-up editor from a model-only row.
        if (monaco.getModels) {
          const knownUris = new Set(editorRows.map(r => r.uri).filter(Boolean));
          for (const m of monaco.getModels()) {
            const uri = m.uri && m.uri.toString();
            if (!uri || knownUris.has(uri)) continue;
            const visible = !!Array.from(document.querySelectorAll('.monaco-editor'))
              .find(el => el && el.offsetParent !== null
                && (!el.getAttribute('data-uri') || el.getAttribute('data-uri') === uri));
            editorRows.push({
              id: null,
              language: m.getLanguageId ? m.getLanguageId() : undefined,
              uri,
              lineCount: m.getLineCount ? m.getLineCount() : 0,
              hasEditor: false,
              visible
            });
          }
        }
        return editorRows;
      }`);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }
}

module.exports = { EditorDriver };
