'use strict';

/**
 * WorkspaceGuideHandler — handles workspace guide blockers and dismissal.
 * Extracted from DomDriver to isolate workspace-guide responsibility.
 */

const { safeJsValue } = require('../shared/utils');
const { sleep } = require('../shared/utils');

class WorkspaceGuideHandler {
  constructor(client, config, domHelper, coordinator) {
    this.client = client;
    this.config = config;
    this.domHelper = domHelper;
    this.coordinator = coordinator;
  }

  async inspectWorkspaceBlockers() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const normalize = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
            const controls = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
              .map((el) => {
                const text = normalize(el.innerText || el.textContent || '');
                if (!text) return null;
                const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0, x: 0, y: 0 };
                const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
                const visible = !!(el.offsetParent !== null && rect.width >= 12 && rect.height >= 12);
                if (!visible) return null;
                const clickable = el.tagName === 'BUTTON' ||
                  el.tagName === 'A' ||
                  el.getAttribute('role') === 'button' ||
                  (style && style.cursor === 'pointer');
                if (!clickable) return null;
                return {
                  text,
                  className: typeof el.className === 'string' ? el.className : '',
                  x: rect.x + rect.width / 2,
                  y: rect.y + rect.height / 2
                };
              })
              .filter(Boolean);

            const bodyText = normalize(document.body ? (document.body.innerText || document.body.textContent || '') : '');
            const titleEls = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"], .monaco-dialog-title, [class*="title"], [class*="header"]'))
              .map((el) => normalize(el.innerText || el.textContent || ''))
              .filter(Boolean);
            const guideButtons = controls.filter((item) => /^(继续|下一步|开始使用|完成|知道了|跳过|关闭|稍后)$/i.test(item.text));
            const loginButton = controls.find((item) => /^(登录|登入|log in|login|sign in)$/i.test(item.text)) || null;
            const newTaskButton = controls.find((item) => /^(新建会话|新任务|new task|new chat)$/i.test(item.text)) || null;
            const guideVisible = guideButtons.length > 0 && (
              /solo beta|欢迎使用|快速开始|快捷键|选择主题|继续|开始使用|添加命令行|command line/i.test(bodyText) ||
              titleEls.some((text) => /solo beta|欢迎使用|快速开始|快捷键|选择主题/i.test(text))
            );

            return {
              bodyText,
              titles: titleEls.slice(0, 8),
              guideVisible,
              guideButtons: guideButtons.slice(0, 10),
              loginVisible: !!loginButton,
              loginButton,
              newTaskVisible: !!newTaskButton,
              newTaskButton,
              visibleControls: controls.slice(0, 30)
            };
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || {
        bodyText: '',
        titles: [],
        guideVisible: false,
        guideButtons: [],
        loginVisible: false,
        loginButton: null,
        newTaskVisible: false,
        newTaskButton: null,
        visibleControls: []
      };
    } catch (err) {
      return {
        bodyText: '',
        titles: [],
        guideVisible: false,
        guideButtons: [],
        loginVisible: false,
        loginButton: null,
        newTaskVisible: false,
        newTaskButton: null,
        visibleControls: [],
        error: err.message
      };
    }
  }

  async dismissWorkspaceGuideIfPresent(options = {}) {
    const maxSteps = Number.isFinite(options.maxSteps) ? options.maxSteps : 4;
    const delayMs = Number.isFinite(options.delayMs)
      ? options.delayMs
      : Math.max(this.config.postActionDelayMs, 300);
    const preferredLabels = ['继续', '下一步', '开始使用', '完成', '知道了', '跳过', '关闭', '稍后'];
    let dismissed = 0;

    await this.domHelper.ensureClickHelper();

    for (let step = 0; step < maxSteps; step++) {
      const blockers = await this.coordinator.inspectWorkspaceBlockers();
      if (!blockers.guideVisible) {
        return {
          success: dismissed > 0,
          dismissed,
          guideVisible: false,
          blockers
        };
      }

      const target = (blockers.guideButtons || []).find((button) => preferredLabels.includes(button.text));
      if (!target) {
        return {
          success: false,
          dismissed,
          guideVisible: true,
          reason: 'no_actionable_workspace_guide_button',
          blockers
        };
      }

      const clickResult = await this.client.send('Runtime.evaluate', {
        expression: `window.__enhancedClick(${safeJsValue(target.text)}, true)`,
        returnByValue: true
      });

      if (!clickResult.result?.value?.clicked) {
        return {
          success: false,
          dismissed,
          guideVisible: true,
          reason: 'workspace_guide_click_failed',
          target: target.text
        };
      }

      dismissed += 1;
      await sleep(delayMs);
    }

    const blockers = await this.coordinator.inspectWorkspaceBlockers();
    return {
      success: dismissed > 0 && !blockers.guideVisible,
      dismissed,
      guideVisible: blockers.guideVisible,
      reason: blockers.guideVisible ? 'workspace_guide_max_steps_reached' : null,
      blockers
    };
  }
}

module.exports = { WorkspaceGuideHandler };
