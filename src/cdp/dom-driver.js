'use strict';

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
const { getConfig } = require('./driver-config');
const setupModule = require('./dom-handlers/setup');
const modeModule = require('./dom-handlers/mode-detection');
const panelModule = require('./dom-handlers/panel-capture');
const dialogsModule = require('./dom-handlers/dialogs');
const answerQuestionModule = require('./dom-handlers/answer-question');
const restrictedModule = require('./dom-handlers/restricted-mode');
const messagingModule = require('./dom-handlers/messaging');
const reviewGateModule = require('./dom-handlers/review-gate');
const responseModule = require('./dom-handlers/response-collection');
const soloChatModule = require('./dom-handlers/solo-chat');
const modelModule = require('./dom-handlers/model');

class DomDriver {
  constructor(client, config) {
    this.client = client;
    this.config = config || getConfig();
    this._lastTaskText = '';
    this._pendingUserTask = '';
    this._preSendSnapshot = ''; // body text snapshot before sending task
    this._cachedMode = null;    // cached mode detection result
    this._cachedModeTs = 0;
    this._modeCacheTtl = 5000;  // re-detect after 5s
  }

  // ── Mode detection ─────────────────────────────────────────────────────

  async detectMode() {
    return modeModule.detectMode(this);
  }

  _invalidateModeCache() {
    return modeModule._invalidateModeCache(this);
  }

  /**
   * Inject `window.__enhancedClick` into the page so that repeated inline
   * click-dispatcher code can be replaced with a single function call.
   * The helper searches for the first matching clickable element by text
   * and dispatches PointerEvent → MouseEvent → el.click().
   *
   * @param {string} targetText  - exact text to match against element content
   * @param {boolean} [normalizeText=false] - collapse whitespace before comparing
   * @returns {{ clicked: boolean, text: string }}
   */
  async _ensureClickHelper() {
    return setupModule._ensureClickHelper(this);
  }

  async inspectSetupWizard() {
    return setupModule.inspectSetupWizard(this);
  }

  async completeSetupIfPresent(options = {}) {
    return setupModule.completeSetupIfPresent(this, options);
  }

  async inspectWorkspaceBlockers() {
    return setupModule.inspectWorkspaceBlockers(this);
  }

  async dismissWorkspaceGuideIfPresent(options = {}) {
    return setupModule.dismissWorkspaceGuideIfPresent(this, options);
  }

  // ── Sidebar / panel text capture ───────────────────────────────────────

  async getWorkspaceContext() {
    return panelModule.getWorkspaceContext(this);
  }

  async _captureSidebarText() {
    return panelModule._captureSidebarText(this);
  }

  /**
   * Capture text from the IDE chat panel (used instead of sidebar in IDE mode).
   */
  async _captureIdePanelText() {
    return panelModule._captureIdePanelText(this);
  }

  /**
   * Capture all visible text in the main content area (excluding sidebar & composer).
   */
  async _captureVisibleText() {
    return panelModule._captureVisibleText(this);
  }

  /**
   * Capture document.body innerText as a broad snapshot for text diffing.
   */
  async _captureBodyText() {
    return panelModule._captureBodyText(this);
  }

  /**
   * Scan only the content area for text-containing elements.
   */
  async _scanContentArea() {
    return panelModule._scanContentArea(this);
  }

  // ── Task sidebar / panel querying ──────────────────────────────────────

  /**
   * Query the SOLO sidebar for task state.
   * Only meaningful in SOLO mode — returns null in IDE mode.
   */
  async _queryTaskSidebar(skipText) {
    return panelModule._queryTaskSidebar(this, skipText);
  }

  /**
   * Query the IDE chat panel for task state.
   * Used instead of _queryTaskSidebar() in IDE mode.
   */
  async _queryIdeTaskPanel(skipText) {
    return panelModule._queryIdeTaskPanel(this, skipText);
  }

  _extractLatestIdeAssistantState(panelState, skipText) {
    return panelModule._extractLatestIdeAssistantState(panelState, skipText);
  }

  _isIncompleteResponseText(text) {
    return panelModule._isIncompleteResponseText(text);
  }

  _isModelErrorResponseText(text) {
    return panelModule._isModelErrorResponseText(text);
  }

  /**
   * Mode-aware version: tries sidebar in SOLO mode, chat panel in IDE mode.
   */
  async _queryTaskSource(skipText) {
    return panelModule._queryTaskSource(this, skipText);
  }

  async findTaskResponse() {
    return panelModule.findTaskResponse(this);
  }

  // ── Element finders ────────────────────────────────────────────────────

  async findComposer() {
    return modeModule.findComposer(this);
  }

  async findSendButton() {
    return modeModule.findSendButton(this);
  }

  async findResponseRegion() {
    return modeModule.findResponseRegion(this);
  }

  async _findVisibleElementRuntime(selectors, options = {}) {
    return modeModule._findVisibleElementRuntime(this, selectors, options);
  }

  /**
   * Find new chat button — tries SOLO selectors first, falls back to IDE selectors.
   */
  async findNewChatButton() {
    return modeModule.findNewChatButton(this);
  }

  /**
   * Find mode tabs by selector; uses text matching to avoid false positives
   * from elements that match the selector but aren't mode tabs (e.g., editor tabs).
   */
  async findModeTabs() {
    return modeModule.findModeTabs(this);
  }

  async checkTaskReviewGate() {
    return reviewGateModule.checkTaskReviewGate(this);
  }

  async resolveTaskReviewGate(preferredAction = 'keep_all') {
    return reviewGateModule.resolveTaskReviewGate(this, preferredAction);
  }

  // ── Message UX ─────────────────────────────────────────────────────────

