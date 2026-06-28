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
      (function() {
        function findScrollHost(el) {
          var scanned = 'none';
          var node = el;
          while (node && node !== document.body) {
            if (node === document.documentElement || node === document.scrollingElement) {
              scanned = 'scroll';
              break;
            }
            var style = node.ownerDocument && node.ownerDocument.defaultView
              ? node.ownerDocument.defaultView.getComputedStyle(node)
              : null;
            if (style) {
              var oy = style.overflowY;
              if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
                scanned = 'scroll';
                break;
              }
            }
            node = node.parentElement;
          }
          return { host: node || document.scrollingElement, scanned: scanned };
        }
        var sidebar = document.querySelector('.soloaisidebar');
        if (!sidebar || sidebar.offsetParent === null) {
          return { mode: 'not_solo', chats: [], count: 0, reason: 'solo_sidebar_not_visible' };
        }
        var nodes = Array.from(sidebar.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]'))
          .filter(function(el) {
            if (!el || el.offsetParent === null) return false;
            var cls = (el.className || '').toString();
            if (/task-items-list|task-item-info|task-item-title|task-item-desc/i.test(cls)) return false;
            var rect = el.getBoundingClientRect();
            if (rect.width < 40 || rect.height < 20) return false;
            var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!text) return false;
            if (/^\\s*(新任务|New Task|New Chat|新对话)/i.test(text) && text.length < 30) return false;
            return true;
          });
        var seen = new Set();
        var chats = [];
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!text || seen.has(text)) continue;
          seen.add(text);
          var cls = (el.className || '').toString();
          var active = /active|selected|current|focus/i.test(cls) || el.getAttribute('aria-selected') === 'true';
          var status = text.includes('进行中') || text.includes('思考中') ? 'running'
            : (text.includes('任务完成') || text.includes('已完成') ? 'done' : 'unknown');
          var scrollInfo = findScrollHost(el);
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
            scanned: 'scroll'
          });
        }
        return { mode: 'solo', chats: chats, count: chats.length };
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
        var sidebar = document.querySelector('.soloaisidebar');
        if (!sidebar || sidebar.offsetParent === null) {
          return { success: false, reason: 'solo_sidebar_not_visible' };
        }
        var nodes = Array.from(sidebar.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]'))
          .filter(function(el) {
            if (!el || el.offsetParent === null) return false;
            var cls = (el.className || '').toString();
            if (/task-items-list|task-item-info|task-item-title|task-item-desc/i.test(cls)) return false;
            var rect = el.getBoundingClientRect();
            if (rect.width < 40 || rect.height < 20) return false;
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
 * Locate the action point of a Solo sidebar candidate row.
 *
 * The expression first finds the sidebar item whose text matches
 * `candidate.title` at index `candidate.index` within `.soloaisidebar`.
 * It then walks up to find the nearest scroll container so that the
 * element is on-screen before recording the action point.
 */
async function _locateCandidateRow(driver, candidate) {
  const expression = `
    (function() {
      function findScrollHost(el) {
        var node = el;
        while (node && node !== document.body) {
          if (node === document.documentElement || node === document.scrollingElement) {
            return { host: node, scanned: 'scroll' };
          }
          var view = node.ownerDocument && node.ownerDocument.defaultView;
          var style = view ? view.getComputedStyle(node) : null;
          if (style) {
            var oy = style.overflowY;
            if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
              return { host: node, scanned: 'scroll' };
            }
          }
          node = node.parentElement;
        }
        return { host: document.scrollingElement, scanned: 'scroll' };
      }
      var sidebar = document.querySelector('.soloaisidebar');
      if (!sidebar || sidebar.offsetParent === null) {
        return { error: 'sidebar_not_visible' };
      }
      var candidate = ${safeJsValue(candidate)};
      var nodes = Array.from(sidebar.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]'))
        .filter(function(el) {
          if (!el || el.offsetParent === null) return false;
          var cls = (el.className || '').toString();
          if (/task-items-list|task-item-info|task-item-title|task-item-desc/i.test(cls)) return false;
          var rect = el.getBoundingClientRect();
          if (rect.width < 40 || rect.height < 20) return false;
          return true;
        });
      var seen = new Set();
      var matches = [];
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        matches.push({ el: el, text: text });
      }
      var target = null;
      if (typeof candidate.title === 'string' && candidate.title) {
        for (var j = 0; j < matches.length; j++) {
          if (matches[j].text.indexOf(candidate.title) !== -1) {
            target = matches[j];
            break;
          }
        }
      }
      if (!target && typeof candidate.index === 'number' && matches[candidate.index]) {
        target = matches[candidate.index];
      }
      if (!target) return { error: 'candidate_not_found', count: matches.length };
      var rect = target.el.getBoundingClientRect();
      var rowPoint = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, kind: 'row' };
      var scrollInfo = findScrollHost(target.el);
      var scrollHost = scrollInfo.host;
      var scrollTop = scrollHost ? scrollHost.scrollTop : 0;
      var actionPoint = { x: rowPoint.x + rect.width - 24, y: rowPoint.y, kind: 'action' };
      return {
        index: matches.indexOf(target),
        title: target.text.slice(0, 120),
        actionPoint: actionPoint,
        rowPoint: rowPoint,
        scrollTop: scrollTop,
        scrollHost: scrollHost ? (scrollHost.tagName || 'host') : null
      };
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
 * Locate the "删除任务" item inside an open Solo context menu.
 */
async function _locateDeleteMenuPoint(driver) {
  const expression = `
    (function() {
      var containers = Array.from(document.querySelectorAll('.context-menu-container, [class*="context-menu"]'));
      var anchor = null;
      for (var i = 0; i < containers.length; i++) {
        var container = containers[i];
        if (container.offsetParent === null) continue;
        var labels = Array.from(container.querySelectorAll('*'))
          .filter(function(el) {
            if (!el || el.offsetParent === null) return false;
            return /删除任务/.test((el.innerText || el.textContent || '').trim());
          });
        if (labels.length > 0) {
          var labelEl = labels[labels.length - 1];
          var containerEl = labelEl.closest('.context-menu-container-delete') || labelEl.closest('[class*="delete"]') || container;
          var rect = containerEl.getBoundingClientRect();
          anchor = {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            score: 160,
            nodeText: (labelEl.innerText || labelEl.textContent || '').trim(),
            nodeClass: (containerEl.className || '').toString(),
            clickClass: 'context-menu-container-delete'
          };
          break;
        }
      }
      return anchor;
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
 * Locate the confirm button inside a Solo deletion dialog (role=dialog).
 */
async function _locateConfirmPoint(driver) {
  const expression = `
    (function() {
      var dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      var best = null;
      for (var i = 0; i < dialogs.length; i++) {
        var dialog = dialogs[i];
        if (dialog.offsetParent === null) continue;
        var btns = Array.from(dialog.querySelectorAll('.icd-btn, button, [class*="btn"]'))
          .filter(function(el) {
            if (!el || el.offsetParent === null) return false;
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

      // 1. Open the row's context menu by left-clicking on its action point.
      if (located.actionPoint) {
        await _clickAt(driver, located.actionPoint.x, located.actionPoint.y, 'left');
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