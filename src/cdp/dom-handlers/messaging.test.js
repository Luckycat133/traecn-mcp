'use strict';

const assert = require('assert');
const vm = require('vm');
const { sendMessage } = require('./messaging');
const { TraeCNAutomationError } = require('../errors');
const { createRunner } = require('../../shared/test-runner');
const r = createRunner('messaging.test.js');
const { asyncTest, pendingAsyncTests, summary } = r;

function submissionFixture({ trigger = 'keyboard', rendered = false, disabled = false, missingButton = false, missingComposer = false, badInput = false, trustedOnly = false, nativeDisabled = false, ariaDisabled = false, hiddenFirst = false, blocked = false } = {}) {
  const expected = '确认真实提交 <task> -> 保留原任务身份';
  const events = [];
  let composerText = '';
  let sends = 0;
  let fallbackTyping = 0;
  let pressed = false;
  let modelClicks = 0;
  const submit = () => {
    sends++;
    composerText = '';
  };
  const composer = { focus() {}, get innerText() { return composerText; }, get textContent() { return composerText; } };
  const button = {
    disabled: nativeDisabled,
    className: disabled ? 'chat-input-v2-send-button disabled' : 'chat-input-v2-send-button',
    classList: { contains: value => value === 'disabled' && disabled },
    getAttribute: name => name === 'aria-disabled' && ariaDisabled ? 'true' : null,
    getBoundingClientRect: () => ({ x: 714, y: 798, width: 24, height: 24 }),
    contains: node => node === button,
    dispatchEvent(event) { if (!trustedOnly && event.type === 'click') submit(); }
  };
  const hiddenButton = {
    ...button,
    hidden: true,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    dispatchEvent() {}
  };
  const modelButton = { className: 'icd-model-select-trigger' };
  const buttons = missingButton ? [] : hiddenFirst ? [hiddenButton, button] : [button];
  const document = {
    querySelector(selector) {
      if (selector === '.chat-input-v2-input-box-editable') return missingComposer ? null : composer;
      if (selector === 'button.chat-input-v2-send-button') return buttons[0] || null;
      return null;
    },
    querySelectorAll: selector => selector === 'button.chat-input-v2-send-button' ? buttons : [],
    elementFromPoint: () => blocked ? modelButton : button,
    body: { get innerText() { return rendered && sends ? expected : 'Earlier unrelated conversation'; } }
  };
  const evaluate = expression => vm.runInNewContext(expression, {
    document,
    window: { innerWidth: 1024, innerHeight: 900, getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible' }) },
    MouseEvent: class { constructor(type) { this.type = type; } }
  });
  const driver = {
    config: {
      composerSelectors: ['.chat-input-v2-input-box-editable'],
      sendButtonSelectors: ['button.chat-input-v2-send-button'],
      postActionDelayMs: 0, sendTrigger: trigger
    },
    checkTaskReviewGate: async () => ({ awaitingReview: false, reviewCount: 0 }),
    async typeMessage(text) { fallbackTyping++; composerText = badInput ? 'unverified input' : text; },
    async _waitForExpression(expression, timeoutMs, pollMs) {
      assert.strictEqual(timeoutMs, 5000);
      assert.strictEqual(pollMs, 200);
      return Boolean(evaluate(expression));
    },
    client: { async send(method, payload) {
      events.push({ method, ...payload });
      if (method === 'Runtime.evaluate') {
        const value = evaluate(payload.expression);
        return { result: { value: JSON.parse(JSON.stringify(value)) } };
      }
      if (method === 'Input.insertText') {
        composerText = badInput ? 'unverified input' : payload.text;
        return {};
      }
      if (method === 'Input.dispatchKeyEvent') {
        if (payload.key === 'Backspace' && payload.type === 'keyDown') composerText = '';
        if (payload.key === 'Enter' && payload.type === 'keyDown') submit();
        return {};
      }
      if (method === 'Input.dispatchMouseEvent') {
        if (payload.type === 'mouseMoved') return {};
        if (payload.x !== 726 || payload.y !== 810 || blocked) {
          if (payload.type === 'mouseReleased') modelClicks++;
          return {};
        }
        if (disabled || nativeDisabled || ariaDisabled) return {};
        if (payload.type === 'mousePressed') pressed = true;
        if (payload.type === 'mouseReleased' && pressed) {
          pressed = false;
          submit();
        }
        return {};
      }
      throw new Error('Unexpected CDP method: ' + method);
    } }
  };
  return { driver, expected, sends: () => sends, fallbackTyping: () => fallbackTyping, modelClicks: () => modelClicks, events };
}

asyncTest('an enabled native send button accepts one trusted click at its own coordinates', async () => {
  const fixture = submissionFixture({ trigger: 'button', rendered: true, trustedOnly: true });
  await sendMessage(fixture.driver, fixture.expected);
  assert.strictEqual(fixture.sends(), 1);
  assert.strictEqual(fixture.modelClicks(), 0);
  assert.strictEqual(fixture.driver._pendingUserTask, fixture.expected);
  const clicks = fixture.events.filter(event => event.method === 'Input.dispatchMouseEvent');
  assert.deepStrictEqual(clicks.map(event => [event.type, event.x, event.y]), [
    ['mouseMoved', 726, 810], ['mousePressed', 726, 810], ['mouseReleased', 726, 810]
  ]);
  assert.strictEqual(fixture.events.filter(event => event.key === 'Enter').length, 0);
});

asyncTest('native and aria-disabled send buttons do not dispatch or fall back to Enter', async () => {
  for (const disability of [{ nativeDisabled: true }, { ariaDisabled: true }]) {
    const fixture = submissionFixture({ trigger: 'button', ...disability });
    await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
      assert.strictEqual(error.details.submissionDispatched, undefined);
      return error.code === 'SEND_FAILED';
    });
    assert.strictEqual(fixture.sends(), 0);
    assert.strictEqual(fixture.events.filter(event => event.method === 'Input.dispatchMouseEvent' || event.key === 'Enter').length, 0);
  }
});

