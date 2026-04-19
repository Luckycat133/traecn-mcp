'use strict';

const { DomDriver, getConfig } = require('./dom-driver');

class MockDriver extends DomDriver {
  constructor(options = {}) {
    super(null, getConfig());
    this.mockResponses = options.responses || [];
    this.responseIndex = 0;
    this.sentMessages = [];
    this.mode = options.mode || 'solo';
    this.ready = true;
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

  async switchMode(mode) {
    this.mode = mode;
    return true;
  }

  async checkReadiness() {
    return {
      ready: this.ready,
      composer: { matchedSelector: '.mock-composer' },
      sendButton: { matchedSelector: '.mock-send-button' },
      responseRegion: { matchedSelector: '.mock-response' }
    };
  }
}

module.exports = { MockDriver };
