'use strict';

const { BaseDriver } = require('./base-driver');

/**
 * DiagnosticsDriver — read problems, errors, warnings from the workspace.
 *
 * Implementation strategy:
 *  - Open Problems panel via CommandPalette (`workbench.actions.view.problems`).
 *  - Read problems by walking the rendered DOM rows.
 *  - Also read Monaco markers (per-file diagnostics) directly via
 *    `monaco.editor.getModelMarkers({})`.
 */
class DiagnosticsDriver extends BaseDriver {
  openProblems() { return this._viaPalette('workbench.actions.view.problems'); }
  focusProblems() { return this._viaPalette('workbench.actions.focusProblemsPanel'); }
  nextProblem() { return this._viaPalette('editor.action.marker.next'); }
  prevProblem() { return this._viaPalette('editor.action.marker.prev'); }
  nextInFiles() { return this._viaPalette('workbench.action.problems.focus'); }
  showErrors() { return this._viaPalette('workbench.action.showErrors'); }

  /**
   * Read all workspace problems from the rendered Problems panel.
   */
  async readAll(max = 500) {
    // Coerce to a safe integer to prevent expression injection.
    const safeMax = Math.max(0, Math.min(10000, parseInt(max, 10) || 500));
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const panel = document.querySelector('.markers-panel, [class*="problems-panel"], [class*="markers"]');
        if (!panel) return JSON.stringify({ ok: false, error: 'problems panel not open' });
        const rows = Array.from(panel.querySelectorAll('.monaco-list-row, [class*="marker"]'));
        const out = [];
        for (let i = 0; i < Math.min(rows.length, ${safeMax}); i++) {
          const row = rows[i];
          const severity = /severity-error/.test(row.className) ? 'error'
                         : /severity-warning/.test(row.className) ? 'warning'
                         : /severity-info/.test(row.className) ? 'info' : 'unknown';
          const file = row.querySelector('.file')?.innerText || '';
          const line = row.querySelector('.line')?.innerText || '';
          const source = row.querySelector('.source')?.innerText || '';
          const message = (row.querySelector('.description')?.innerText || row.innerText || '').trim().slice(0, 300);
          out.push({ severity, file, line, source, message });
        }
        return JSON.stringify({ ok: true, items: out, count: out.length });
      })()`,
      returnByValue: true
    });
    try { return JSON.parse(r.result.value); } catch { return { ok: false, error: 'parse failed' }; }
  }

  /**
   * Read all Monaco model markers across all open files.
   * This is the in-editor version (faster, doesn't require the panel open).
   */
  async readModelMarkers(max = 500) {
    const safeMax = Math.max(0, Math.min(10000, parseInt(max, 10) || 500));
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        if (!window.monaco?.editor) return JSON.stringify({ ok: false, error: 'monaco not present' });
        const markers = window.monaco.editor.getModelMarkers({});
        const out = markers.slice(0, ${safeMax}).map(m => ({
          severity: ['hint','info','warning','error'][m.severity || 0],
          message: (m.message || '').slice(0, 300),
          source: m.source || '',
          code: m.code ? String(m.code) : '',
          file: m.resource?.fsPath || m.resource?.toString?.() || '',
          startLine: m.startLineNumber,
          startColumn: m.startColumn,
          endLine: m.endLineNumber,
          endColumn: m.endColumn
        }));
        return JSON.stringify({ ok: true, items: out, count: out.length });
      })()`,
      returnByValue: true
    });
    try { return JSON.parse(r.result.value); } catch { return { ok: false, error: 'parse failed' }; }
  }

  /**
   * Count problems by severity.
   */
  async count() {
    const markers = await this.readModelMarkers(5000);
    if (!markers.ok) return { ok: false, error: markers.error };
    const counts = { error: 0, warning: 0, info: 0, hint: 0 };
    for (const m of markers.items) {
      counts[m.severity] = (counts[m.severity] || 0) + 1;
    }
    return { ok: true, total: markers.count, ...counts };
  }

  /**
   * Read hover info at the current cursor (or at a specific line/column
   * if provided). Uses the editor's hover provider.
   */
  async hover(line, column) {
    const args = (line !== undefined && column !== undefined)
      ? `{ line: ${Number(line)}, column: ${Number(column)} }`
      : 'undefined';
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const editors = window.monaco?.editor?.getEditors?.() || [];
        const ed = editors.find(e => e.hasTextFocus && e.hasTextFocus()) || editors[0];
        if (!ed) return JSON.stringify({ ok: false, error: 'no editor' });
        const pos = (${args} === 'undefined') ? ed.getPosition() : ${args};
        if (!pos) return JSON.stringify({ ok: false, error: 'no position' });
        const model = ed.getModel();
        if (!model) return JSON.stringify({ ok: false, error: 'no model' });
        const word = model.getWordAtPosition(pos);
        return JSON.stringify({
          ok: true,
          position: pos,
          word: word ? { text: word.word, startColumn: word.startColumn, endColumn: word.endColumn } : null,
          lineContent: model.getLineContent(pos.lineNumber) || ''
        });
      })()`,
      returnByValue: true
    });
    try { return JSON.parse(r.result.value); } catch { return { ok: false, error: 'parse failed' }; }
  }
}

module.exports = { DiagnosticsDriver };
