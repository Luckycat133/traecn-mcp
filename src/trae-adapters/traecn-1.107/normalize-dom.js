'use strict';

const fs = require('fs');

function visibleElements(snapshot, role) {
  return (Array.isArray(snapshot?.elements) ? snapshot.elements : [])
    .filter(element => element?.role === role && element.visible !== false);
}

function normalizeDomSnapshot(snapshot = {}) {
  switch (snapshot.operation) {
    case 'list': {
      const conversations = visibleElements(snapshot, 'conversation');
      return {
        conversationCount: conversations.length,
        activeConversationId: conversations.find(item => item.active === true)?.id || null
      };
    }
    case 'select': {
      const selected = visibleElements(snapshot, 'conversation').find(item => item.active === true);
      return { selectedConversationId: selected?.id || null };
    }
    case 'submit': {
      const composer = visibleElements(snapshot, 'composer')[0];
      const send = visibleElements(snapshot, 'send')[0];
      return {
        composerReady: Boolean(composer && composer.enabled !== false),
        sendReady: Boolean(send && send.enabled !== false)
      };
    }
    case 'queue': {
      const queue = visibleElements(snapshot, 'queue')[0] || {};
      return {
        queueState: queue.state || null,
        queuePosition: Number.isFinite(queue.position) ? queue.position : null
      };
    }
    case 'approval': {
      const approval = visibleElements(snapshot, 'approval')[0] || {};
      return {
        approvalRequired: Boolean(approval.command),
        command: approval.command || null,
        risk: approval.risk || null
      };
    }
    case 'response': {
      const response = visibleElements(snapshot, 'assistant')[0] || {};
      return {
        responseAvailable: Boolean(response.text),
        stable: response.stable === true,
        text: response.text || ''
      };
    }
    case 'review': {
      const review = visibleElements(snapshot, 'review')[0] || {};
      return {
        reviewRequired: review.keepAll === true || review.revertAll === true,
        reviewCount: Number.isFinite(review.reviewCount) ? review.reviewCount : null,
        keepAll: review.keepAll === true,
        revertAll: review.revertAll === true
      };
    }
    default:
      throw new Error(`Unsupported TraeCN fixture operation: ${snapshot.operation || '<missing>'}`);
  }
}

function replayFixture(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (fixture.schemaVersion !== 1 || !Array.isArray(fixture.states)) {
    throw new Error('Unsupported TraeCN fixture schema');
  }
  return {
    source: { ...fixture.source },
    states: fixture.states.map(state => {
      const actual = normalizeDomSnapshot(state);
      return {
        operation: state.operation,
        ok: JSON.stringify(actual) === JSON.stringify(state.expected),
        actual,
        expected: state.expected
      };
    })
  };
}

module.exports = {
  normalizeDomSnapshot,
  replayFixture
};