asyncTest('a hidden mounted send button does not mask the visible button in the active viewport', async () => {
  const fixture = submissionFixture({ trigger: 'button', rendered: true, trustedOnly: true, hiddenFirst: true });
  await sendMessage(fixture.driver, fixture.expected);
  assert.strictEqual(fixture.sends(), 1);
  assert.strictEqual(fixture.modelClicks(), 0);
});

asyncTest('an overlapping model control prevents a send click instead of receiving it', async () => {
  const fixture = submissionFixture({ trigger: 'button', rendered: true, blocked: true });
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.details.submissionDispatched, undefined);
    return error.code === 'SEND_FAILED';
  });
  assert.strictEqual(fixture.sends(), 0);
  assert.strictEqual(fixture.modelClicks(), 0);
  assert.strictEqual(fixture.events.filter(event => event.method === 'Input.dispatchMouseEvent' || event.key === 'Enter').length, 0);
});

asyncTest('a mouse move RPC failure remains a pre-dispatch failure', async () => {
  const fixture = submissionFixture({ trigger: 'button', rendered: true });
  const failure = TraeCNAutomationError.cdpDisconnected('offline mouse move connection loss');
  const send = fixture.driver.client.send;
  fixture.driver.client.send = async (method, payload) => {
    if (method === 'Input.dispatchMouseEvent' && payload.type === 'mouseMoved') throw failure;
    return send(method, payload);
  };
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => error === failure);
  assert.strictEqual(failure.details.submissionDispatched, undefined);
  assert.strictEqual(fixture.sends(), 0);
});

asyncTest('a mouse press RPC with an unknown delivery remains uncertain without a second dispatch', async () => {
  const fixture = submissionFixture({ trigger: 'button', rendered: true });
  const failure = TraeCNAutomationError.cdpTimeout('Input.dispatchMouseEvent', 30000);
  const send = fixture.driver.client.send;
  fixture.driver.client.send = async (method, payload) => {
    if (method === 'Input.dispatchMouseEvent' && payload.type === 'mousePressed') throw failure;
    return send(method, payload);
  };
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.code, 'SEND_FAILED');
    assert.strictEqual(error.details.submissionDispatched, true);
    assert.strictEqual(error.details.timeoutMs, 30000);
    return true;
  });
  assert.strictEqual(fixture.sends(), 0);
  assert.strictEqual(fixture.events.filter(event => event.key === 'Enter').length, 0);
});

asyncTest('keyboard dispatch with a failed visibility confirmation is explicitly uncertain', async () => {
  const fixture = submissionFixture();
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.code, 'SEND_FAILED');
    assert.strictEqual(error.details.submissionDispatched, true);
    assert.match(error.message, /did not appear/);
    return true;
  });
  assert.strictEqual(fixture.sends(), 1);
  assert.strictEqual(fixture.events.filter(event => event.key === 'Enter' && event.type === 'keyDown').length, 1);
});

asyncTest('button dispatch with a failed confirmation is marked without sending a second message', async () => {
  const fixture = submissionFixture({ trigger: 'button' });
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.details.submissionDispatched, true);
    return error.code === 'SEND_FAILED';
  });
  assert.strictEqual(fixture.sends(), 1);
  assert.strictEqual(fixture.events.filter(event => event.key === 'Enter').length, 0);
});

