'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { TraeCNAutomationError } = require('./errors');

/**
 * SnapshotDriver — capture DOM / page state / screenshots for replay and
 * debugging. Pure headless operations; no commands.
 *
 * Capabilities:
 *  - snapshotDom(selector?) — return outerHTML of an element or whole body.
 *  - snapshotText(selector?) — return visible text of an element.
 *  - snapshotLayout() — return layout info for visible elements (useful for
 *    regression detection).
 *  - screenshot(path?) — capture a PNG screenshot of the viewport. Saves to
 *    a tmp dir by default; can be configured to a specific path.
 *  - screenshotElement(selector, path?) — screenshot a specific element.
 */
class SnapshotDriver {
  constructor(client, config = {}, deps = {}) {
    this.client = client;
    this.config = config;
    this.screenshotDir = deps.screenshotDir || '/tmp/traecn-snapshots';
  }

  async _ensureDir() {
    try {
      await fs.mkdir(this.screenshotDir, { recursive: true });
    } catch {}
  }

  /**
   * Snapshot DOM as outerHTML. If selector is provided, capture that element
   * (uses Runtime.evaluate). Otherwise capture the body.
   */
  async snapshotDom(selector) {
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(function() {
        const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body'};
        if (!el) return JSON.stringify({ ok: false, error: 'not found' });
        return JSON.stringify({ ok: true, html: el.outerHTML, length: el.outerHTML.length });
      })()`,
      returnByValue: true
    });
    try { return JSON.parse(r.result.value); } catch { return { ok: false, error: 'parse failed' }; }
  }

  /**
   * Snapshot visible text of the page or a specific element.
   */
  async snapshotText(selector) {
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(function() {
        const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body'};
        if (!el) return JSON.stringify({ ok: false, error: 'not found' });
        return JSON.stringify({ ok: true, text: (el.innerText || '').slice(0, 50000) });
      })()`,
      returnByValue: true
    });
    try { return JSON.parse(r.result.value); } catch { return { ok: false, error: 'parse failed' }; }
  }

  /**
   * Layout snapshot: rect + computed style of all visible, large-ish elements.
   * Useful for regression detection (positions of panels, status bar, etc).
   */
  async snapshotLayout(opts = {}) {
    const max = opts.max || 200;
    const minSize = opts.minSize || 50;
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        const out = [];
        const all = document.querySelectorAll('*');
        for (const el of all) {
          if (out.length >= ${max}) break;
          const rect = el.getBoundingClientRect();
          if (rect.width < ${minSize} || rect.height < ${minSize}) continue;
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          out.push({
            tag: el.tagName,
            class: (typeof el.className === 'string' ? el.className : '').slice(0, 100),
            id: el.id || '',
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            text: (el.innerText || '').slice(0, 60)
          });
        }
        return JSON.stringify({ ok: true, viewport: { w: window.innerWidth, h: window.innerHeight }, items: out });
      })()`,
      returnByValue: true
    });
    try { return JSON.parse(r.result.value); } catch { return { ok: false, error: 'parse failed' }; }
  }

  /**
   * Capture a PNG screenshot of the viewport. Returns the file path.
   * If `targetPath` is provided, writes there; otherwise a temp path.
   */
  async screenshot(targetPath) {
    await this._ensureDir();
    const filePath = targetPath || path.join(this.screenshotDir, `snap-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`);
    const r = await this.client.send('Page.captureScreenshot', { format: 'png' });
    if (!r.data) {
      throw new TraeCNAutomationError('screenshot failed: no data', 'SCREENSHOT_FAILED', {});
    }
    await fs.writeFile(filePath, Buffer.from(r.data, 'base64'));
    return { ok: true, path: filePath, size: Buffer.from(r.data, 'base64').length };
  }

  /**
   * Capture a PNG screenshot of a specific element by selector.
   * Uses Page.captureScreenshot with clip from element bounding box.
   */
  async screenshotElement(selector, targetPath) {
    await this._ensureDir();
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ ok: false, error: 'not found' });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: r.x, y: r.y, w: r.width, h: r.height });
      })()`,
      returnByValue: true
    });
    const rect = JSON.parse(r.result.value);
    if (!rect.ok) return rect;

    const filePath = targetPath || path.join(this.screenshotDir, `snap-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`);
    const capture = await this.client.send('Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: Math.round(rect.w),
        height: Math.round(rect.h),
        scale: 1
      }
    });
    if (!capture.data) {
      throw new TraeCNAutomationError('element screenshot failed: no data', 'SCREENSHOT_FAILED', {});
    }
    await fs.writeFile(filePath, Buffer.from(capture.data, 'base64'));
    return { ok: true, path: filePath, size: Buffer.from(capture.data, 'base64').length, selector };
  }

  /**
   * Compute a quick "page hash" — stable identifier for current state. Useful
   * for change detection between runs.
   */
  async pageHash() {
    const r = await this.client.send('Runtime.evaluate', {
      expression: `(()=>{
        // Concatenate: title + url + top-level visibility + counts
        const parts = [
          document.title,
          location.href,
          document.body.children.length,
          document.querySelectorAll('.tab').length,
          document.querySelectorAll('.monaco-editor').length,
          document.querySelectorAll('.terminal-wrapper').length,
          document.querySelectorAll('.scm-viewlet').length,
          document.querySelectorAll('.extensions-viewlet').length,
          document.querySelectorAll('.search-view').length,
          document.querySelectorAll('.markers-panel').length,
          Array.from(document.querySelectorAll('.tab')).map(t => (t.innerText||'').trim()).join('|')
        ];
        return parts.join('::');
      })()`,
      returnByValue: true
    });
    const content = String(r.result.value || '');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}

module.exports = { SnapshotDriver };

// ── Aliases for HTTP-friendly action names ────────────────────────────────
SnapshotDriver.prototype.text = SnapshotDriver.prototype.snapshotText;
SnapshotDriver.prototype.dom = SnapshotDriver.prototype.snapshotDom;
SnapshotDriver.prototype.layout = SnapshotDriver.prototype.snapshotLayout;
SnapshotDriver.prototype.screenshotEl = SnapshotDriver.prototype.screenshotElement;
