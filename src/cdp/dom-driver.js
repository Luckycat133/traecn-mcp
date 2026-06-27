'use strict';

/**
 * DomDriver — lightweight coordinator that delegates to specialized handler classes.
 *
 * Refactored from a 4000+ line god class into a thin facade that composes:
 *   - DOMHelper              (DOM operations & element finding)
 *   - ModeDetector           (solo/ide mode detection)
 *   - TextExtractor          (text capture from various DOM regions)
 *   - SetupWizardHandler     (initial setup wizard flow)
 *   - WorkspaceGuideHandler  (workspace guide blockers & dismissal)
 *   - MessageHandler         (message typing, sending, agent switching)
 *   - TaskStateManager       (task state querying from sidebar/IDE panel)
 *   - DialogHandler          (approval dialogs, review gates, restricted mode)
 *   - ModelManager           (AI model selection & queue status)
 *   - SoloChatManager        (SOLO sidebar chat list/switch/delete)
 *   - ResponsePoller         (response polling & collection)
 *
 * Public API is fully backward-compatible with the original implementation.
 */

const { TraeCNAutomationError } = require('./errors');
const { SettingsDriver } = require('./settings-driver');
const { CommandPaletteDriver } = require('./command-palette-driver');
const { EditorDriver } = require('./editor-driver');
const { FileDriver } = require('./file-driver');
const { TerminalDriver } = require('./terminal-driver');
const { GitDriver } = require('./git-driver');
const { SearchDriver } = require('./search-driver');
const { DiagnosticsDriver } = require('./diagnostics-driver');
const { SnapshotDriver } = require('./snapshot-driver');
const { ExtensionDriver } = require('./extension-driver');
const { sleep, safeJsValue } = require('../shared/utils');
const {
  DEFAULT_COMPOSER_SELECTORS, DEFAULT_SEND_BUTTON_SELECTORS,
  DEFAULT_RESPONSE_SELECTORS, DEFAULT_ACTIVITY_SELECTORS,
  DEFAULT_NEW_CHAT_SELECTORS, DEFAULT_MODE_TAB_SELECTORS,
  getConfig, sanitizeActivityText, isTruncationSignal
} = require('./driver-config');

// Refactored handler classes
const { DOMHelper } = require('./dom-helper');
const { ModeDetector } = require('./mode-detector');
const { TextExtractor } = require('./text-extractor');
const { SetupWizardHandler } = require('./setup-wizard-handler');
const { WorkspaceGuideHandler } = require('./workspace-guide-handler');
const { MessageHandler } = require('./message-handler');
const { TaskStateManager } = require('./task-state-manager');
const { DialogHandler } = require('./dialog-handler');
const { ModelManager } = require('./model-manager');
const { SoloChatManager } = require('./solo-chat-manager');
const { ResponsePoller } = require('./response-poller');

// Re-export shared utilities for backward compatibility
const {
  hasCompletionMarker,
  cleanAssistantResultText,
  DIALOG_BUTTON_SELECTOR
} = require('./dom-driver-utils');

class DomDriver {
  constructor(client, config) {
    this.client = client;
    this.config = config || getConfig();

    // Shared mutable state (accessed by multiple handlers via the coordinator)
    this._lastTaskText = '';
    this._pendingUserTask = '';
    this._preSendSnapshot = '';

    // Compose specialized handlers
    this._domHelper = new DOMHelper(this.client, this.config);
    this._modeDetector = new ModeDetector(this.client, this.config);
    this._textExtractor = new TextExtractor(this.client, this.config);
    this._setupWizardHandler = new SetupWizardHandler(this.client, this.config, this._domHelper, this._modeDetector);
    this._workspaceGuideHandler = new WorkspaceGuideHandler(this.client, this.config, this._domHelper, this);
    this._dialogHandler = new DialogHandler(this.client, this.config, this._domHelper);
    this._messageHandler = new MessageHandler(this.client, this.config, this._domHelper, this._dialogHandler);
    this._taskStateManager = new TaskStateManager(this.client, this.config, this._modeDetector);
    this._modelManager = new ModelManager(this.client, this.config, this._domHelper, this);
    this._soloChatManager = new SoloChatManager(this.client, this.config, this._domHelper);
    this._responsePoller = new ResponsePoller(
      this.client, this.config,
      this._modeDetector, this._taskStateManager,
      this._dialogHandler, this._textExtractor, this
    );
  }

