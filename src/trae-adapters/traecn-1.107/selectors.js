'use strict';

module.exports = Object.freeze({
  composerSelectors: Object.freeze([
    '.chat-input-v2-input-box-editable'
  ]),
  sendButtonSelectors: Object.freeze([
    'button.chat-input-v2-send-button'
  ]),
  responseSelectors: Object.freeze([
    '.assistant-chat-turn-content',
    "[data-role='assistant']"
  ]),
  activitySelectors: Object.freeze([
    '.chat-content-container',
    '.chat-list-wrapper'
  ]),
  newChatSelectors: Object.freeze([
    "[class*='new-task']",
    "[class*='NewChat']"
  ]),
  modeTabSelectors: Object.freeze([
    '.icube-mode-tab-item-solo',
    '.icube-mode-tab-item-ide',
    '.icube-mode-tab-item'
  ]),
  soloIndicatorSelectors: Object.freeze([
    '.soloaisidebar',
    '.icube-chat-view-container'
  ]),
  ideIndicatorSelectors: Object.freeze([
    '.monaco-workbench',
    '.editor-group-container'
  ])
});
