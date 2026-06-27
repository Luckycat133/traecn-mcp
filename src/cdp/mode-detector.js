'use strict';

/**
 * ModeDetector — detects the current UI mode (solo or ide).
 * Extracted from DomDriver to isolate mode-detection responsibility.
 */

const { safeJsValue } = require('../shared/utils');

class ModeDetector {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this._cachedMode = null;
    this._cachedModeTs = 0;
    this._modeCacheTtl = 5000;
  }

  /**
   * Detect the current UI mode (solo or ide) by checking for distinctive
   * DOM elements. Uses a short cache to avoid excessive re-evaluation.
   *
   * @returns {Promise<{mode: 'solo'|'ide', confidence: number, indicators: string[]}>}
   */
  async detectMode() {
    const now = Date.now();
    if (this._cachedMode && now - this._cachedModeTs < this._modeCacheTtl) {
      return this._cachedMode;
    }

    const safeSoloSels = this.config.soloIndicatorSelectors.map(s => safeJsValue(s));
    const safeIdeSels = this.config.ideIndicatorSelectors.map(s => safeJsValue(s));

    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var indicators = [];

          // SOLO indicators: sidebar
          var soloSidebar = document.querySelector('.soloaisidebar');
          var sidebarVisible = soloSidebar && soloSidebar.offsetParent !== null;
          if (sidebarVisible) {
            indicators.push('sidebar');
          }

          // IDE indicators: monaco workbench / editor / terminal
          var sels = [${safeIdeSels.join(', ')}];
          for (var i = 0; i < sels.length; i++) {
            var el = document.querySelector(sels[i]);
            if (el && el.offsetParent !== null) {
              indicators.push('ide-' + sels[i].replace(/[^a-zA-Z0-9-]/g, ''));
              break;
            }
          }

          var mode = 'solo';
          var confidence = 0.5;
          if (sidebarVisible) {
            mode = 'solo';
            confidence = 0.9;
          } else if (indicators.length > 0) {
            // If sidebar is absent but IDE elements present → IDE
            mode = 'ide';
            confidence = 0.8;
          } else {
            // Fallback: check if the mode tabs show which is active
            var tabs = document.querySelectorAll('.icube-mode-tab-item');
            for (var j = 0; j < tabs.length; j++) {
              var cls = tabs[j].className || '';
              var txt = (tabs[j].textContent || '').trim();
              if (cls.indexOf('active') > -1 || cls.indexOf('selected') > -1) {
                if (txt.toLowerCase().indexOf('ide') > -1) { mode = 'ide'; confidence = 0.7; }
                else { mode = 'solo'; confidence = 0.7; }
                indicators.push('active-tab-' + txt.toLowerCase());
                break;
              }
            }
          }

          return {
            mode: mode,
            confidence: confidence,
            indicators: indicators
          };
        })()
      `,
      returnByValue: true
    });

    const detection = result.result?.value || { mode: 'solo', confidence: 0.5, indicators: [] };
    this._cachedMode = detection;
    this._cachedModeTs = now;
    return detection;
  }

  /**
   * Invalidate mode cache so next detectMode() re-evaluates from scratch.
   */
  invalidateCache() {
    this._cachedMode = null;
    this._cachedModeTs = 0;
  }
}

module.exports = { ModeDetector };
