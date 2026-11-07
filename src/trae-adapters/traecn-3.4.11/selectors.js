'use strict';

const legacy = require('../traecn-1.107/selectors');

module.exports = Object.freeze({
  ...legacy,
  activitySelectors: Object.freeze([
    '.initial-chat-panel',
    ...legacy.activitySelectors
  ]),
  newChatSelectors: Object.freeze([
    '.task-list-new-task-item:not(.task-list-skills-item)',
    ...legacy.newChatSelectors
  ]),
  soloIndicatorSelectors: Object.freeze([
    'body.solo-lite',
    'body.solo-mode',
    ...legacy.soloIndicatorSelectors
  ])
});
