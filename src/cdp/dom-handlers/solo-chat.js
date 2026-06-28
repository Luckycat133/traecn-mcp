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
          chats.push({
            index: chats.length,
            text: text.slice(0, 500),
            title: text.slice(0, 120),
            status: status,
            active: active,
            className: cls.slice(0, 200)
          });
        }
        return { mode: 'solo', chats: chats, count: chats.length };
      })()
    `,
    returnByValue: true
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
    returnByValue: true
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { listSoloChats, getActiveSoloChat, switchSoloChat };