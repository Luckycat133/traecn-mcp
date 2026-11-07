'use strict';

/**
 * solo-chat handlers.
 *
 * Conversation sidebar handling shared by legacy Solo and standalone Agent.
 */

const { TraeCNAutomationError } = require('../errors');
const { sleep, safeJsValue } = require('../../shared/utils');

const STANDALONE_UI_WAIT_MS = 800;
const STANDALONE_UI_POLL_MS = 35;
const STANDALONE_DELETE_VERIFY_MS = 2500;
const SIDEBAR_PAINT_WAIT_MS = 650;

async function waitForStandaloneUi(read, timeoutMs = STANDALONE_UI_WAIT_MS) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const state = await read();
    const remaining = deadline - performance.now();
    if (!state.pending || remaining <= 0) return state;
    await sleep(Math.min(STANDALONE_UI_POLL_MS, remaining));
  }
}

const SIDEBAR_ROWS_EXPRESSION = `
  var agentSidebar = sidebar.classList?.contains('task-list-panel') === true;
  var rowSelector = agentSidebar ? '.task-list-row-wrapper[data-session-id]'
    : '[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]';
  var titleSelector = agentSidebar ? '.taskText'
    : '[class*="task-title___"], [class*="task-item-title"], [class*="conversation-item-title"], [class*="chat-item-title"]';
  function rowText(el) {
    return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  }
  function rowTitle(el) {
    var title = el.querySelector(titleSelector);
    return title ? rowText(title) : rowText(el);
  }
  function sidebarRows() {
    return Array.from(sidebar.querySelectorAll(rowSelector)).filter(function(el) {
      if (agentSidebar) return Boolean((el.getAttribute('data-session-id') || '').trim());
      var cls = (el.className || '').toString();
      if (/task-list-new-task-item|task-items-list|task-item-info|task-item-title|task-item-desc|task-item-action|task-item-actions|task-status|conversation-item-(?:info|title|desc|list|header)|chat-item-(?:info|title|desc|list|header)/i.test(cls)) return false;
      var text = rowText(el);
      return Boolean(text) && !(/^\\s*(新建任务|新任务|New Task|New Chat|新对话)/i.test(text) && text.length < 30);
    });
  }
`;

// Hidden Electron renderers may never run RAF. A timer bounds the wait, but
// cannot certify a virtualized list rendered: callers must stop that scan.
const SIDEBAR_SETTLE_EXPRESSION = `
  function settle() {
    return new Promise(function(resolve) {
      var settled = false;
      var frames = [];
      var timer = setTimeout(function() { finish(false); }, ${SIDEBAR_PAINT_WAIT_MS});
      function finish(rendered) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof cancelAnimationFrame === 'function') {
          frames.forEach(function(frame) { cancelAnimationFrame(frame); });
        }
        resolve(rendered);
      }
      if (typeof requestAnimationFrame !== 'function') return finish(false);
      frames.push(requestAnimationFrame(function() {
        if (settled) return;
        frames.push(requestAnimationFrame(function() { finish(true); }));
      }));
    });
  }
`;

