'use strict';

/**
 * TextExtractor — captures text from various DOM regions.
 * Extracted from DomDriver to isolate text-capture responsibility.
 */

const { safeJsValue } = require('../shared/utils');

class TextExtractor {
  constructor(client, config) {
    this.client = client;
    this.config = config;
  }

  /**
   * Capture sidebar text (SOLO mode).
   */
  async captureSidebarText() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `(() => {
          var s = document.querySelector('.soloaisidebar');
          return s ? s.textContent.trim() : '';
        })()`,
        returnByValue: true
      });
      return result.result?.value || '';
    } catch(e) {
      return '';
    }
  }

  /**
   * Capture text from the IDE chat panel (used instead of sidebar in IDE mode).
   */
  async captureIdePanelText() {
    const safeSels = this.config.ideTaskPanelSelectors.map(s => safeJsValue(s));
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var sels = [${safeSels.join(', ')}];
            for (var i = 0; i < sels.length; i++) {
              var el = document.querySelector(sels[i]);
              if (el && el.offsetParent !== null) {
                var text = el.textContent.trim();
                if (text.length > 10) return text;
              }
            }
            return '';
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || '';
    } catch(e) {
      return '';
    }
  }

  /**
   * Capture all visible text in the main content area (excluding sidebar & composer).
   */
  async captureVisibleText() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `(() => {
          var bodyText = document.body ? document.body.innerText || document.body.textContent || '' : '';
          if (!bodyText) return '';
          var sidebarText = '';
          var sidebarEl = document.querySelector('.soloaisidebar');
          if (sidebarEl) sidebarText = sidebarEl.innerText || sidebarEl.textContent || '';
          var composerText = '';
          var composerEl = document.querySelector('.chat-input-v2-input-box-editable, [class*="input-box"]');
          if (composerEl) composerText = composerEl.innerText || composerEl.textContent || '';
          var panels = document.querySelectorAll('[class*="panel"], [class*="content"], [class*="chat"], [class*="solo"]');
          var panelTexts = [];
          for (var i = 0; i < panels.length; i++) {
            var p = panels[i];
            var rect = p.getBoundingClientRect ? p.getBoundingClientRect() : null;
            if (!rect) continue;
            if (rect.width < 50 || rect.height < 50) continue;
            if (sidebarEl && (p === sidebarEl || sidebarEl.contains(p))) continue;
            if (composerEl && (p === composerEl || composerEl.contains(p))) continue;
            if (rect.height > 1000 || rect.y < 0) continue;
            var t = (p.innerText || p.textContent || '').trim();
            if (t.length > 10 && !panelTexts.includes(t)) {
              panelTexts.push(t);
            }
          }
          var mainText = bodyText;
          if (sidebarText) mainText = mainText.replace(sidebarText, '');
          if (composerText) mainText = mainText.replace(composerText, '');
          mainText = mainText.trim();
          var panelText = panelTexts.join('\n---\n');
          return panelText || mainText || '';
        })()`,
        returnByValue: true
      });
      return result.result?.value || '';
    } catch(e) {
      return '';
    }
  }

  /**
   * Capture document.body innerText as a broad snapshot for text diffing.
   */
  async captureBodyText() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `(() => {
          var body = document.body;
          if (!body) return '';
          return body.innerText || body.textContent || '';
        })()`,
        returnByValue: true
      });
      return result.result?.value || '';
    } catch(e) {
      return '';
    }
  }

  /**
   * Scan only the content area for text-containing elements.
   */
  async scanContentArea() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `(() => {
          var contentAreas = [];
          var allDivs = document.querySelectorAll('div');
          var composerEl = document.querySelector('.chat-input-v2-input-box-editable, [class*="input-box"]');
          var sidebarEl = document.querySelector('.soloaisidebar');
          for (var i = 0; i < allDivs.length; i++) {
            var d = allDivs[i];
            var rect = d.getBoundingClientRect ? d.getBoundingClientRect() : null;
            if (!rect) continue;
            if (rect.width < 100 || rect.height < 60) continue;
            if (composerEl && rect.y > (composerEl.getBoundingClientRect ? composerEl.getBoundingClientRect().y - 10 : 0)) continue;
            if (sidebarEl && sidebarEl.contains(d)) continue;
            if (composerEl && composerEl.contains(d)) continue;
            var text = (d.innerText || d.textContent || '').trim();
            if (text.length > 20 && !/^[\\s\\n]+$/.test(text)) {
              contentAreas.push({ text: text, width: rect.width, height: rect.height, y: rect.y });
            }
          }
          contentAreas.sort(function(a, b) {
            if (a.width * a.height !== b.width * b.height) return (b.width * b.height) - (a.width * a.height);
            return a.y - b.y;
          });
          if (contentAreas.length > 0) {
            var best = contentAreas[0];
            return { text: best.text, areaFound: true };
          }
          return { text: '', areaFound: false };
        })()`,
        returnByValue: true
      });
      return result.result?.value || { text: '', areaFound: false };
    } catch(e) {
      return { text: '', areaFound: false };
    }
  }
}

module.exports = { TextExtractor };