  // ── Mode detection ─────────────────────────────────────────────────────

  async detectMode() {
    return this._modeDetector.detectMode();
  }

  _invalidateModeCache() {
    this._modeDetector.invalidateCache();
  }

  // ── Setup wizard ───────────────────────────────────────────────────────

  async inspectSetupWizard() {
    return this._setupWizardHandler.inspectSetupWizard();
  }

  async completeSetupIfPresent(options = {}) {
    return this._setupWizardHandler.completeSetupIfPresent(options);
  }

  // ── Workspace guide ────────────────────────────────────────────────────

  async inspectWorkspaceBlockers() {
    return this._workspaceGuideHandler.inspectWorkspaceBlockers();
  }

  async dismissWorkspaceGuideIfPresent(options = {}) {
    return this._workspaceGuideHandler.dismissWorkspaceGuideIfPresent(options);
  }

  // ── Text capture ───────────────────────────────────────────────────────

  async _captureSidebarText() {
    return this._textExtractor.captureSidebarText();
  }

  async _captureIdePanelText() {
    return this._textExtractor.captureIdePanelText();
  }

  async _captureVisibleText() {
    return this._textExtractor.captureVisibleText();
  }

  async _captureBodyText() {
    return this._textExtractor.captureBodyText();
  }

  async _scanContentArea() {
    return this._textExtractor.scanContentArea();
  }

  // ── Task state ─────────────────────────────────────────────────────────

  async _queryTaskSidebar(skipText) {
    return this._taskStateManager.queryTaskSidebar(skipText);
  }

  async _queryIdeTaskPanel(skipText) {
    return this._taskStateManager.queryIdeTaskPanel(skipText);
  }

  _extractLatestIdeAssistantState(panelState, skipText) {
    return this._taskStateManager._extractLatestIdeAssistantState(panelState, skipText);
  }

  _isIncompleteResponseText(text) {
    return this._taskStateManager.isIncompleteResponseText(text);
  }

  _isModelErrorResponseText(text) {
    return this._taskStateManager.isModelErrorResponseText(text);
  }

  async _queryTaskSource(skipText) {
    return this._taskStateManager.queryTaskSource(skipText);
  }

  async findTaskResponse() {
    return this._taskStateManager.findTaskResponse(this._lastTaskText);
  }

  // ── Element finders ────────────────────────────────────────────────────

  async findComposer() {
    return this._domHelper.findComposer();
  }

  async findSendButton() {
    return this._domHelper.findSendButton();
  }

  async findResponseRegion() {
    return this._domHelper.findResponseRegion();
  }

  async _findVisibleElementRuntime(selectors, options = {}) {
    return this._domHelper.findVisibleElementRuntime(selectors, options);
  }

  async findNewChatButton() {
    return this._domHelper.findNewChatButton();
  }

  async findModeTabs() {
    return this._domHelper.findModeTabs();
  }

  // ── Click helper ───────────────────────────────────────────────────────

  async _ensureClickHelper() {
    return this._domHelper.ensureClickHelper();
  }

  // ── Dialog / review gate / restricted mode ─────────────────────────────

  async checkTaskReviewGate() {
    return this._dialogHandler.checkTaskReviewGate();
  }

  async resolveTaskReviewGate(preferredAction = 'keep_all') {
    return this._dialogHandler.resolveTaskReviewGate(preferredAction);
  }

  async checkForApprovalDialog() {
    return this._dialogHandler.checkForApprovalDialog();
  }

  async approveDialog(action) {
    return this._dialogHandler.approveDialog(action);
  }

  async answerQuestionDialog(answer) {
    return this._dialogHandler.answerQuestionDialog(answer);
  }

  _getButtonLabelsForAction(action) {
    return this._dialogHandler._getButtonLabelsForAction(action);
  }

  _summarizeRestrictedModeState(snapshot = {}) {
    return this._dialogHandler._summarizeRestrictedModeState(snapshot);
  }

  async clickRestrictedModeTrust() {
    return this._dialogHandler.clickRestrictedModeTrust();
  }

  async checkRestrictedMode() {
    return this._dialogHandler.checkRestrictedMode();
  }

  // ── Message UX ─────────────────────────────────────────────────────────

  async typeMessage(text) {
    return this._messageHandler.typeMessage(text);
  }