async function listSoloChats(driver, { visibleOnly = false, visibilityPrepared = false, standaloneAgent = false } = {}) {
  const canPrepareVisibility = !visibleOnly && !visibilityPrepared &&
    typeof driver._activateWindow === 'function' && typeof driver._ensureVisibleWindow === 'function';
  const result = await driver.client.send('Runtime.evaluate', {
    expression: `
      (async function() {
        function findScrollHost(el) {
          var ancestors = [];
          var current = el;
          while (current && current !== document.documentElement) {
            ancestors.push(current);
            current = current.parentElement;
          }
          var nodes = ancestors
            .concat(Array.from(el.querySelectorAll('*')))
            .concat([document.scrollingElement, document.documentElement, document.body])
            .filter(Boolean);
          var seenNodes = new Set();
          var candidates = nodes.map(function(node) {
            if (!node || seenNodes.has(node) || (node !== document.body && node !== document.documentElement && node.offsetParent === null)) return null;
            seenNodes.add(node);
            var clientHeight = node === document.body || node === document.documentElement
              ? Math.max(node.clientHeight || 0, window.innerHeight || 0)
              : (node.clientHeight || 0);
            if (clientHeight < 80) return null;
            var scrollable = (node.scrollHeight || 0) - clientHeight;
            var style = window.getComputedStyle ? window.getComputedStyle(node) : null;
            var overflow = style ? [style.overflowY, style.overflow].join(' ') : '';
            var taskCount = node.querySelectorAll ? node.querySelectorAll(rowSelector).length : 0;
            var likelyScroller = /(auto|scroll|overlay)/i.test(overflow) || taskCount > 1 || node === el;
            if (scrollable <= 24 && !likelyScroller) return null;
            return { el: node, scrollable: scrollable, taskCount: taskCount, likelyScroller: likelyScroller };
          }).filter(Boolean).sort(function(a, b) {
            if ((b.scrollable > 24) !== (a.scrollable > 24)) return (b.scrollable > 24 ? 1 : 0) - (a.scrollable > 24 ? 1 : 0);
            if (b.taskCount !== a.taskCount) return b.taskCount - a.taskCount;
            return b.scrollable - a.scrollable;
          });
          return candidates.length && candidates[0].scrollable > 24
            ? { host: candidates[0].el, scanned: 'scroll' }
            : { host: null, scanned: 'visible' };
        }
        ${SIDEBAR_SETTLE_EXPRESSION}
        var sidebar = document.querySelector('.soloaisidebar, .task-list-panel') || document.querySelector('[class*="sidebar"]');
        if (!sidebar) {
          return { mode: 'not_solo', chats: [], count: 0, reason: 'sidebar_element_not_found' };
        }
        // Trae CN's Electron webview sometimes reports offsetParent === null on
        // the sidebar element even when it is logically active (e.g. before the
        // layout pass has run, or when the panel is collapsed but its items are
        // still mounted in the DOM). Falling back to a structural probe — if
        // there are task-item class nodes under the sidebar, treat this as
        // "in solo mode" rather than bailing.
        ${SIDEBAR_ROWS_EXPRESSION}
        if (${standaloneAgent} && !agentSidebar) return { error: 'standalone_agent_sidebar_changed' };
        var sidebarItemsRaw = sidebar.querySelectorAll(agentSidebar ? rowSelector : '[class*="task-item___"], [class*="chat-item___"], [class*="conversation-item___"]');
        if ((!sidebar.offsetParent || sidebar.offsetParent === null) && sidebarItemsRaw.length === 0) {
          return { mode: 'not_solo', chats: [], count: 0, reason: 'solo_sidebar_not_visible' };
        }
        var seen = new Set();
        var chats = [];
        function collectVisible(scrollInfo) {
          sidebarRows().forEach(function(el) {
            var text = rowText(el);
            var sessionId = (el.getAttribute('data-session-id') || '').trim();
            var identity = sessionId || text;
            if (!identity || seen.has(identity)) return;
            seen.add(identity);
            var title = rowTitle(el);
            var cls = (el.className || '').toString();
            var active = agentSidebar ? Boolean(el.querySelector('.taskItem.taskItemSelected'))
              : /active|selected|current|focus/i.test(cls) || el.getAttribute('aria-selected') === 'true';
            var status = agentSidebar ? 'unknown' : text.includes('进行中') || text.includes('思考中') ? 'running'
              : (text.includes('任务完成') || text.includes('已完成') ? 'done' : 'unknown');
            var scrollTop = scrollInfo.host ? scrollInfo.host.scrollTop : 0;
            chats.push({
              index: chats.length,
              sessionId: sessionId || null,
              text: text.slice(0, 500),
              title: title.slice(0, 120),
              status: status,
              active: active,
              className: cls.slice(0, 200),
              scrollHost: scrollInfo.host ? (scrollInfo.host.tagName || 'host') : null,
              scrollTop: scrollTop,
              scanned: scrollInfo.scanned
            });
          });
        }
        var scrollInfo = ${visibleOnly ? "{ host: null, scanned: 'visible' }" : 'findScrollHost(sidebar)'};
        if (!scrollInfo.host) {
          collectVisible(scrollInfo);
          return { mode: 'solo', chats: chats, count: chats.length, scanned: 'visible' };
        }
        if (document.visibilityState === 'hidden' && ${canPrepareVisibility}) {
          return { error: 'sidebar_visibility_required' };
        }
        var scrollHost = scrollInfo.host;
        var originalTop = scrollHost.scrollTop;
        var maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
        var step = Math.max(120, Math.floor(scrollHost.clientHeight * 0.75));
        try {
          scrollHost.scrollTop = 0;
          if (!await settle()) return { error: 'sidebar_scan_timeout' };
          collectVisible(scrollInfo);
          var previousTop = -1;
          // Integer scrollHeight/clientHeight can differ from the physical
          // fractional scrollTop at the bottom by up to one CSS pixel.
          for (var guard = 0; guard < 80 && maxTop - scrollHost.scrollTop > 1 && scrollHost.scrollTop !== previousTop; guard++) {
            previousTop = scrollHost.scrollTop;
            scrollHost.scrollTop = Math.min(maxTop, scrollHost.scrollTop + step);
            if (!await settle()) return { error: 'sidebar_scan_timeout' };
            collectVisible(scrollInfo);
            maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
          }
          if (maxTop - scrollHost.scrollTop > 1) return { error: 'sidebar_scan_incomplete' };
        } finally {
          scrollHost.scrollTop = originalTop;
        }
        return { mode: 'solo', chats: chats, count: chats.length, scanned: 'scroll', scrollHeight: scrollHost.scrollHeight, clientHeight: scrollHost.clientHeight };
      })()
    `,
    returnByValue: true,
    awaitPromise: true
  });
  const value = result.result?.value;
  if (value?.error === 'sidebar_visibility_required') {
    await driver._ensureVisibleWindow();
    return listSoloChats(driver, { visibleOnly, visibilityPrepared: true, standaloneAgent });
  }
  if (value?.error === 'sidebar_scan_timeout') {
    throw TraeCNAutomationError.cdpTimeout('Solo sidebar did not confirm a rendered scroll position', SIDEBAR_PAINT_WAIT_MS);
  }
  if (value?.error === 'sidebar_scan_incomplete') {
    throw TraeCNAutomationError.cdpTimeout('Solo sidebar scan could not reach the end of the list');
  }
  return value || { mode: 'unknown', chats: [], count: 0 };
}

