'use strict';

const assert = require('assert');
const vm = require('vm');
const soloChat = require('./solo-chat');

function fixture(options = {}) {
  const warning = '删除后，这个会话及其所有内容将从本地或云端移除，包括聊天记录和代码，且无法恢复。';
  const targetId = 'agent-disposable';
  const otherId = 'agent-other';
  const clicks = [];
  const moves = [];
  const reads = {};
  let readStep;
  let phase = 'idle';
  let targetExists = true;
  let verified = false;
  function box(x, y, { className = '', attributes = {}, children = [], text = '' } = {}) {
    const classes = className.split(' ');
    const rect = { x, y, left: x, top: y, width: 20, height: 20 };
    const value = {
      className,
      offsetParent: {},
      innerText: text,
      getAttribute: name => attributes[name] ?? null,
      matches: selector => classes.includes(selector.slice(1)),
      contains: item => item === value || children.some(child => child.contains(item)),
      getBoundingClientRect: () => rect
    };
    return value;
  }

  const action = box(30, 10);
  const otherAction = box(30, 90);
  const deleteAction = box(60, 60, { text: options.menuLabel || '删除任务' });
  const confirm = box(100, 100, { text: '删除', className: 'errorstrong-JRgOKW' });
  const cancel = box(80, 100, { text: '取消' });
  const taskItem = box(12, 10, { children: [action] });
  const row = (id, y, button, active = false) => Object.assign(box(10, y, {
    attributes: { 'data-session-id': id }, children: [taskItem, button], text: 'Same title'
  }), {
    scrollIntoView() {},
    querySelectorAll: () => [],
    querySelector: selector => {
      if (selector === '.taskMoreBtn') return button;
      if (selector === '.taskItem') return taskItem;
      if (selector === '.taskText') return { innerText: 'Same title' };
      if (selector.includes('.taskItem.taskItemSelected') && active) return {};
      if (selector.includes('.taskWorktreeIcon') && options.worktree && id === targetId) return {};
      return null;
    }
  });
  const target = row(targetId, 10, action);
  const other = row(otherId, 90, otherAction, true);
  const waiting = step => options.delayed && readStep === step && reads[step] === 1;
  const rows = () => targetExists || waiting('verify') ? [target, other] : [other];
  const menu = {
    ...box(60, 60),
    querySelectorAll: selector => selector === '[data-testid="session-delete-action"].task-list-menu-item-danger'
      && !options.missingTestId
      ? (options.ambiguousMenu ? [deleteAction, box(60, 80, { text: '删除任务' })] : [deleteAction])
      : []
  };
  const dialog = {
    ...box(80, 80, { className: 'dialog-Di86XR' }),
    querySelector: selector => ({
      '.title-gy_zpW': { innerText: '确认删除' },
      '.content-gvLXKV': { innerText: options.worktreeDialog ? '删除后无法恢复工作树。' : warning },
      '.footer-saxmUr': { querySelectorAll: () => [cancel, confirm] }
    })[selector] || null
  };
  const sidebar = {
    ...box(0, 0, { className: 'task-list-panel' }),
    classList: { contains: name => name === 'task-list-panel' },
    clientHeight: 200, scrollHeight: 200, scrollTop: 0,
    querySelectorAll(selector) {
      if (selector === '.taskMoreBtn.taskIconBtnActive') return [options.wrongMenuOwner ? otherAction : action];
      return rows();
    }
  };
  const page = { clientHeight: 600, scrollHeight: 600, offsetParent: {}, querySelectorAll: () => [] };
  const getComputedStyle = () => ({ visibility: 'visible' });
  const sandbox = {
    document: {
      body: page, documentElement: page, scrollingElement: page, visibilityState: 'visible',
      querySelector: selector => selector.includes('.task-list-panel') ? sidebar : null,
      querySelectorAll: selector => selector === '.task-list-menu'
        ? (phase === 'menu' && !waiting('menu') ? [menu] : [])
        : ((phase === 'dialog' && !waiting('confirm')) || options.preexistingDialog ? [dialog] : []),
      elementFromPoint: (x, y) => ({
        '22:20': taskItem, '40:20': waiting('action') ? null : action,
        '70:70': deleteAction, '110:110': confirm
      })[`${x}:${y}`] || null
    },
    getComputedStyle,
    window: { innerHeight: 600, getComputedStyle }
  };
  const driver = {
    config: { postActionDelayMs: 1 },
    client: {
      async send(method, params) {
        if (method === 'Runtime.evaluate') {
          readStep = /var step = "([a-z]+)";/.exec(params.expression)?.[1];
          if (readStep) reads[readStep] = (reads[readStep] || 0) + 1;
          return { result: { value: await vm.runInNewContext(params.expression, sandbox) } };
        }
        assert.strictEqual(method, 'Input.dispatchMouseEvent');
        if (params.type === 'mouseMoved') moves.push([params.x, params.y, params.buttons]);
        if (params.type === 'mouseReleased') {
          clicks.push([params.x, params.y]);
          if (params.x === 40) phase = phase === 'menu' ? 'idle' : 'menu';
          if (params.x === 70) phase = 'dialog';
          if (params.x === 110) {
            phase = 'idle';
            if (!options.stillPresent) targetExists = false;
          }
        }
        return {};
      }
    },
    listSoloChats(options) {
      assert.strictEqual(options.standaloneAgent, true);
      verified = true;
      return soloChat.listSoloChats(driver, options);
    }
  };
  return {
    clicks,
    moves,
    reads,
    verified: () => verified,
    run: () => soloChat.deleteSoloChats(driver, {
      standaloneAgent: true, candidates: [{ sessionId: targetId, title: 'Same title' }]
    })
  };
}

(async () => {
  const action = [40, 20];
  const menu = [70, 70];
  const confirm = [110, 110];
  for (const [options, expectedClicks, reason] of [
    [{}, [action, menu, confirm], null],
    [{ delayed: true }, [action, menu, confirm], null],
    [{ menuLabel: '删除' }, [action, menu, confirm], null],
    [{ missingTestId: true }, [action, action], 'delete_menu_not_found'],
    [{ ambiguousMenu: true }, [action, action], 'delete_menu_not_found'],
    [{ preexistingDialog: true }, [], 'preexisting_dialog'],
    [{ worktree: true }, [], 'standalone_agent_delete_target_changed'],
    [{ wrongMenuOwner: true }, [action], 'delete_menu_not_bound_to_row'],
    [{ worktreeDialog: true }, [action, menu], 'delete_dialog_not_confirmed'],
    [{ stillPresent: true }, [action, menu, confirm], 'delete_verification_failed']
  ]) {
    const native = fixture(options);
    const result = await native.run();
    assert.strictEqual(result.deleted, reason ? 0 : 1);
    assert.strictEqual(result.attempts[0].reason, reason);
    assert.deepStrictEqual(native.clicks, expectedClicks);
    assert.strictEqual(native.verified(), expectedClicks.includes(confirm));
    if (options.delayed) {
      assert.deepStrictEqual(native.moves, [[22, 20, 0]]);
      assert.deepStrictEqual(native.reads, { action: 2, menu: 2, confirm: 2, verify: 2 });
    } else if (!reason) {
      assert.deepStrictEqual(native.reads, { action: 1, menu: 1, confirm: 1, verify: 1 });
    }
  }
  console.log('standalone Agent deletion guards passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