  async sendMessage(text) {
    return this._messageHandler.sendMessage(text);
  }

  async stopGeneration() {
    return this._messageHandler.stopGeneration();
  }

  async switchAgent(agentName) {
    return this._messageHandler.switchAgent(agentName);
  }

  // ── Response polling ───────────────────────────────────────────────────

  async _pollResponseState() {
    // Sync shared state before polling
    this._responsePoller._lastTaskText = this._lastTaskText;
    this._responsePoller._pendingUserTask = this._pendingUserTask;
    this._responsePoller._preSendSnapshot = this._preSendSnapshot;
    return this._responsePoller._pollResponseState();
  }

  async collectResponse() {
    // Sync shared state before collecting
    this._responsePoller._lastTaskText = this._lastTaskText;
    this._responsePoller._pendingUserTask = this._pendingUserTask;
    this._responsePoller._preSendSnapshot = this._preSendSnapshot;
    return this._responsePoller.collectResponse();
  }

  // ── Model management ───────────────────────────────────────────────────

  static get KNOWN_MODELS() {
    return ModelManager.KNOWN_MODELS;
  }

  async checkQueueStatus(timeoutMs = 5000) {
    return this._modelManager.checkQueueStatus(timeoutMs);
  }

  async _checkQueueStatusRaw() {
    return this._modelManager._checkQueueStatusRaw();
  }

  async getCurrentModel() {
    return this._modelManager.getCurrentModel();
  }

  _normalizeModelName(name) {
    return this._modelManager._normalizeModelName(name);
  }

  async switchModel(modelName) {
    return this._modelManager.switchModel(modelName);
  }

  // ── SOLO chat management ───────────────────────────────────────────────

  async listSoloChats() {
    return this._soloChatManager.listSoloChats();
  }

  async _findSoloChatActionPoint(candidate = {}) {
    return this._soloChatManager._findSoloChatActionPoint(candidate);
  }

  async _findSoloDeleteMenuPoint(anchorPoint = {}) {
    return this._soloChatManager._findSoloDeleteMenuPoint(anchorPoint);
  }

  async _findSoloDeleteConfirmPoint() {
    return this._soloChatManager._findSoloDeleteConfirmPoint();
  }

  _normalizeSoloChatDeleteMatchText(value) {
    return this._soloChatManager._normalizeSoloChatDeleteMatchText(value);
  }

  _soloChatMatchesDeleteCandidate(chat = {}, candidate = {}) {
    return this._soloChatManager._soloChatMatchesDeleteCandidate(chat, candidate);
  }

  async deleteSoloChats(options = {}) {
    return this._soloChatManager.deleteSoloChats(options);
  }

  async getActiveSoloChat() {
    return this._soloChatManager.getActiveSoloChat();
  }

  async switchSoloChat(criteria = {}) {
    const result = await this._soloChatManager.switchSoloChat(criteria);
    if (result.success) {
      this._lastTaskText = '';
      this._pendingUserTask = '';
      this._preSendSnapshot = '';
    }
    return result;
  }

  // ── Mouse helpers ──────────────────────────────────────────────────────

  async _dispatchTrustedMouseClick(point, options = {}) {
    return this._domHelper.dispatchTrustedMouseClick(point, options);
  }

  async _waitForExpression(expression, timeoutMs = 5000, pollMs = 200) {
    return this._domHelper.waitForExpression(expression, timeoutMs, pollMs);
  }

  // ── Mode switching ─────────────────────────────────────────────────────