async function getActiveSoloChat(driver) {
  // A mounted native identity does not require scrolling the whole history.
  // Keep legacy scans for rows without a native ID or an unmounted active row.
  const current = await driver.listSoloChats({ visibleOnly: true });
  if (!current || current.mode !== 'solo' || !Array.isArray(current.chats)) {
    return { mode: current?.mode || 'unknown', active: null, reason: current?.reason || 'solo_chats_unavailable' };
  }
  const currentActive = current.chats.filter(chat => chat.active);
  if (currentActive.length > 1) {
    return { mode: 'solo', active: null, count: current.count || current.chats.length, reason: 'active_solo_chat_ambiguous' };
  }
  if (currentActive.length === 1 && currentActive[0].sessionId) {
    return { mode: 'solo', active: currentActive[0], count: current.count || current.chats.length };
  }
  // Overrides may ignore the internal option and already return a complete
  // snapshot. Only our explicit visible snapshot needs the legacy full scan.
  const result = current.scanned === 'visible' ? await driver.listSoloChats() : current;
  if (!result || result.mode !== 'solo' || !Array.isArray(result.chats)) {
    return { mode: result?.mode || 'unknown', active: null, reason: result?.reason || 'solo_chats_unavailable' };
  }
  const activeChats = result.chats.filter(chat => chat.active);
  if (activeChats.length > 1) {
    return { mode: 'solo', active: null, count: result.count || result.chats.length, reason: 'active_solo_chat_ambiguous' };
  }
  const active = activeChats[0] || null;
  return {
    mode: 'solo',
    active,
    count: result.count || result.chats.length
  };
}