  async typeMessage(text) {
    return messagingModule.typeMessage(this, text);
  }

  async sendMessage(text) {
    return messagingModule.sendMessage(this, text);
  }

  async stopGeneration() {
    return messagingModule.stopGeneration(this);
  }

  // ── Core polling ───────────────────────────────────────────────────────

  /**
   * Core polling method. Checks multiple response sources in priority order:
   * 1. Mode-specific response selectors (sidebar for SOLO, chat panel for IDE)
   * 2. Configured response selectors (generic fallback)
   * 3. Broad content area scan (heuristic-based)
   * 4. Body text diffing (last resort)
   */
  async _pollResponseState() {
    return responseModule._pollResponseState(this);
  }

  async checkForApprovalDialog() {
    return dialogsModule.checkForApprovalDialog(this);
  }

  _assessCommandApproval(command) {
    return dialogsModule._assessCommandApproval(command);
  }

  // ── Delegation ─────────────────────────────────────────────────────────

  /**
   * Mode-aware response collection.
   * In SOLO mode: reads sidebar + heuristics (existing logic).
   * In IDE mode: reads chat panel messages + body text diff.
   */
  async collectResponse() {
    return responseModule.collectResponse(this);
  }


  /**
   * Approve / dismiss a detected dialog by clicking the matching button.
   * @param {string} action - 'trust' | 'allow' | 'confirm' | 'approve' | 'deny' | 'cancel' | 'dismiss'
   * @returns {Promise<{success: boolean, action: string, buttonClicked?: string, error?: string}>}
   */
  async approveDialog(action) {
    return dialogsModule.approveDialog(this, action);
  }

  async answerQuestionDialog(answer) {
    return answerQuestionModule.answerQuestionDialog(this, answer);
  }

  /**
   * Map an approve action to the list of button label patterns to search for.
   * Supports CN and EN labels.
   */
  _getButtonLabelsForAction(action) {
    return dialogsModule._getButtonLabelsForAction(action);
  }

  _summarizeRestrictedModeState(snapshot = {}) {
    return restrictedModule._summarizeRestrictedModeState(snapshot);
  }

  /**
   * Check for restricted mode and click the Trust button if found.
   * Returns the result of the operation.
   */
  async clickRestrictedModeTrust() {
    return restrictedModule.clickRestrictedModeTrust(this);
  }

  async switchAgent(agentName) {
    return messagingModule.switchAgent(this, agentName);
  }

  /**
   * Mode-aware delegation.
   * - Detects current UI mode.
   * - SOLO: uses sidebar (toggles sidebar visibility), tracks task via sidebar.
   * - IDE: no sidebar toggle needed, tracks task via chat panel.
   */
  async delegate(task, options = {}) {
    return messagingModule.delegate(this, task, options);
  }

  async _waitForExpression(expression, timeoutMs = 5000, pollMs = 200) {
    return messagingModule._waitForExpression(this, expression, timeoutMs, pollMs);
  }

  async newChat() {
    return messagingModule.newChat(this);
  }

  async listSoloChats() {
    return soloChatModule.listSoloChats(this);
  }

  async getActiveSoloChat() {
    return soloChatModule.getActiveSoloChat(this);
  }

  async switchSoloChat(criteria = {}) {
    return soloChatModule.switchSoloChat(this, criteria);
  }

  async deleteSoloChats(options = {}) {
    return soloChatModule.deleteSoloChats(this, options);
  }

  /**
   * Mode-aware switchMode.
   * Finds mode tabs by text content (not hardcoded index), clicks the matching tab,
   * waits for UI to re-render, and verifies the switch.
   *
   * @param {'solo'|'ide'} mode - Target mode.
   * @returns {Promise<{success: boolean, previousMode?: string, currentMode?: string}>}
   */
  async switchMode(mode) {
    return modeModule.switchMode(this, mode);
  }

  // ── Model management ───────────────────────────────────────────────────

  static KNOWN_MODELS = modelModule.KNOWN_MODELS;

  async checkQueueStatus(timeoutMs = 5000) {
    return modelModule.checkQueueStatus(this, timeoutMs);
  }

  async _checkQueueStatusRaw() {
    return modelModule._checkQueueStatusRaw(this);
  }

  async getCurrentModel() {
    return modelModule.getCurrentModel(this);
  }

  async listModels() {
    return modelModule.listModels(this);
  }

  _normalizeModelName(name) {
    return modelModule._normalizeModelName(name);
  }

  async switchModel(modelName) {
    return modelModule.switchModel(this, modelName);
  }


  async checkReadiness() {
    return dialogsModule.checkReadiness(this);
  }

  async checkRestrictedMode() {
    return restrictedModule.checkRestrictedMode(this);
  }

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

const DEFAULT_COMPOSER_SELECTORS = require('./driver-config').DEFAULT_COMPOSER_SELECTORS;
const DEFAULT_SEND_BUTTON_SELECTORS = require('./driver-config').DEFAULT_SEND_BUTTON_SELECTORS;
const DEFAULT_RESPONSE_SELECTORS = require('./driver-config').DEFAULT_RESPONSE_SELECTORS;
const DEFAULT_ACTIVITY_SELECTORS = require('./driver-config').DEFAULT_ACTIVITY_SELECTORS;
const DEFAULT_NEW_CHAT_SELECTORS = require('./driver-config').DEFAULT_NEW_CHAT_SELECTORS;
const DEFAULT_MODE_TAB_SELECTORS = require('./driver-config').DEFAULT_MODE_TAB_SELECTORS;
const sanitizeActivityText = require('./driver-config').sanitizeActivityText;
const isTruncationSignal = require('./driver-config').isTruncationSignal;

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