asyncTest('a disabled send button with no dispatch retains the ordinary send failure contract', async () => {
  const fixture = submissionFixture({ trigger: 'button', disabled: true });
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.details.submissionDispatched, undefined);
    return error.code === 'SEND_FAILED';
  });
  assert.strictEqual(fixture.sends(), 0);
});

asyncTest('the missing-button keyboard fallback records the actual dispatch attempt', async () => {
  const fixture = submissionFixture({ trigger: 'button', missingButton: true });
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.details.submissionDispatched, true);
    return error.code === 'SEND_FAILED';
  });
  assert.strictEqual(fixture.sends(), 1);
});

asyncTest('composer focus failure cannot be mistaken for a dispatched submission', async () => {
  const fixture = submissionFixture({ missingComposer: true });
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.details.submissionDispatched, undefined);
    return error.code === 'COMPOSER_FOCUS_FAILED';
  });
  assert.strictEqual(fixture.sends(), 0);
});

asyncTest('unverified composer input remains a pre-dispatch failure after fallback typing', async () => {
  const fixture = submissionFixture({ badInput: true });
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.details.submissionDispatched, undefined);
    return error.code === 'COMPOSER_INPUT_FAILED';
  });
  assert.strictEqual(fixture.fallbackTyping(), 1);
  assert.strictEqual(fixture.sends(), 0);
});

asyncTest('a normally confirmed message still sends exactly once and preserves the expected task text', async () => {
  for (const trigger of ['keyboard', 'button']) {
    const fixture = submissionFixture({ trigger, rendered: true });
    await sendMessage(fixture.driver, fixture.expected);
    assert.strictEqual(fixture.sends(), 1);
    assert.strictEqual(fixture.driver._pendingUserTask, fixture.expected);
  }
});

asyncTest('an Enter dispatch RPC rejected before acknowledgement remains uncertain', async () => {
  const fixture = submissionFixture();
  const failure = TraeCNAutomationError.cdpDisconnected('offline dispatch connection loss');
  const send = fixture.driver.client.send;
  fixture.driver.client.send = async (method, payload) => {
    if (method === 'Input.dispatchKeyEvent' && payload.key === 'Enter' && payload.type === 'keyDown') throw failure;
    return send(method, payload);
  };
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.code, 'SEND_FAILED');
    assert.strictEqual(error.details.submissionDispatched, true);
    assert.strictEqual(error.details.reason, failure.details.reason);
    assert.match(error.message, /offline dispatch connection loss/);
    return true;
  });
  assert.strictEqual(fixture.sends(), 0);
  assert.strictEqual(failure.details.submissionDispatched, undefined);
});

asyncTest('an Enter dispatch that loses its acknowledgement does not lose the uncertainty marker', async () => {
  const fixture = submissionFixture();
  const failure = TraeCNAutomationError.cdpTimeout('Input.dispatchKeyEvent', 30000);
  const send = fixture.driver.client.send;
  fixture.driver.client.send = async (method, payload) => {
    const result = await send(method, payload);
    if (method === 'Input.dispatchKeyEvent' && payload.key === 'Enter' && payload.type === 'keyDown') throw failure;
    return result;
  };
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.code, 'SEND_FAILED');
    assert.strictEqual(error.details.submissionDispatched, true);
    assert.strictEqual(error.details.timeoutMs, 30000);
    assert.match(error.message, /CDP method timed out/);
    return true;
  });
  assert.strictEqual(fixture.sends(), 1);
});

asyncTest('an Enter keyUp RPC failure preserves the original send error and prevents a retry classification', async () => {
  const fixture = submissionFixture();
  const failure = TraeCNAutomationError.sendFailed('-32000: offline keyUp RPC failure');
  const send = fixture.driver.client.send;
  fixture.driver.client.send = async (method, payload) => {
    if (method === 'Input.dispatchKeyEvent' && payload.key === 'Enter' && payload.type === 'keyUp') throw failure;
    return send(method, payload);
  };
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.code, 'SEND_FAILED');
    assert.strictEqual(error.message, failure.message);
    assert.strictEqual(error.details.cause, failure.details.cause);
    assert.strictEqual(error.details.submissionDispatched, true);
    return true;
  });
  assert.strictEqual(fixture.sends(), 1);
});

