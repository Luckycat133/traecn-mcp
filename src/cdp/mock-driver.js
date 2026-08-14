'use strict';

const { DomDriver, getConfig } = require('./dom-driver');
const { SETTINGS_SECTIONS } = require('./settings-driver');

class MockSettingsDriver {
  constructor() {
    this.currentSection = 'general';
    this.values = new Map();
  }

  async switchTab(section = null) {
    this.currentSection = section || this.currentSection;
    return { tab: 'settings', section: section || null };
  }

  async getContent() {
    const section = this.currentSection || 'general';
    return {
      sections: SETTINGS_SECTIONS,
      items: [
        {
          label: 'Mock setting',
          desc: `Mock value for ${section}`,
          currentValue: this.values.get('Mock setting') || 'enabled',
          hasToggle: true,
          hasDropdown: false,
          hasTextInput: false,
          controlType: 'toggle',
          toggleChecked: this.values.get('Mock setting') !== false,
          visible: true
        }
      ],
      raw: { count: 1, type: 'mock' }
    };
  }

  async listSections() {
    return SETTINGS_SECTIONS.slice();
  }

  async listOptions() {
    return ['enabled', 'disabled'];
  }

  async readAll() {
    const result = {};
    for (const section of SETTINGS_SECTIONS) {
      result[section] = {
        sections: [],
        items: [
          {
            label: `${section} mock setting`,
            desc: 'Mock settings data',
            currentValue: 'enabled',
            hasToggle: true,
            hasDropdown: false,
            hasTextInput: false,
            controlType: 'toggle',
            toggleChecked: true,
            visible: true
          }
        ]
      };
    }
    return result;
  }

  async set(label, value) {
    this.values.set(label, value);
    return { success: true, label, value, mode: 'mock' };
  }

  async setToggle(label, enabled) {
    return this.set(label, enabled);
  }

  async setDropdown(label, value) {
    return this.set(label, value);
  }

  async typeText(label, text) {
    return this.set(label, text);
  }

  async backToChat() {
    return 'mock: back to chat';
  }
}

class MockDriver extends DomDriver {
  constructor(options = {}) {
    super(null, getConfig());
    this.mockResponses = options.responses || [];
    this.responseIndex = 0;
    this.sentMessages = [];
    this.mode = options.mode || 'solo';
    this.ready = true;
    this.model = options.model || 'mock-model';
    this._settingsDriver = new MockSettingsDriver();
  }

  async findComposer() {
    return { nodeId: 1, matchedSelector: '.mock-composer' };
  }

  async findSendButton() {
    return { nodeId: 2, matchedSelector: '.mock-send-button' };
  }

  async findResponseRegion() {
    return { nodeId: 3, matchedSelector: '.mock-response' };
  }

  async findNewChatButton() {
    return { nodeId: 4, matchedSelector: '.mock-new-chat' };
  }

  async findModeTabs() {
    return [
      { nodeId: 5, selector: '.mock-mode-tab', text: 'SOLO' },
      { nodeId: 6, selector: '.mock-mode-tab', text: 'IDE' }
    ];
  }

  async listModels() {
    return {
      current: this.model,
      models: Array.from(new Set([this.model, 'mock-model']))
    };
  }

  async getCurrentModel() {
    return this.model;
  }

  async typeMessage(text) {
    this.sentMessages.push(text);
  }

  async sendMessage(text) {
    this.sentMessages.push(text);
  }

  async collectResponse() {
    if (this.mockResponses.length === 0) {
      return {
        text: 'Mock response from TraeCN',
        stable: true,
        elapsedMs: 100
      };
    }

    const response = this.mockResponses[this.responseIndex % this.mockResponses.length];
    this.responseIndex++;
    return {
      text: response,
      stable: true,
      elapsedMs: 100
    };
  }

  async delegate(task) {
    this.sentMessages.push(task);
    return this.collectResponse();
  }

  async newChat() {
    return true;
  }

  async detectMode() {
    return {
      mode: this.mode,
      confidence: 1,
      indicators: ['mock-driver']
    };
  }

  async listSoloChats() {
    return {
      mode: this.mode === 'solo' ? 'solo' : 'not_solo',
      chats: [],
      count: 0
    };
  }

  async switchMode(mode) {
    const previousMode = this.mode;
    const normalizedMode = String(mode).toLowerCase();
    const alreadyInMode = previousMode === normalizedMode;
    this.mode = normalizedMode;
    return {
      success: true,
      previousMode,
      currentMode: this.mode,
      alreadyInMode
    };
  }

  async switchModel(model) {
    this.model = model;
    return {
      success: true,
      model,
      previousModel: null,
      mode: 'mock'
    };
  }

  async checkForApprovalDialog() {
    return {
      needsApproval: false,
      dialogType: null,
      question: null,
      buttons: [],
      canAutoApprove: false
    };
  }

  async approveDialog(action) {
    return {
      success: false,
      action,
      error: 'No dialog found to approve'
    };
  }

  get settings() {
    return this._settingsDriver;
  }

  async checkReadiness() {
    return {
      ready: this.ready,
      composer: { matchedSelector: '.mock-composer' },
      sendButton: { matchedSelector: '.mock-send-button' },
      responseRegion: { matchedSelector: '.mock-response' }
    };
  }

  async checkQueueStatus() {
    return { queued: false };
  }
}

module.exports = { MockDriver };