async function switchSoloChat(driver, criteria = {}) {
  const sessionId = typeof criteria.sessionId === 'string' ? criteria.sessionId.trim() : '';
  const index = Number.isInteger(criteria.index) ? criteria.index : null;
  const textIncludes = typeof criteria.textIncludes === 'string' ? criteria.textIncludes.trim() : '';
  const titleIncludes = typeof criteria.titleIncludes === 'string' ? criteria.titleIncludes.trim() : '';
  if (!sessionId && index === null && !textIncludes && !titleIncludes) {
    throw TraeCNAutomationError.soloChatQueryInvalid('switchSoloChat requires index, textIncludes, or titleIncludes');
  }
  if (sessionId) {
    const located = await _locateCandidateRow(driver, { sessionId });
    if (!located || located.error) return { success: false, reason: located?.error || 'chat_not_found' };
  }

  const result = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var targetIndex = ${index === null ? 'null' : String(index)};
        var sessionId = ${safeJsValue(sessionId)};
        var textIncludes = ${safeJsValue(textIncludes)};
        var titleIncludes = ${safeJsValue(titleIncludes)};
        var sidebar = document.querySelector('.soloaisidebar, .task-list-panel') || document.querySelector('[class*="sidebar"]');
        if (!sidebar) {
          return { success: false, reason: 'sidebar_element_not_found' };
        }
        ${SIDEBAR_ROWS_EXPRESSION}
        var sidebarItemsRaw = sidebar.querySelectorAll(agentSidebar ? rowSelector : '[class*="task-item___"], [class*="chat-item___"], [class*="conversation-item___"]');
        if ((!sidebar.offsetParent || sidebar.offsetParent === null) && sidebarItemsRaw.length === 0) {
          return { success: false, reason: 'solo_sidebar_not_visible' };
        }
        var nodes = sidebarRows();
        var items = [];
        var seen = new Set();
        for (var i = 0; i < nodes.length; i++) {
          var text = rowText(nodes[i]);
          var nativeId = (nodes[i].getAttribute('data-session-id') || '').trim();
          var identity = nativeId || text;
          if (!identity || seen.has(identity)) continue;
          seen.add(identity);
          var title = rowTitle(nodes[i]);
          items.push({ el: nodes[i], text: text, title: title, sessionId: nativeId, index: items.length });
        }
        var match = null;
        if (sessionId) {
          match = items.find(function(item) { return item.sessionId === sessionId; });
        } else if (targetIndex !== null) {
          match = items.find(function(item) { return item.index === targetIndex; });
        } else if (textIncludes) {
          match = items.find(function(item) { return item.text.includes(textIncludes); });
        } else if (titleIncludes) {
          match = items.find(function(item) { return (agentSidebar ? item.title : item.text).slice(0, 120).includes(titleIncludes); });
        }
        if (!match) {
          return { success: false, reason: 'chat_not_found', count: items.length };
        }
        var el = match.el;
        if (agentSidebar) {
          var item = el.querySelector('.taskItem');
          if (!item) return { success: false, reason: 'chat_action_not_found' };
          if (!item.classList.contains('taskItemSelected')) item.click();
          return { success: true, verifyNative: true, index: match.index, sessionId: match.sessionId,
            title: match.title.slice(0, 120), text: match.text.slice(0, 500) };
        }
        var rect = el.getBoundingClientRect();
        var x = rect.x + rect.width / 2;
        var y = rect.y + rect.height / 2;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        if (typeof el.click === 'function') el.click();
        return {
          success: true,
          index: match.index,
          sessionId: match.sessionId || null,
          title: match.title.slice(0, 120),
          text: match.text.slice(0, 500)
        };
      })()
    `,
    returnByValue: true,
    awaitPromise: true
  });
  const { verifyNative, ...value } = result.result?.value || { success: false, reason: 'unknown' };
  if (value.success) {
    if (verifyNative) {
      const state = await waitForStandaloneUi(async () => {
        const snapshot = await driver.listSoloChats({ visibleOnly: true, standaloneAgent: true });
        if (snapshot?.mode !== 'solo' || !Array.isArray(snapshot.chats)) return {};
        const active = snapshot.chats.filter(chat => chat.active);
        if (active.length > 1) return {};
        if (active[0]?.sessionId === value.sessionId) return { confirmed: true };
        return { pending: true };
      });
      if (!state.confirmed) return { success: false, reason: 'chat_switch_not_confirmed' };
    } else {
      await sleep(driver.config.postActionDelayMs || 500);
    }
    driver._lastTaskText = '';
    driver._pendingUserTask = '';
    driver._preSendSnapshot = '';
  }
  return value;
}

/**
 * Send a left-click at the given coordinate via Input.dispatchMouseEvent.
 */
async function _clickAt(driver, x, y, button = 'left') {
  await driver.client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    clickCount: 1
  });
  await driver.client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    clickCount: 1
  });
}

/**
 * Open the row's context menu by dispatching a `contextmenu` event on the
 * row element. This avoids `Input.dispatchMouseEvent` left-click that would
 * otherwise activate the chat and (in some Trae builds) auto-resubmit the
 * cached prompt — which is exactly what queue-probe spam relies on.
 */
async function _openRowContextMenu(driver, candidate) {
  const expression = `
    (function() {
      var openRowActionMenu = true;
      var candidate = ${safeJsValue(candidate)};
      var sidebar = document.querySelector('.soloaisidebar, .task-list-panel') || document.querySelector('[class*="sidebar"]');
      if (!sidebar) return { success: false, reason: 'sidebar_not_visible' };
      ${SIDEBAR_ROWS_EXPRESSION}
      if (agentSidebar) return { success: false, reason: 'standalone_agent_delete_not_verified' };
      var items = sidebarRows();
      var target = null;
      for (var i = 0; i < items.length; i++) {
        var text = rowText(items[i]);
        if (candidate && candidate.sessionId) {
          if (items[i].getAttribute('data-session-id') === candidate.sessionId) { target = items[i]; break; }
        } else if (candidate && candidate.title && text.indexOf(candidate.title) !== -1) { target = items[i]; break; }
      }
      if (!target && candidate && !candidate.sessionId && Number.isInteger(candidate.index) && items[candidate.index]) target = items[candidate.index];
      if (!target) return { success: false, reason: 'row_not_found', count: items.length };

      var actionButton = target.querySelector('[class*="task-item-action___"], [class*="task-item-actions-wrap___"], [class*="conversation-item-action"], [class*="chat-item-action"]');
      if (actionButton) {
        var actionRect = actionButton.getBoundingClientRect();
        actionButton.click();
        return {
          success: true,
          domClicked: true,
          x: actionRect.x + actionRect.width / 2,
          y: actionRect.y + actionRect.height / 2,
          title: (target.innerText || '').slice(0, 80)
        };
      }

      var targetRect = target.getBoundingClientRect();
      var x = Math.round(targetRect.left + targetRect.width - 24);
      var y = Math.round(targetRect.top + targetRect.height / 2);
      return { success: true, x: x, y: y, title: (target.innerText || '').slice(0, 80) };
    })()
  `;
  const openRes = await driver.client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  }).then(r => r.result?.value || { success: false, reason: 'evaluate_failed' });

  if (openRes && openRes.success && !openRes.domClicked && openRes.x && openRes.y) {
    // Trae v2 exposes a visible row action button at this point. A left click
    // opens its DOM menu; a context-menu/right click is ignored by this build.
    try {
      await driver.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: openRes.x, y: openRes.y });
      await sleep(120);
      await driver.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: openRes.x, y: openRes.y, button: 'left', clickCount: 1 });
      await driver.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: openRes.x, y: openRes.y, button: 'left', clickCount: 1 });
    } catch { /* best-effort UI click */ }
  }
  return openRes;
}

/**
 * Locate the action point of a Solo sidebar candidate row.
 *
 * The expression first finds the sidebar item whose text matches
 * `candidate.title` at index `candidate.index` within `.soloaisidebar`.
 * It then walks up to find the nearest scroll container so that the
 * element is on-screen before recording the action point.
 */
async function _locateCandidateRow(driver, candidate, visibilityPrepared = false, standaloneAgent = false) {
  const canPrepareVisibility = !visibilityPrepared &&
    typeof driver._activateWindow === 'function' && typeof driver._ensureVisibleWindow === 'function';
  const expression = `
    (async function() {
      function findScrollHost(el) {
        var ancestors = [];
        var current = el;
        while (current && current !== document.documentElement) {
          ancestors.push(current);
          current = current.parentElement;
        }
        var nodes = ancestors
          .concat(Array.from(el.querySelectorAll('*')))
          .concat([document.scrollingElement, document.documentElement, document.body])
          .filter(Boolean);
        var seenNodes = new Set();
        var candidates = nodes.map(function(node) {
          if (!node || seenNodes.has(node) || (node !== document.body && node !== document.documentElement && node.offsetParent === null)) return null;
          seenNodes.add(node);
          var clientHeight = node === document.body || node === document.documentElement
            ? Math.max(node.clientHeight || 0, window.innerHeight || 0)
            : (node.clientHeight || 0);
          if (clientHeight < 80) return null;
          var scrollable = (node.scrollHeight || 0) - clientHeight;
          var style = window.getComputedStyle ? window.getComputedStyle(node) : null;
          var overflow = style ? [style.overflowY, style.overflow].join(' ') : '';
          var taskCount = node.querySelectorAll ? node.querySelectorAll(rowSelector).length : 0;
          var likelyScroller = /(auto|scroll|overlay)/i.test(overflow) || taskCount > 1 || node === el;
          if (scrollable <= 24 && !likelyScroller) return null;
          return { el: node, scrollable: scrollable, taskCount: taskCount, likelyScroller: likelyScroller };
        }).filter(Boolean).sort(function(a, b) {
          if ((b.scrollable > 24) !== (a.scrollable > 24)) return (b.scrollable > 24 ? 1 : 0) - (a.scrollable > 24 ? 1 : 0);
          if (b.taskCount !== a.taskCount) return b.taskCount - a.taskCount;
          return b.scrollable - a.scrollable;
        });
        return candidates.length && candidates[0].scrollable > 24 ? candidates[0].el : document.scrollingElement;
      }
      ${SIDEBAR_SETTLE_EXPRESSION}
      function norm(value) {
        return String(value || '').replace(/[\\u00a0\\t\\r\\n]+/g, ' ').replace(/\\s+/g, ' ').trim().toLowerCase();
      }
      var sidebar = document.querySelector('.soloaisidebar, .task-list-panel') || document.querySelector('[class*="sidebar"]');
      if (sidebar && !sidebar.classList?.contains('task-list-panel') && sidebar.getBoundingClientRect().width === 0) {
        var openBtn = document.querySelector('a.codicon-icube-NewChat, [class*="NewChat"], [class*="new-task-button"], [class*="sidebar-toggle"]');
        if (openBtn) openBtn.click();
      }
      if (!sidebar) {
        return { error: 'sidebar_element_not_found' };
      }
      ${SIDEBAR_ROWS_EXPRESSION}
      if (${standaloneAgent} && !agentSidebar) return { error: 'standalone_agent_sidebar_changed' };
      var sidebarItemsRaw = sidebar.querySelectorAll(agentSidebar ? rowSelector : '[class*="task-item___"], [class*="chat-item___"], [class*="conversation-item___"]');
      if ((!sidebar.offsetParent || sidebar.offsetParent === null) && sidebarItemsRaw.length === 0) {
        return { error: 'sidebar_not_visible' };
      }
      var candidate = ${safeJsValue(candidate)};
      function visibleItems() {
        var nodes = sidebarRows();
        var seen = new Set();
        var items = [];
        for (var i = 0; i < nodes.length; i++) {
          var text = rowText(nodes[i]);
          var sessionId = (nodes[i].getAttribute('data-session-id') || '').trim();
          var identity = sessionId || text;
          if (!identity || seen.has(identity)) continue;
          seen.add(identity);
          items.push({ el: nodes[i], text: text, sessionId: sessionId, index: items.length });
        }
        return items;
      }
      function findTarget() {
        var items = visibleItems();
        var target = null;
        if (candidate.sessionId) return items.find(function(item) { return item.sessionId === candidate.sessionId; }) || null;
        if (candidate.title) target = items.find(function(item) { return norm(item.text).indexOf(norm(candidate.title)) !== -1; });
        if (!target && candidate.text) target = items.find(function(item) { return norm(item.text).indexOf(norm(candidate.text)) !== -1; });
        if (!target && Number.isInteger(candidate.index)) target = items.find(function(item) { return item.index === candidate.index; });
        return target;
      }
      function pointForTarget(target) {
        if (!target) return null;
        try { target.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        if (${standaloneAgent}) {
          if (rowTitle(target.el) !== candidate.title || target.el.querySelector('.taskItem.taskItemSelected, .taskWorktreeIcon')) {
            return { error: 'standalone_agent_delete_target_changed' };
          }
          var item = target.el.querySelector('.taskItem');
          var itemRect = item?.getBoundingClientRect();
          if (!itemRect || itemRect.width <= 0 || itemRect.height <= 0) return { error: 'standalone_agent_row_not_visible' };
          var rowX = itemRect.left + itemRect.width / 2;
          var rowY = itemRect.top + itemRect.height / 2;
          if (!item.contains(document.elementFromPoint(rowX, rowY))) return { error: 'standalone_agent_row_not_visible' };
          return { rowPoint: { x: rowX, y: rowY } };
        }
        var rect = target.el.getBoundingClientRect();
        var action = target.el.querySelector(agentSidebar ? '.taskMoreBtn' : '[class*="task-item-actions-wrap"], [class*="task-item-action"]');
        var actionRect = action && action.getBoundingClientRect ? action.getBoundingClientRect() : null;
        var sidebarRect = (sidebar && sidebar.getBoundingClientRect && sidebar.getBoundingClientRect().width > 80) ? sidebar.getBoundingClientRect() : null;
        var rightX = sidebarRect ? (sidebarRect.right - 24) : 237;
        var rowY = rect.y > 0 ? (rect.y + rect.height / 2) : (150 + target.index * 44);
        var rowPoint = { x: rightX - 80, y: rowY, kind: 'row' };
        var actionPoint = actionRect && actionRect.width >= 8 && actionRect.height >= 8 && actionRect.x > 0
          ? { x: actionRect.x + actionRect.width / 2, y: actionRect.y + actionRect.height / 2, kind: 'action' }
          : { x: rightX, y: rowY, kind: 'row-right' };
        var scrollHost = findScrollHost(sidebar);
        var scrollTop = scrollHost ? scrollHost.scrollTop : 0;
        return {
          index: target.index,
          sessionId: target.sessionId || null,
          title: target.text.slice(0, 120),
          actionPoint: actionPoint,
          rowPoint: rowPoint,
          scrollTop: scrollTop,
          scrollHost: scrollHost ? (scrollHost.tagName || 'host') : null
        };
      }
      var target = findTarget();
      if (target) return pointForTarget(target);
      var scrollHost = findScrollHost(sidebar);
      if (!scrollHost || (!candidate.sessionId && !candidate.title && !candidate.text)) {
        return { error: 'candidate_not_found', count: visibleItems().length };
      }
      var originalTop = scrollHost.scrollTop;
      var maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
      if (maxTop === 0) return { error: 'candidate_not_found', count: visibleItems().length };
      if (document.visibilityState === 'hidden' && ${canPrepareVisibility}) {
        return { error: 'sidebar_visibility_required' };
      }
      var step = Math.max(120, Math.floor(scrollHost.clientHeight * 0.75));
      try {
        scrollHost.scrollTop = 0;
        if (!await settle()) return { error: 'sidebar_scan_timeout' };
        target = findTarget();
        if (target) return pointForTarget(target);
        var previousTop = -1;
        for (var guard = 0; guard < 80 && maxTop - scrollHost.scrollTop > 1 && scrollHost.scrollTop !== previousTop; guard++) {
          previousTop = scrollHost.scrollTop;
          scrollHost.scrollTop = Math.min(maxTop, scrollHost.scrollTop + step);
          if (!await settle()) return { error: 'sidebar_scan_timeout' };
          target = findTarget();
          if (target) return pointForTarget(target);
          maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
        }
        if (maxTop - scrollHost.scrollTop > 1) return { error: 'sidebar_scan_incomplete' };
      } finally {
        if (!candidate.sessionId || !target) scrollHost.scrollTop = originalTop;
      }
      return { error: 'candidate_not_found', count: visibleItems().length };
    })()
  `;
  const result = await driver.client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  const value = result.result?.value;
  if (value?.error === 'sidebar_visibility_required') {
    await driver._ensureVisibleWindow();
    return _locateCandidateRow(driver, candidate, true, standaloneAgent);
  }
  return value || null;
}

/**
 * Locate the "删除任务" / "删除对话" / "删除" item inside an open Solo context menu.
 *
 * Trae ships several menu translations across versions ("删除任务" earlier,
 * "删除对话" in newer builds, and a bare "删除" as a final fallback). We try
 * the most specific first, then fall back to the generic single-character
 * "删除" so we don't break when the menu renames an item.
 */
async function _locateDeleteMenuPoint(driver) {
  await new Promise(r => setTimeout(r, 800));
  const expression = `
    (function() {
      var containers = Array.from(document.querySelectorAll('.context-menu-container, [class*="context-menu"]'));
      var MENU_PATTERNS = [/^\\s*删除任务\\s*$/, /^\\s*删除对话\\s*$/, /^\\s*删除\\s*$/];
      for (var c = 0; c < containers.length; c++) {
        var container = containers[c];
        if (container.offsetParent === null && container.offsetWidth === 0 && container.offsetHeight === 0) continue;
        var items = Array.from(container.querySelectorAll('*'))
          .filter(function(el) {
            if (!el) return false;
            var text = (el.innerText || el.textContent || '').trim();
            return text && text.length < 20;
          });
        for (var p = 0; p < MENU_PATTERNS.length; p++) {
          var match = items.find(function(el) { return MENU_PATTERNS[p].test((el.innerText || el.textContent || '').trim()); });
          if (match) {
            var containerEl = match.closest('[class*="context-menu-row"], [class*="context-menu-container"], [class*="context-menu-item"], .context-menu-container-delete') || match;
            var rect = containerEl.getBoundingClientRect();
            return {
              x: rect.x + rect.width / 2,
              y: rect.y + rect.height / 2,
              score: 160 - p * 20,
              nodeText: (match.innerText || match.textContent || '').trim(),
              nodeClass: (containerEl.className || '').toString(),
              clickClass: 'context-menu-container-delete',
              patternIndex: p
            };
          }
        }
      }
      return null;
    })()
  `;
  const result = await driver.client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return result.result?.value || null;
}

/**
 * Locate the confirm button inside a Solo deletion dialog (role=dialog or modal overlay).
 */
async function _locateConfirmPoint(driver) {
  await new Promise(r => setTimeout(r, 350));
  const expression = `
    (function() {
      var dialogs = Array.from(document.querySelectorAll('[role="dialog"], .icd-modal-v2-overlay, .icd-modal-v2-content, [class*="modal"]'));
      var best = null;
      for (var i = 0; i < dialogs.length; i++) {
        var dialog = dialogs[i];
        if (dialog.offsetParent === null && dialog.offsetWidth === 0 && dialog.offsetHeight === 0) continue;
        var btns = Array.from(dialog.querySelectorAll('.icd-btn, button, [class*="btn"]'))
          .filter(function(el) {
            if (!el) return false;
            var text = (el.innerText || el.textContent || '').trim();
            return text === '删除';
          });
        if (btns.length === 0) continue;
        var btn = btns[btns.length - 1];
        var rect = btn.getBoundingClientRect();
        best = {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          score: 90,
          nodeText: (btn.innerText || btn.textContent || '').trim(),
          nodeClass: (btn.className || '').toString()
        };
        break;
      }
      return best;
    })()
  `;
  const result = await driver.client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return result.result?.value || null;
}

/**
 * Compare two sidebar titles for the purpose of verifying deletion.
 *
 * Rejects "menu text insertion" false-positives where the menu options
 * (e.g. "重命名 导出 复制会话 删除任务") were accidentally merged into
 * the conversation row text. If the listed text contains menu chrome,
 * we treat it as not matching.
 */
function _isTitleMatch(expectedTitle, listedTitle) {
  if (typeof expectedTitle !== 'string' || typeof listedTitle !== 'string') return false;
  const expected = expectedTitle.trim();
  const listed = listedTitle.trim();
  if (!expected || !listed) return false;
  // Strip menu chrome that sometimes leaks into the row text.
  const MENU_CHROME = /重命名|导出|复制会话|删除任务/g;
  const stripped = listed.replace(MENU_CHROME, ' ').replace(/\s+/g, ' ').trim();
  if (!stripped) return false;
  // The expected title (a queue probe like "Wait for Trae Queue 进行中 14:07")
  // must appear in the stripped listed title.
  if (stripped.indexOf(expected) !== -1) return true;
  // Allow up to one status-token difference (e.g. "任务完成" suffix).
  if (stripped.replace(/\s+/g, ' ').endsWith(expected.replace(/\s+/g, ' '))) return true;
  return false;
}

// The 3.4.15 confirmation text is generic. Bind the menu to the exact row
// and require the ordinary (non-worktree) confirmation before clicking.
async function _locateStandaloneDeleteControl(driver, candidate, step) {
  const expression = `
    (function() {
      var step = ${safeJsValue(step)};
      var candidate = ${safeJsValue(candidate)};
      function text(el) {
        return String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
      }
      function visible(el) {
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility === 'visible';
      }
      function point(el, reason) {
        if (el?.disabled || el?.getAttribute('aria-disabled') === 'true') return { reason: reason };
        if (!el || !visible(el)) return { reason: reason, pending: true };
        var rect = el.getBoundingClientRect();
        var x = rect.left + rect.width / 2;
        var y = rect.top + rect.height / 2;
        return el.contains(document.elementFromPoint(x, y)) ? { x: x, y: y } : { reason: reason, pending: true };
      }
      var sidebar = document.querySelector('.task-list-panel');
      if (!sidebar) return { reason: 'standalone_agent_sidebar_changed' };
      var dialogs = Array.from(document.querySelectorAll(
        '.dialog-Di86XR, .icd-modal-v2-content, [role="dialog"], [aria-modal="true"]'
      )).filter(visible);
      dialogs = dialogs.filter(function(el) {
        return !dialogs.some(function(other) { return el !== other && other.contains(el); });
      });
      var menus = Array.from(document.querySelectorAll('.task-list-menu')).filter(visible);
      var rows = Array.from(sidebar.querySelectorAll('.task-list-row-wrapper[data-session-id]'))
        .filter(function(row) { return row.getAttribute('data-session-id') === candidate.sessionId; });
      if (step === 'verify') {
        if (dialogs.length || menus.length) {
          return { reason: 'delete_dialog_still_open',
            pending: dialogs.length === 1 && !menus.length && dialogs[0].matches('.dialog-Di86XR') };
        }
        return rows.length ? { reason: 'delete_verification_failed', pending: true } : {};
      }
      var row = rows[0];
      if (rows.length !== 1 || text(row.querySelector('.taskText')) !== candidate.title
        || row.querySelector('.taskItem.taskItemSelected, .taskWorktreeIcon')) {
        return { reason: 'standalone_agent_delete_target_changed' };
      }
      var activeActions = Array.from(sidebar.querySelectorAll('.taskMoreBtn.taskIconBtnActive'));
      var ownAction = activeActions.length === 1 && row.contains(activeActions[0]);
      var ownMenu = menus.length === 1 && !menus[0].matches('.task-list-menu-project') && ownAction;
      if (step === 'confirm') {
        if (!dialogs.length && (!menus.length || ownMenu)) {
          return { reason: 'delete_dialog_not_confirmed', pending: true };
        }
        var dialog = dialogs[0];
        if (menus.length || dialogs.length !== 1 || !dialog.matches('.dialog-Di86XR')) {
          return { reason: 'delete_dialog_not_confirmed' };
        }
        var heading = text(dialog.querySelector('.title-gy_zpW'));
        var body = text(dialog.querySelector('.content-gvLXKV'));
        var chinese = heading === '确认删除'
          && body === '删除后，这个会话及其所有内容将从本地或云端移除，包括聊天记录和代码，且无法恢复。';
        var english = heading === 'Confirm deletion'
          && body === "Once deleted, this conversation and all its contents will be removed from both local or cloud storage, including chat history and code. This action can't be undone.";
        if (!chinese && !english) return { reason: 'delete_dialog_not_confirmed' };
        var footer = dialog.querySelector('.footer-saxmUr');
        var buttons = Array.from(footer?.querySelectorAll('button') || []).filter(visible);
        var deleteButton = buttons.find(function(btn) {
          return btn.matches('.errorstrong-JRgOKW') && text(btn) === (chinese ? '删除' : 'Delete');
        });
        if (buttons.length !== 2 || !buttons.some(function(btn) {
          return text(btn) === (chinese ? '取消' : 'Cancel');
        })) return { reason: 'delete_dialog_not_confirmed' };
        return point(deleteButton, 'delete_confirm_not_visible');
      }
      if (dialogs.length) return { reason: 'preexisting_dialog' };
      if (step === 'action') {
        if (menus.length) return { reason: 'preexisting_context_menu' };
        return point(row.querySelector('.taskMoreBtn'), 'row_action_not_visible');
      }
      if (step === 'menu' && !menus.length && (!activeActions.length || ownAction)) {
        return { reason: 'delete_menu_not_bound_to_row', pending: true };
      }
      if (!ownMenu) {
        return { reason: 'delete_menu_not_bound_to_row' };
      }
      if (step === 'dismiss') return point(activeActions[0], 'row_action_not_visible');
      var items = Array.from(menus[0].querySelectorAll('[data-testid="session-delete-action"].task-list-menu-item-danger'))
        .filter(function(el) { return ['删除任务', '删除', 'Delete Task', 'Delete'].includes(text(el)); });
      if (items.length !== 1) {
        return { reason: 'delete_menu_not_found' };
      }
      return point(items[0], 'delete_menu_not_visible');
    })()
  `;
  const result = await driver.client.send('Runtime.evaluate', { expression, returnByValue: true });
  return result.result?.value || { reason: 'delete_control_unavailable' };
}

async function _deleteStandaloneAgentConversation(driver, candidate, attempt) {
  if (!candidate.sessionId || !candidate.title) return 'standalone_agent_identity_required';
  const located = await _locateCandidateRow(driver, candidate, false, true);
  if (!located?.rowPoint) return located?.error || 'candidate_not_located';
  await driver.client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: located.rowPoint.x, y: located.rowPoint.y, buttons: 0
  });

  let openedMenu = false;
  try {
    for (const [step, field] of [
      ['action', 'actionPoint'], ['menu', 'deletePoint'], ['confirm', 'confirmPoint']
    ]) {
      const control = await waitForStandaloneUi(() => _locateStandaloneDeleteControl(driver, candidate, step));
      if (control.reason) return control.reason;
      attempt[field] = control;
      if (step === 'confirm') openedMenu = false;
      await _clickAt(driver, control.x, control.y);
      if (step === 'action') openedMenu = true;
    }
  } finally {
    if (openedMenu) {
      try {
        // The same active row button toggles its own menu closed.
        const control = await _locateStandaloneDeleteControl(driver, candidate, 'dismiss');
        if (!control.reason) await _clickAt(driver, control.x, control.y);
      } catch { /* keep the original operation outcome */ }
    }
  }

  const ui = await waitForStandaloneUi(
    () => _locateStandaloneDeleteControl(driver, candidate, 'verify'), STANDALONE_DELETE_VERIFY_MS
  );
  if (ui.reason && ui.reason !== 'delete_verification_failed') return ui.reason;
  const after = await driver.listSoloChats({ standaloneAgent: true });
  if (after?.mode !== 'solo' || !Array.isArray(after.chats)) return 'delete_verification_unavailable';
  return after.chats.some(chat => chat?.sessionId === candidate.sessionId) ? 'delete_verification_failed' : null;
}

async function deleteSoloChats(driver, options = {}) {
  const candidates = Array.isArray(options.candidates) ? options.candidates : [];
  const attempts = [];
  let deleted = 0;

  for (const candidate of candidates) {
    const attempt = {
      candidate,
      success: false,
      reason: null,
      actionPoint: null,
      deletePoint: null,
      confirmPoint: null
    };

    try {
      if (options.standaloneAgent === true) {
        attempt.reason = await _deleteStandaloneAgentConversation(driver, candidate, attempt);
        attempt.success = attempt.reason === null;
        if (attempt.success) deleted += 1;
        attempts.push(attempt);
        continue;
      }
      const located = await _locateCandidateRow(driver, candidate);
      if (!located || located.error) {
        attempt.reason = located?.error || 'candidate_not_located';
        attempts.push(attempt);
        continue;
      }
      attempt.actionPoint = located.actionPoint || null;

      if (attempt.actionPoint) {
        await driver.client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: attempt.actionPoint.x,
          y: attempt.actionPoint.y
        });
        await sleep(120);
      }

      // 1. Open the row menu through its dedicated action control. Clicking
      //    the row itself would activate the chat and can resubmit cached work.
      const open = await _openRowContextMenu(driver, candidate);
      attempt.openResult = open || null;
      attempt.contextMenuOpened = open && open.success === true;
      if (!open || open.success !== true) {
        attempt.reason = (open && open.reason) || 'context_menu_open_failed';
        attempts.push(attempt);
        continue;
      }
      await sleep(driver.config.postActionDelayMs || 200);

      // 2. Find and click the "删除任务" menu item.
      let deletePoint = await _locateDeleteMenuPoint(driver);
      if (!deletePoint && open?.domClicked && Number.isFinite(open.x) && Number.isFinite(open.y)) {
        attempt.menuOpenRetry = { method: 'native_action_click', x: open.x, y: open.y };
        await _clickAt(driver, open.x, open.y, 'left');
        if (open.success === true) {
          await sleep(driver.config.postActionDelayMs || 200);
          deletePoint = await _locateDeleteMenuPoint(driver);
        }
      }
      attempt.deletePoint = deletePoint;
      if (!deletePoint) {
        attempt.reason = 'delete_menu_not_found';
        attempts.push(attempt);
        continue;
      }
      await _clickAt(driver, deletePoint.x, deletePoint.y, 'left');
      await sleep(driver.config.postActionDelayMs || 200);

      // 3. Find and click the confirm "删除" button in the dialog.
      const confirmPoint = await _locateConfirmPoint(driver);
      attempt.confirmPoint = confirmPoint;
      if (confirmPoint) {
        await _clickAt(driver, confirmPoint.x, confirmPoint.y, 'left');
        await sleep(driver.config.postActionDelayMs || 200);
      }

      // 4. Verify the candidate is no longer in the sidebar.
      const after = await driver.listSoloChats();
      if (!Array.isArray(after?.chats)) {
        attempt.reason = 'delete_verification_unavailable';
        attempts.push(attempt);
        continue;
      }
      const stillThere = Array.isArray(after.chats) && after.chats.some(chat =>
        candidate.sessionId
          ? chat?.sessionId === candidate.sessionId
          : chat && typeof chat.title === 'string' && _isTitleMatch(candidate.title, chat.title)
      );
      if (stillThere) {
        attempt.reason = 'delete_verification_failed';
        attempts.push(attempt);
        continue;
      }
      if (!confirmPoint) {
        attempt.reason = 'confirm_dialog_not_found';
        attempts.push(attempt);
        continue;
      }
      attempt.success = true;
      deleted += 1;
    } catch (err) {
      attempt.reason = err && err.message ? err.message : 'unknown_error';
    }

    attempts.push(attempt);
  }

  return { deleted, attempts };
}

module.exports = { listSoloChats, getActiveSoloChat, switchSoloChat, deleteSoloChats };