asyncTest('a rejected button dispatch RPC is uncertain both before and after observable delivery', async () => {
  for (const delivered of [false, true]) {
    const fixture = submissionFixture({ trigger: 'button' });
    const failure = TraeCNAutomationError.sendFailed('-32000: offline click RPC failure');
    const send = fixture.driver.client.send;
    fixture.driver.client.send = async (method, payload) => {
      if (method === 'Input.dispatchMouseEvent' && payload.type === 'mouseReleased') {
        if (delivered) await send(method, payload);
        throw failure;
      }
      return send(method, payload);
    };
    await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
      assert.strictEqual(error.code, 'SEND_FAILED');
      assert.strictEqual(error.message, failure.message);
      assert.strictEqual(error.details.submissionDispatched, true);
      return true;
    });
    assert.strictEqual(fixture.sends(), delivered ? 1 : 0);
    assert.strictEqual(failure.details.submissionDispatched, undefined);
  }
});

asyncTest('a button inspection Runtime exception cannot be mistaken for a dispatched submission', async () => {
  const fixture = submissionFixture({ trigger: 'button' });
  const send = fixture.driver.client.send;
  fixture.driver.client.send = async (method, payload) => {
    const result = await send(method, payload);
    if (method === 'Runtime.evaluate' && payload.expression.includes('elementFromPoint')) {
      return { result: { type: 'object', subtype: 'error' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'offline post-click error' } } };
    }
    return result;
  };
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.code, 'SEND_FAILED');
    assert.strictEqual(error.details.submissionDispatched, undefined);
    return true;
  });
  assert.strictEqual(fixture.sends(), 0);
  assert.strictEqual(fixture.events.filter(event => event.key === 'Enter').length, 0);
});

asyncTest('confirmation RPC failures of any error type after a dispatch retain their details and uncertainty', async () => {
  for (const failure of [
    TraeCNAutomationError.sendFailed('-32000: offline confirmation RPC failure'),
    TraeCNAutomationError.cdpTimeout('Runtime.evaluate', 30000),
    new Error('offline confirmation transport failure')
  ]) {
    const fixture = submissionFixture();
    fixture.driver._waitForExpression = async () => { throw failure; };
    await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
      assert.strictEqual(error.code, 'SEND_FAILED');
      assert.strictEqual(error.details.submissionDispatched, true);
      assert(error.message.includes(failure.code === 'SEND_FAILED' ? failure.details.cause : failure.message));
      if (failure.details?.timeoutMs) assert.strictEqual(error.details.timeoutMs, failure.details.timeoutMs);
      return true;
    });
    assert.strictEqual(fixture.sends(), 1);
    if (failure.details) assert.strictEqual(failure.details.submissionDispatched, undefined);
  }
});

asyncTest('a disabled button followed by a confirmation RPC failure keeps the original unmarked failure', async () => {
  const fixture = submissionFixture({ trigger: 'button', disabled: true });
  const failure = TraeCNAutomationError.sendFailed('-32000: offline confirmation RPC failure');
  fixture.driver._waitForExpression = async () => { throw failure; };
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => error === failure);
  assert.strictEqual(failure.details.submissionDispatched, undefined);
  assert.strictEqual(fixture.sends(), 0);
});

asyncTest('a missing button returned by the Runtime expression marks only the keyboard fallback attempt', async () => {
  const fixture = submissionFixture({ trigger: 'button', missingButton: true });
  const send = fixture.driver.client.send;
  const failure = TraeCNAutomationError.sendFailed('-32000: offline fallback dispatch RPC failure');
  fixture.driver.client.send = async (method, payload) => {
    if (method === 'Input.dispatchKeyEvent' && payload.key === 'Enter' && payload.type === 'keyDown') throw failure;
    return send(method, payload);
  };
  await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => {
    assert.strictEqual(error.code, 'SEND_FAILED');
    assert.strictEqual(error.details.submissionDispatched, true);
    return true;
  });
  assert.strictEqual(fixture.sends(), 0);
});

asyncTest('pre-dispatch button discovery and composer insertion RPC failures retain their original contract', async () => {
  for (const stage of ['button-discovery', 'composer-insertion']) {
    const fixture = submissionFixture({ trigger: 'button' });
    const failure = TraeCNAutomationError.cdpTimeout(stage, 30000);
    const send = fixture.driver.client.send;
    fixture.driver.client.send = async (method, payload) => {
      if (stage === 'button-discovery' && method === 'Runtime.evaluate' && payload.expression.includes('elementFromPoint')) throw failure;
      if (stage === 'composer-insertion' && method === 'Input.insertText') throw failure;
      return send(method, payload);
    };
    await assert.rejects(() => sendMessage(fixture.driver, fixture.expected), error => error === failure);
    assert.strictEqual(failure.details.submissionDispatched, undefined);
    assert.strictEqual(fixture.sends(), 0);
  }
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (r.failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
