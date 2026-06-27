'use strict';

/**
 * TaskStateManager — queries and tracks task state from sidebar or IDE panel.
 * Extracted from DomDriver to isolate task-state responsibility.
 */

const { safeJsValue } = require('../shared/utils');

class TaskStateManager {
  constructor(client, config, modeDetector) {
    this.client = client;
    this.config = config;
    this.modeDetector = modeDetector;
  }

  /**
   * Query the SOLO sidebar for task state.
   * Only meaningful in SOLO mode — returns null in IDE mode.
   */
  async queryTaskSidebar(skipText) {
    const safeSkipText = safeJsValue(skipText);
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var sidebar = document.querySelector('.soloaisidebar');
          if (!sidebar) return null;

          var taskItems = sidebar.querySelectorAll('[class*="task-item"]');
          if (!taskItems || !taskItems.length) return null;

          var activeItems = [];
          for (var i = 0; i < taskItems.length; i++) {
            var item = taskItems[i];
            var fullText = item.textContent.trim();

            if (fullText.includes('\u4efb\u52a1\u4e2d\u65ad')) continue;
            if (fullText.includes('\u65b0\u4efb\u52a1') && fullText.length < 15) continue;

            var hasContent = fullText.length > 10;
            var isInProgress = fullText.includes('\u8fdb\u884c\u4e2d') ||
              fullText.includes('\u601d\u8003\u4e2d') ||
              !!item.querySelector('.icd-loading, .agent-loading-dot, [class*="loading"]');

            activeItems.push({
              el: item,
              text: fullText,
              inProgress: isInProgress,
              hasContent: hasContent
            });
          }

          if (activeItems.length === 0) return null;

          var latest = activeItems[activeItems.length - 1];
          var text = latest.text;

          if (text === ${safeSkipText}) return null;
          if (${safeSkipText} && ${safeSkipText}.indexOf(text) >= 0 && text.length <= ${safeSkipText}.length) return null;

          return {
            text: text,
            inProgress: latest.inProgress,
            isComplete: text.includes('\u4efb\u52a1\u5b8c\u6210'),
            hasResponse: latest.hasContent && !latest.inProgress
          };
        })()
      `,
      returnByValue: true
    });

    return result.result?.value || null;
  }

  /**
   * Query the IDE chat panel for task state.
   * Used instead of queryTaskSidebar() in IDE mode.
   */
  async queryIdeTaskPanel(skipText) {
    const safePanelSels = this.config.ideTaskPanelSelectors.map(s => safeJsValue(s));

    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var sels = [${safePanelSels.join(', ')}];
          var panel = null;
          for (var i = 0; i < sels.length; i++) {
            var el = document.querySelector(sels[i]);
            if (el && el.offsetParent !== null) {
              panel = el;
              break;
            }
          }
          if (!panel) return null;

          var fullText = (panel.textContent || '').trim();
          var turns = Array.from(panel.querySelectorAll(
            'section.chat-turn, section[class*="chat-turn"], .chat-message, .agent-message, [class*="chat-message"]'
          )).filter(function(el) {
            return el && el.offsetParent !== null;
          }).map(function(el) {
            return {
              className: (el.className || '').toString(),
              ariaLabel: (el.getAttribute('aria-label') || '').toString(),
              text: ((el.innerText || el.textContent || '').trim() || '')
            };
          }).filter(function(turn) {
            return !!turn.text;
          });

          return {
            fullText: fullText,
            turns: turns
          };
        })()
      `,
      returnByValue: true
    });

    return this._extractLatestIdeAssistantState(result.result?.value, skipText);
  }

  _extractLatestIdeAssistantState(panelState, skipText) {
    if (!panelState) return null;

    const turns = Array.isArray(panelState.turns) ? panelState.turns : [];
    const fullText = String(panelState.fullText || '').trim();
    const normalizedSkip = String(skipText || '').replace(/\s+/g, ' ').trim();
    if (!turns.length) {
      if (!fullText || (normalizedSkip && fullText.replace(/\s+/g, ' ').trim() === normalizedSkip)) {
        return null;
      }
      return {
        text: fullText.slice(0, 500),
        inProgress: false,
        isComplete: fullText.includes('任务完成') || fullText.includes('已完成'),
        hasResponse: fullText.length > 20
      };
    }

    const normalizedTurns = turns
      .map(turn => ({
        className: String(turn.className || ''),
        ariaLabel: String(turn.ariaLabel || ''),
        text: String(turn.text || '').trim()
      }))
      .filter(turn => turn.text);

    let lastUserIdx = -1;
    for (let i = 0; i < normalizedTurns.length; i++) {
      const cls = normalizedTurns[i].className.toLowerCase();
      if (cls.includes('user')) lastUserIdx = i;
    }

    const assistantTurns = normalizedTurns.filter((turn, index) => {
      const cls = turn.className.toLowerCase();
      const aria = turn.ariaLabel.toLowerCase();
      let isAssistant = cls.includes('assistant') || cls.includes('agent') || aria.includes('assistant') || aria.includes('agent');
      if (!isAssistant && cls.includes('chat-turn')) {
        isAssistant = !cls.includes('user');
      }
      return isAssistant && index > lastUserIdx;
    });

    if (!assistantTurns.length && lastUserIdx >= 0) {
      return {
        text: '',
        inProgress: true,
        isComplete: false,
        hasResponse: false,
        awaitingAssistant: true,
        latestUserText: normalizedTurns[lastUserIdx].text
      };
    }

    const latestAssistant = assistantTurns.length ? assistantTurns[assistantTurns.length - 1] : normalizedTurns[normalizedTurns.length - 1];
    const latestText = String(latestAssistant?.text || '').trim();
    const normalizedLatest = latestText.replace(/\s+/g, ' ').trim();
    if (!latestText || (normalizedSkip && normalizedLatest === normalizedSkip)) {
      return null;
    }

    const latestLower = normalizedLatest.toLowerCase();
    const inProgress = (
      fullText.includes('进行中') ||
      fullText.includes('正在思考') ||
      fullText.includes('正在分析') ||
      latestText.includes('正在分析') ||
      latestText.includes('等待中') ||
      latestText.includes('排队') ||
      latestText.includes('思考过程') ||
      latestText.includes('...') ||
      latestText.includes('…') ||
      latestLower.includes('analy') ||
      latestLower.includes('processing') ||
      latestLower.includes('waiting') ||
      latestLower.includes('queue')
    );
    const isComplete = (
      latestText.includes('任务完成') ||
      latestText.includes('已完成') ||
      fullText.includes('任务完成')
    );

    return {
      text: latestText,
      inProgress,
      isComplete: isComplete || (latestText.includes('完成') && !inProgress),
      hasResponse: !inProgress && latestText.length > 20
    };
  }

  isIncompleteResponseText(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return true;
    if (/^(agent|assistant|thought|思考过程)$/i.test(normalized)) return true;
    const lower = normalized.toLowerCase();
    if (/^solo\s*agent\s*思考中/i.test(normalized)) return true;
    const startupSignals = [
      "i'll start",
      'i will start',
      'start by',
      'invoking the relevant',
      'explore the project',
      '调用技能',
      '开始审查',
      '开始分析',
      '正在审查',
      '正在分析',
      '思考中',
      'solo agent思考中',
      'the user explicitly'
    ];
    const hasStartupSignal = startupSignals.some(signal => lower.includes(signal.toLowerCase()));
    const hasFindingSignal = /(^|\n)\s*(findings|finding|问题|风险|建议|结论|summary|审查结果|发现)[:：]/i.test(normalized)
      || /(^|\n)\s*[-*]?\s*\[?p[0-3]\]?/i.test(normalized);
    if (hasStartupSignal && !hasFindingSignal) return true;
    return false;
  }

  isModelErrorResponseText(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    return [
      '模型请求失败',
      '异常打断',
      'model request failed',
      'model service error',
      '服务商错误',
      '展开模型服务商错误信息'
    ].some(signal => normalized.toLowerCase().includes(signal.toLowerCase()));
  }

  /**
   * Mode-aware version: tries sidebar in SOLO mode, chat panel in IDE mode.
   */
  async queryTaskSource(skipText) {
    const modeInfo = await this.modeDetector.detectMode();
    if (modeInfo.mode === 'solo') {
      return this.queryTaskSidebar(skipText);
    }
    return this.queryIdeTaskPanel(skipText);
  }

  async findTaskResponse(skipText) {
    // Try mode-specific task source first
    const taskResult = await this.queryTaskSource(skipText);
    if (taskResult) return taskResult;

    // SOLO fallback: sidebar full-text scan for task blocks
    const modeInfo = await this.modeDetector.detectMode();
    if (modeInfo.mode === 'solo') {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            let sidebar = document.querySelector('.soloaisidebar');
            if (!sidebar) return null;

            let fullText = sidebar.textContent.trim();
            let taskMatch = fullText.match(/\u4efb\u52a1\\d+[^]*?(?=\u5b9e\u65f6|$)/);
            if (taskMatch) {
              let taskText = taskMatch[0].trim();
              if (taskText.length > 5 && !taskText.includes('\u5f00\u59cb\u4f60\u7684\u7b2c\u4e00\u4e2a\u4efb\u52a1') && taskText !== skipText) {
                return {
                  text: taskText,
                  inProgress: fullText.includes('\u8fdb\u884c\u4e2d') || fullText.includes('\u601d\u8003\u4e2d') || !!sidebar.querySelector('.icd-loading, .agent-loading-dot, [class*="loading"]'),
                  isComplete: fullText.includes('\u4efb\u52a1\u5b8c\u6210'),
                  hasResponse: !fullText.includes('\u8fdb\u884c\u4e2d') && !fullText.includes('\u65b0\u4efb\u52a1') && taskText.length > 10
                };
              }
            }

            if (fullText === skipText) return null;
            if (fullText.includes('\u4efb\u52a1') && fullText.length > 20) {
              let isProcessing = fullText.includes('\u8fdb\u884c\u4e2d') || fullText.includes('\u751f\u6210\u4e2d') || fullText.includes('\u601d\u8003\u4e2d') || !!sidebar.querySelector('.icd-loading, .agent-loading-dot, [class*="loading"]');
              return {
                text: fullText.slice(0, 300),
                inProgress: isProcessing,
                isComplete: fullText.includes('\u4efb\u52a1\u5b8c\u6210'),
                hasResponse: !isProcessing && fullText.length > 20 && !fullText.includes('\u65b0\u4efb\u52a1')
              };
            }

            return null;
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || null;
    }

    return null;
  }
}

module.exports = { TaskStateManager };