  async switchMode(mode) {
    this._invalidateModeCache();
    const currentModeInfo = await this.detectMode();

    const modeLower = mode.toLowerCase();
    if (currentModeInfo.mode === modeLower) {
      return { success: true, previousMode: currentModeInfo.mode, currentMode: modeLower, alreadyInMode: true };
    }

    const modeTabs = await this.findModeTabs();

    const relevantTabs = modeTabs.filter(t => {
      const lower = t.text.toLowerCase();
      return lower.includes('solo') || lower.includes('ide') || lower.includes('编辑器');
    });

    const targetTextKeywords = modeLower === 'solo' ? ['solo', '编辑器'] : ['ide'];
    const target = relevantTabs.find(t => {
      const lower = t.text.toLowerCase();
      return targetTextKeywords.some(k => lower.includes(k));
    });

    if (!target) {
      const activeTab = relevantTabs.find(t => {
        return currentModeInfo.indicators.some(i => i.includes(t.text.toLowerCase()));
      });
      const otherTab = relevantTabs.find(t => {
        if (!activeTab) return t.text.toLowerCase().includes(modeLower);
        return t.nodeId !== activeTab.nodeId;
      });

      if (otherTab) {
        await this.client.send('Runtime.evaluate', {
          expression: `
            (function() {
              var el = document.querySelector('[node-id="${otherTab.nodeId}"]');
              if (!el) {
                var items = document.querySelectorAll('.icube-mode-tab-item, [class*="icube-mode-tab-item"], [class*="mode-tab"]');
                for (var i = 0; i < items.length; i++) {
                  var t = items[i].textContent.trim().toLowerCase();
                  if (t.indexOf('${modeLower}') > -1) {
                    items[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    return 'clicked by text match';
                  }
                }
                return 'target tab not found';
              }
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              return 'clicked by node-id';
            })()
          `,
          returnByValue: true
        });
        await sleep(this.config.modeSwitchWaitMs);
      } else {
        return { success: false, previousMode: currentModeInfo.mode, error: 'Target mode tab not found' };
      }
    } else {
      await this.client.send('DOM.focus', { nodeId: target.nodeId });
      await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var items = document.querySelectorAll('.icube-mode-tab-item');
            for (var i = 0; i < items.length; i++) {
              var t = items[i].textContent.trim().toLowerCase();
              if (t.indexOf('${modeLower}') > -1) {
                items[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return 'clicked tab: ' + items[i].textContent.trim();
              }
            }
            return 'tab click attempted';
          })()
        `,
        returnByValue: true
      });
      await sleep(this.config.modeSwitchWaitMs);
    }

    this._invalidateModeCache();
    const maxWait = this.config.modeSwitchWaitMs + 3000;
    const pollStart = Date.now();
    let switchedToMode = null;

    while (Date.now() - pollStart < maxWait) {
      const verifyInfo = await this.detectMode();
      if (verifyInfo.mode === modeLower) {
        switchedToMode = verifyInfo.mode;
        break;
      }
      await sleep(300);
    }

    if (switchedToMode === modeLower) {
      return { success: true, previousMode: currentModeInfo.mode, currentMode: modeLower };
    }

    return { success: true, previousMode: currentModeInfo.mode, currentMode: modeLower, verifyLimited: true };
  }

  // ── Task delegation ────────────────────────────────────────────────────

  async delegate(task, options = {}) {
    await this.newChat();
    this._invalidateModeCache();

    const modeInfo = await this.detectMode();
    const isIdeMode = modeInfo.mode === 'ide';

    if (!isIdeMode) {
      await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var sidebar = document.querySelector('.soloaisidebar');
            if (!sidebar || sidebar.offsetHeight < 100) {
              document.body.focus();
              document.body.dispatchEvent(new KeyboardEvent('keydown', {
                key: 't', code: 'KeyT',
                ctrlKey: true, metaKey: true, bubbles: true
              }));
              return 'toggled sidebar';
            }
            return 'sidebar already visible';
          })()
        `,
        returnByValue: true
      });
      await sleep(500);

      const beforeSidebar = await this._captureSidebarText();
      this._lastTaskText = beforeSidebar;
    } else {
      const beforePanel = await this._captureIdePanelText();
      this._lastTaskText = beforePanel;
    }

    if (options.agent) {
      await this.switchAgent(options.agent);
    }

    var effectiveTask = task;
    if (options.mode) {
      var modeRaw = options.mode.startsWith('/') ? options.mode.slice(1) : options.mode;
      if (isIdeMode) {
        var modeHints = {
          plan: '请先制定详细的实施方案和计划，然后逐步执行：',
          spec: '请编写详细的技术规格说明和设计方案：',
          review: '请审查以下内容，指出问题、风险和改进建议：',
          fix: '请修复以下问题，确保代码正确运行：',
          test: '请编写全面的单元测试覆盖以下功能：',
          explain: '请解释以下代码的工作原理和各部分作用：'
        };
        var hint = modeHints[modeRaw];
        effectiveTask = hint ? (hint + ' ' + task) : task;
      } else {
        effectiveTask = '/' + modeRaw + ' ' + task;
      }
    }

    const beforeBody = await this._captureBodyText();
    this._preSendSnapshot = beforeBody;

    const dialogBefore = await this.checkForApprovalDialog();
    if (dialogBefore.needsApproval) {
      return { text: '', stable: false, elapsedMs: 0, needsApproval: true, question: dialogBefore.question, dialogType: dialogBefore.dialogType };
    }

    await this.sendMessage(effectiveTask);
    const response = await this.collectResponse();

    if (response && response.text) {
      this._lastTaskText = response.text;
    }
    this._pendingUserTask = '';

    if (response.timedOut && !response.text) {
      throw TraeCNAutomationError.responseTimeout(this.config.timeoutMs);
    }

    return response;
  }

  async newChat() {
    const existingReviewGate = await this.checkTaskReviewGate();
    if (existingReviewGate.awaitingReview && existingReviewGate.reviewCount !== 0) {
      const gateResolution = await this.resolveTaskReviewGate('keep_all');
      if (!gateResolution.success) {
        throw new Error(`Task review gate blocked new chat: ${gateResolution.reason || gateResolution.error || 'unknown'}`);
      }
      await sleep(this.config.postActionDelayMs * 2);
    }

    const previousPanelText = await this._captureIdePanelText();

    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'n', code: 'KeyN', modifiers: 6
    });
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'n', code: 'KeyN', modifiers: 6
    });

    const safeComposerSels = safeJsValue(this.config.composerSelectors);
    const ready = await this._waitForExpression(
      `(function(){var s=${safeComposerSels};for(var i=0;i<s.length;i++){var e=document.querySelector(s[i]);if(e&&e.getBoundingClientRect().width>20&&e.offsetParent!==null)return true;}return false;})()`,
      4000, 200
    );
    if (!ready) await sleep(2000);

    let panelChanged = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const panelText = await this._captureIdePanelText();
      if (!previousPanelText || !panelText || panelText !== previousPanelText) {
        panelChanged = true;
        break;
      }
      await sleep(250);
    }

    if (!panelChanged) {
      const newChatButton = await this.findNewChatButton();
      if (newChatButton && newChatButton.nodeId) {
        const dom = require('./browser-dom');
        await dom.clickNode(this.client, newChatButton.nodeId);
        await sleep(this.config.postActionDelayMs * 2);
        for (let attempt = 0; attempt < 8; attempt++) {
          const panelText = await this._captureIdePanelText();
          if (!previousPanelText || !panelText || panelText !== previousPanelText) {
            panelChanged = true;
            break;
          }
          await sleep(250);
        }
      }
    }

    if (!panelChanged && previousPanelText) {
      throw new Error('Failed to open a fresh chat while an existing task was still active');
    }

    this._lastTaskText = '';
    this._pendingUserTask = '';
    this._preSendSnapshot = '';
    return true;
  }

  // ── Readiness check ────────────────────────────────────────────────────

  async checkReadiness() {
    let composer = await this.findComposer();
    let sendBtn = await this.findSendButton();
    let response = await this.findResponseRegion();
    let workspaceGuide = null;
    let composerFallback = null;
    let sendBtnFallback = null;

    if (!(composer && sendBtn)) {
      workspaceGuide = await this.dismissWorkspaceGuideIfPresent();
      if (workspaceGuide.dismissed > 0 || workspaceGuide.success) {
        composer = await this.findComposer();
        sendBtn = await this.findSendButton();
        response = await this.findResponseRegion();
      }
    }

    if (!composer) {
      composerFallback = await this._findVisibleElementRuntime(this.config.composerSelectors, { allowDisabled: true });
    }
    if (!sendBtn) {
      sendBtnFallback = await this._findVisibleElementRuntime(this.config.sendButtonSelectors, { allowDisabled: true });
    }

    let modeInfo = null;
    try {
      modeInfo = await this.detectMode();
    } catch(e) {
      modeInfo = { mode: 'unknown', confidence: 0, indicators: [] };
    }

    const blockers = await this.inspectWorkspaceBlockers();
    const restricted = await this.checkRestrictedMode();
    const dialog = await this.checkForApprovalDialog();
    let blocker = null;
    const composerReady = !!(composer || composerFallback);
    const sendButtonReady = !!(sendBtn || sendBtnFallback);
    if (!(composerReady && sendButtonReady)) {
      if (dialog.needsApproval) blocker = 'approval_dialog';
      else if (restricted.restricted) blocker = 'trust_workspace';
      else if (blockers.guideVisible) blocker = 'workspace_guide';
      else if (blockers.loginVisible) blocker = 'login_required';
      else if (blockers.newTaskVisible) blocker = 'open_task_panel';
      else blocker = 'composer_unavailable';
    }

    return {
      ready: !!(composerReady && sendButtonReady),
      composer: composer ? { matchedSelector: composer.matchedSelector } : (composerFallback ? {
        matchedSelector: composerFallback.matchedSelector,
        runtimeFallback: true
      } : null),
      sendButton: sendBtn ? { matchedSelector: sendBtn.matchedSelector } : (sendBtnFallback ? {
        matchedSelector: sendBtnFallback.matchedSelector,
        runtimeFallback: true,
        disabled: sendBtnFallback.disabled === true
      } : null),
      responseRegion: response ? { matchedSelector: response.matchedSelector } : null,
      mode: modeInfo,
      blocker,
      workspaceGuide: workspaceGuide ? {
        success: workspaceGuide.success === true,
        dismissed: workspaceGuide.dismissed || 0,
        guideVisible: workspaceGuide.guideVisible === true,
        reason: workspaceGuide.reason || null
      } : null,
      blockers: {
        guideVisible: blockers.guideVisible === true,
        guideButtons: Array.isArray(blockers.guideButtons) ? blockers.guideButtons.map(item => item.text).slice(0, 6) : [],
        loginVisible: blockers.loginVisible === true,
        newTaskVisible: blockers.newTaskVisible === true
      }
    };
  }

  // ── Sub-driver accessors (lazy initialization) ─────────────────────────

  get settings() {
    if (!this._settingsDriver) {
      this._settingsDriver = new SettingsDriver(this.client, this.config);
    }
    return this._settingsDriver;
  }

  get palette() {
    if (!this._paletteDriver) {
      this._paletteDriver = new CommandPaletteDriver(this.client, this.config);
    }
    return this._paletteDriver;
  }

  get editor() {
    if (!this._editorDriver) {
      this._editorDriver = new EditorDriver(this.client, this.config, { palette: this.palette });
    }
    return this._editorDriver;
  }

  get file() {
    if (!this._fileDriver) {
      this._fileDriver = new FileDriver(this.client, this.config, { palette: this.palette });
    }
    return this._fileDriver;
  }

  get terminal() {
    if (!this._terminalDriver) {
      this._terminalDriver = new TerminalDriver(this.client, this.config, { palette: this.palette });
    }
    return this._terminalDriver;
  }

  get git() {
    if (!this._gitDriver) {
      this._gitDriver = new GitDriver(this.client, this.config, { palette: this.palette });
    }
    return this._gitDriver;
  }

  get search() {
    if (!this._searchDriver) {
      this._searchDriver = new SearchDriver(this.client, this.config, { palette: this.palette });
    }
    return this._searchDriver;
  }

  get diagnostics() {
    if (!this._diagnosticsDriver) {
      this._diagnosticsDriver = new DiagnosticsDriver(this.client, this.config, { palette: this.palette });
    }
    return this._diagnosticsDriver;
  }

  get snapshot() {
    if (!this._snapshotDriver) {
      this._snapshotDriver = new SnapshotDriver(this.client, this.config);
    }
    return this._snapshotDriver;
  }

  get extension() {
    if (!this._extensionDriver) {
      this._extensionDriver = new ExtensionDriver(this.client, this.config, { palette: this.palette });
    }
    return this._extensionDriver;
  }
}

module.exports = {
  DomDriver,
  getConfig,
  sanitizeActivityText,
  isTruncationSignal,
  DEFAULT_COMPOSER_SELECTORS,
  DEFAULT_SEND_BUTTON_SELECTORS,
  DEFAULT_RESPONSE_SELECTORS,
  DEFAULT_ACTIVITY_SELECTORS,
  DEFAULT_NEW_CHAT_SELECTORS,
  DEFAULT_MODE_TAB_SELECTORS,
  SettingsDriver,
  CommandPaletteDriver,
  EditorDriver,
  FileDriver,
  TerminalDriver,
  GitDriver,
  SearchDriver,
  DiagnosticsDriver,
  SnapshotDriver,
  ExtensionDriver
};
