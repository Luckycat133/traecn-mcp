'use strict';

const { safeJsValue } = require('../shared/utils');
const { BaseDriver } = require('./base-driver');

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
class EditorDriver extends BaseDriver {
  // ── AI Edit Accept / Reject (TraeCN-specific) ────────────────────────

  /**
   * Find an apply-action container (AI's suggested edit) on the page.
   * Returns one or more apply containers with their visible buttons.
   */
  async _findApplyContainers() {
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
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
          out.push({
            container: c,
            containerClass: c.className,
            buttons
          });
        }
        return JSON.stringify(out);
      })()`,
      returnByValue: true
    });
    try {
      const parsed = JSON.parse(r.result.value);
      // Strip the `container` element since it's a DOM node, not serializable
      return parsed.map(c => ({ containerClass: c.containerClass, buttons: c.buttons }));
    } catch {
      return [];
    }
  }

  /**
   * Click a button in an apply-action container by fuzzy text/aria match.
   */
  async _clickApplyButton(predicate) {
    await this._ensureClickHelper();
    const safePred = predicate.toString();
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(function() {
        const containers = document.querySelectorAll('.icube-apply-action-container');
        for (const c of containers) {
          if (c.offsetParent === null) continue;
          const buttons = Array.from(c.querySelectorAll('button, [role="button"], .action-label'))
            .filter(b => b.offsetParent !== null);
          for (const b of buttons) {
            const text = (b.innerText || '').trim();
            const title = b.title || '';
            const aria = b.getAttribute('aria-label') || '';
            if ((${safePred})(text, title, aria)) {
              window.__radixClick(b);
              return 'clicked: ' + (text || aria || title);
            }
          }
        }
        return 'not found';
      })()`,
      returnByValue: true
    });
    return r.result.value;
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
   */
  async readActive() {
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const monaco = window.monaco?.editor;
        if (!monaco) return JSON.stringify({ ok: false, error: 'monaco not present' });
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
              return JSON.stringify({
                ok: true,
                value: model.getValue(),
                language: model.getLanguageId ? model.getLanguageId() : undefined,
                source: 'model-fallback',
                uri: model.uri && model.uri.toString()
              });
            }
          }
        }
        if (!active) return JSON.stringify({ ok: false, error: 'no editor' });
        const model = active.getModel();
        if (!model) return JSON.stringify({ ok: false, error: 'no model' });
        return JSON.stringify({
          ok: true,
          value: model.getValue(),
          language: model.getLanguageId ? model.getLanguageId() : undefined,
          source: 'editor',
          uri: model.uri && model.uri.toString()
        });
      })()`,
      returnByValue: true
    });
    return this._parseResult(r.result.value, { ok: false, error: 'parse failed' });
  }

  /**
   * Replace the active editor's text content.
   */
  async writeActive(value) {
    const safeValue = safeJsValue(value);
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const monaco = window.monaco?.editor;
        if (!monaco) return JSON.stringify({ ok: false, error: 'monaco not present' });
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
        if (!model) return JSON.stringify({ ok: false, error: 'no model' });
        const fullRange = model.getFullModelRange();
        model.applyEdits([{ range: fullRange, text: ${safeValue}, forceMoveMarkers: true }]);
        return JSON.stringify({
          ok: true,
          length: ${safeValue}.length,
          uri: model.uri && model.uri.toString()
        });
      })()`,
      returnByValue: true
    });
    return this._parseResult(r.result.value, { ok: false, error: 'parse failed' });
  }

  /**
   * List the languages currently in use across open editors.
   */
  async listActive() {
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const monaco = window.monaco?.editor;
        if (!monaco) return JSON.stringify([]);
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
        return JSON.stringify(editorRows);
      })()`,
      returnByValue: true
    });
    return this._parseResult(r.result.value, []);
  }
}

module.exports = { EditorDriver };
