'use strict';

/**
 * solo-chat handlers.
 *
 * Moved verbatim from src/cdp/dom-driver.js. Each method is now an
 * exported function with signature `function method(driver, ...args)`
 * taking the DomDriver instance as `driver`. Behavior is preserved 1:1.
 *
 * The DomDriver retains thin delegating shims (e.g. `listSoloChats()`)
 * so existing dom-driver.test.js cases that call `driver.listSoloChats()`
 * continue to work unchanged.
 */

const { TraeCNAutomationError } = require('../errors');
const { safeJsValue } = require('../../shared/utils');

async function listSoloChats(driver) {
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
            var taskCount = node.querySelectorAll ? node.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]').length : 0;
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
        function settle() {
          return new Promise(function(resolve) {
            requestAnimationFrame(function() { requestAnimationFrame(resolve); });
          });
        }
        var sidebar = document.querySelector('.soloaisidebar') || document.querySelector('[class*="sidebar"]');
        if (!sidebar) {
          return { mode: 'not_solo', chats: [], count: 0, reason: 'sidebar_element_not_found' };
        }
        // Trae CN's Electron webview sometimes reports offsetParent === null on
        // the sidebar element even when it is logically active (e.g. before the
        // layout pass has run, or when the panel is collapsed but its items are
        // still mounted in the DOM). Falling back to a structural probe — if
        // there are task-item class nodes under the sidebar, treat this as
        // "in solo mode" rather than bailing.
        var sidebarItemsRaw = sidebar.querySelectorAll('[class*="task-item___"], [class*="chat-item___"], [class*="conversation-item___"]');
        if ((!sidebar.offsetParent || sidebar.offsetParent === null) && sidebarItemsRaw.length === 0) {
          return { mode: 'not_solo', chats: [], count: 0, reason: 'solo_sidebar_not_visible' };
        }
        var seen = new Set();
        var chats = [];
        function visibleChatNodes() {
          return Array.from(sidebar.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]'))
            .filter(function(el) {
              var cls = (el.className || '').toString();
              if (/task-items-list|task-item-info|task-item-title|task-item-desc|task-item-action|task-item-actions|task-status|conversation-item-(?:info|title|desc|list|header)|chat-item-(?:info|title|desc|list|header)/i.test(cls)) return false;
              var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
              if (!text) return false;
              if (/^\\s*(新任务|New Task|New Chat|新对话)/i.test(text) && text.length < 30) return false;
              // Loosened visibility: Trae webview commonly reports rect 0×0
              // and offsetParent === null on its own DOM, so we now only filter
              // out completely-empty / disconnected nodes.
              return true;
            });
        }
        function collectVisible(scrollInfo) {
          visibleChatNodes().forEach(function(el) {
            var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!text || seen.has(text)) return;
            seen.add(text);
            var cls = (el.className || '').toString();
            var active = /active|selected|current|focus/i.test(cls) || el.getAttribute('aria-selected') === 'true';
            var status = text.includes('进行中') || text.includes('思考中') ? 'running'
              : (text.includes('任务完成') || text.includes('已完成') ? 'done' : 'unknown');
            var scrollTop = scrollInfo.host ? scrollInfo.host.scrollTop : 0;
            chats.push({
              index: chats.length,
              text: text.slice(0, 500),
              title: text.slice(0, 120),
              status: status,
              active: active,
              className: cls.slice(0, 200),
              scrollHost: scrollInfo.host ? (scrollInfo.host.tagName || 'host') : null,
              scrollTop: scrollTop,
              scanned: scrollInfo.scanned
            });
          });
        }
        var scrollInfo = findScrollHost(sidebar);
        if (!scrollInfo.host) {
          collectVisible(scrollInfo);
          return { mode: 'solo', chats: chats, count: chats.length, scanned: 'visible' };
        }
        var scrollHost = scrollInfo.host;
        var originalTop = scrollHost.scrollTop;
        var maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
        var step = Math.max(120, Math.floor(scrollHost.clientHeight * 0.75));
        try {
          scrollHost.scrollTop = 0;
          await settle();
          collectVisible(scrollInfo);
          var previousTop = -1;
          for (var guard = 0; guard < 80 && scrollHost.scrollTop < maxTop && scrollHost.scrollTop !== previousTop; guard++) {
            previousTop = scrollHost.scrollTop;
            scrollHost.scrollTop = Math.min(maxTop, scrollHost.scrollTop + step);
            await settle();
            collectVisible(scrollInfo);
            maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
          }
        } finally {
          scrollHost.scrollTop = originalTop;
        }
        return { mode: 'solo', chats: chats, count: chats.length, scanned: 'scroll', scrollHeight: scrollHost.scrollHeight, clientHeight: scrollHost.clientHeight };
      })()
    `,
    returnByValue: true,
    awaitPromise: true
  });
  return result.result?.value || { mode: 'unknown', chats: [], count: 0 };
}

async function getActiveSoloChat(driver) {
  const result = await driver.listSoloChats();
  if (!result || result.mode !== 'solo' || !Array.isArray(result.chats)) {
    return { mode: result?.mode || 'unknown', active: null, reason: result?.reason || 'solo_chats_unavailable' };
  }
  const active = result.chats.find(chat => chat.active) || null;
  return {
    mode: 'solo',
    active,
    count: result.count || result.chats.length
  };
}

async function switchSoloChat(driver, criteria = {}) {
  const index = Number.isInteger(criteria.index) ? criteria.index : null;
  const textIncludes = typeof criteria.textIncludes === 'string' ? criteria.textIncludes.trim() : '';
  const titleIncludes = typeof criteria.titleIncludes === 'string' ? criteria.titleIncludes.trim() : '';
  if (index === null && !textIncludes && !titleIncludes) {
    throw TraeCNAutomationError.soloChatQueryInvalid('switchSoloChat requires index, textIncludes, or titleIncludes');
  }

  const result = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var targetIndex = ${index === null ? 'null' : String(index)};
        var textIncludes = ${safeJsValue(textIncludes)};
        var titleIncludes = ${safeJsValue(titleIncludes)};
        var sidebar = document.querySelector('.soloaisidebar') || document.querySelector('[class*="sidebar"]');
        if (!sidebar) {
          return { success: false, reason: 'sidebar_element_not_found' };
        }
        var sidebarItemsRaw = sidebar.querySelectorAll('[class*="task-item___"], [class*="chat-item___"], [class*="conversation-item___"]');
        if ((!sidebar.offsetParent || sidebar.offsetParent === null) && sidebarItemsRaw.length === 0) {
          return { success: false, reason: 'solo_sidebar_not_visible' };
        }
        var nodes = Array.from(sidebar.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]'))
          .filter(function(el) {
            var cls = (el.className || '').toString();
            if (/task-items-list|task-item-info|task-item-title|task-item-desc|task-item-action|task-item-actions|task-status|conversation-item-(?:info|title|desc|list|header)|chat-item-(?:info|title|desc|list|header)/i.test(cls)) return false;
            var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!text) return false;
            if (/^\\s*(新任务|New Task|New Chat|新对话)/i.test(text) && text.length < 30) return false;
            return true;
          });
        var items = [];
        var seen = new Set();
        for (var i = 0; i < nodes.length; i++) {
          var text = (nodes[i].innerText || nodes[i].textContent || '').replace(/\\s+/g, ' ').trim();
          if (!text || seen.has(text)) continue;
          seen.add(text);
          items.push({ el: nodes[i], text: text, index: items.length });
        }
        var match = null;
        if (targetIndex !== null) {
          match = items.find(function(item) { return item.index === targetIndex; });
        } else if (textIncludes) {
          match = items.find(function(item) { return item.text.includes(textIncludes); });
        } else if (titleIncludes) {
          match = items.find(function(item) { return item.text.slice(0, 120).includes(titleIncludes); });
        }
        if (!match) {
          return { success: false, reason: 'chat_not_found', count: items.length };
        }
        var el = match.el;
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
          title: match.text.slice(0, 120),
          text: match.text.slice(0, 500)
        };
      })()
    `,
    returnByValue: true,
    awaitPromise: true
  });
  const value = result.result?.value || { success: false, reason: 'unknown' };
  if (value.success) {
    await sleep(driver.config.postActionDelayMs || 500);
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
      var candidate = ${safeJsValue(candidate)};
      var sidebar = document.querySelector('.soloaisidebar') || document.querySelector('[class*="sidebar"]');
      if (!sidebar) return { success: false, reason: 'sidebar_not_visible' };
      var items = Array.from(sidebar.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]'))
        .filter(function(el) {
          var cls = (el.className || '').toString();
          if (/task-items-list|task-item-info|task-item-title|task-item-desc|task-item-action|task-item-actions|task-status|conversation-item-(?:info|title|desc|list|header)|chat-item-(?:info|title|desc|list|header)/i.test(cls)) return false;
          return true;
        });
      var target = null;
      for (var i = 0; i < items.length; i++) {
        var text = (items[i].innerText || items[i].textContent || '').replace(/\\s+/g, ' ').trim();
        if (candidate && candidate.title && text.indexOf(candidate.title) !== -1) { target = items[i]; break; }
      }
      if (!target && candidate && Number.isInteger(candidate.index) && items[candidate.index]) target = items[candidate.index];
      if (!target) return { success: false, reason: 'row_not_found', count: items.length };

      var targetRect = target.getBoundingClientRect();
      var x = Math.round(targetRect.left + targetRect.width - 24);
      var y = Math.round(targetRect.top + targetRect.height / 2);
      try {
        var ev = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 2,
          buttons: 2,
          clientX: x,
          clientY: y
        });
        target.dispatchEvent(ev);
      } catch (e) {
        return { success: false, reason: 'dispatch_failed', error: e && e.message };
      }
      return { success: true, x: x, y: y, title: (target.innerText || '').slice(0, 80) };
    })()
  `;
  const openRes = await driver.client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  }).then(r => r.result?.value || { success: false, reason: 'evaluate_failed' });

  if (openRes && openRes.success && openRes.x && openRes.y) {
    // Perform a real CDP right-click (contextmenu) at the action-button coordinates so the native menu opens reliably
    try {
      await driver.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: openRes.x, y: openRes.y });
      await driver.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: openRes.x, y: openRes.y, button: 'right', clickCount: 1 });
      await driver.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: openRes.x, y: openRes.y, button: 'right', clickCount: 1 });
    } catch (e) {}
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
async function _locateCandidateRow(driver, candidate) {
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
          var taskCount = node.querySelectorAll ? node.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]').length : 0;
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
      function settle() {
        return new Promise(function(resolve) {
          requestAnimationFrame(function() { requestAnimationFrame(resolve); });
        });
      }
      function norm(value) {
        return String(value || '').replace(/[\\u00a0\\t\\r\\n]+/g, ' ').replace(/\\s+/g, ' ').trim().toLowerCase();
      }
      var sidebar = document.querySelector('.soloaisidebar') || document.querySelector('[class*="sidebar"]');
      if (sidebar && sidebar.getBoundingClientRect().width === 0) {
        var openBtn = document.querySelector('a.codicon-icube-NewChat, [class*="NewChat"], [class*="new-task-button"], [class*="sidebar-toggle"]');
        if (openBtn) openBtn.click();
      }
      if (!sidebar) {
        return { error: 'sidebar_element_not_found' };
      }
      var sidebarItemsRaw = sidebar.querySelectorAll('[class*="task-item___"], [class*="chat-item___"], [class*="conversation-item___"]');
      if ((!sidebar.offsetParent || sidebar.offsetParent === null) && sidebarItemsRaw.length === 0) {
        return { error: 'sidebar_not_visible' };
      }
      var candidate = ${safeJsValue(candidate)};
      function visibleItems() {
        var nodes = Array.from(sidebar.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]'))
          .filter(function(el) {
            var cls = String(el.className || '');
            if (/task-items-list|task-item-info|task-item-title|task-item-desc|task-item-action|task-item-actions|task-status|conversation-item-(?:info|title|desc|list|header)|chat-item-(?:info|title|desc|list|header)/i.test(cls)) return false;
            var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
            return Boolean(text);
          });
        var seen = new Set();
        var items = [];
        for (var i = 0; i < nodes.length; i++) {
          var text = (nodes[i].innerText || nodes[i].textContent || '').replace(/\\s+/g, ' ').trim();
          if (!text || seen.has(text)) continue;
          seen.add(text);
          items.push({ el: nodes[i], text: text, index: items.length });
        }
        return items;
      }
      function findTarget() {
        var items = visibleItems();
        var target = null;
        if (candidate.title) target = items.find(function(item) { return norm(item.text).indexOf(norm(candidate.title)) !== -1; });
        if (!target && candidate.text) target = items.find(function(item) { return norm(item.text).indexOf(norm(candidate.text)) !== -1; });
        if (!target && Number.isInteger(candidate.index)) target = items.find(function(item) { return item.index === candidate.index; });
        return target;
      }
      function pointForTarget(target) {
        if (!target) return null;
        try { target.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        var rect = target.el.getBoundingClientRect();
        var action = target.el.querySelector('[class*="task-item-actions-wrap"], [class*="task-item-action"]');
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
      if (!scrollHost || (!candidate.title && !candidate.text)) {
        return { error: 'candidate_not_found', count: visibleItems().length };
      }
      var originalTop = scrollHost.scrollTop;
      var maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
      var step = Math.max(120, Math.floor(scrollHost.clientHeight * 0.75));
      try {
        scrollHost.scrollTop = 0;
        await settle();
        target = findTarget();
        if (target) return pointForTarget(target);
        var previousTop = -1;
        for (var guard = 0; guard < 80 && scrollHost.scrollTop < maxTop && scrollHost.scrollTop !== previousTop; guard++) {
          previousTop = scrollHost.scrollTop;
          scrollHost.scrollTop = Math.min(maxTop, scrollHost.scrollTop + step);
          await settle();
          target = findTarget();
          if (target) return pointForTarget(target);
          maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
        }
      } finally {
        scrollHost.scrollTop = originalTop;
      }
      return { error: 'candidate_not_found', count: visibleItems().length };
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
 * Locate the "删除任务" / "删除对话" / "删除" item inside an open Solo context menu.
 *
 * Trae ships several menu translations across versions ("删除任务" earlier,
 * "删除对话" in newer builds, and a bare "删除" as a final fallback). We try
 * the most specific first, then fall back to the generic single-character
 * "删除" so we don't break when the menu renames an item.
 */
async function _locateDeleteMenuPoint(driver) {
  await new Promise(r => setTimeout(r, 350));
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
      const located = await _locateCandidateRow(driver, candidate);
      if (!located || located.error) {
        attempt.reason = located?.error || 'candidate_not_located';
        attempts.push(attempt);
        continue;
      }
      attempt.actionPoint = located.actionPoint || null;

      // 1. Open the row's context menu by dispatching a native contextmenu
      //    event. Using a left-click would activate the chat and (for some
      //    Trae builds) auto-resubmit the cached prompt, which is exactly
      //    what we are trying to stop.
      const open = await _openRowContextMenu(driver, candidate);
      attempt.contextMenuOpened = open && open.success === true;
      if (!open || open.success !== true) {
        attempt.reason = (open && open.reason) || 'context_menu_open_failed';
        attempts.push(attempt);
        continue;
      }
      await sleep(driver.config.postActionDelayMs || 200);

      // 2. Find and click the "删除任务" menu item.
      const deletePoint = await _locateDeleteMenuPoint(driver);
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
      const stillThere = Array.isArray(after.chats) && after.chats.some(chat =>
        chat && typeof chat.title === 'string' && _isTitleMatch(candidate.title, chat.title)
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { listSoloChats, getActiveSoloChat, switchSoloChat, deleteSoloChats };
