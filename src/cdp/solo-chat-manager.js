'use strict';

/**
 * SoloChatManager — manages SOLO sidebar chat operations (list, switch, delete).
 * Extracted from DomDriver to isolate solo-chat-management responsibility.
 */

const { safeJsValue, sleep } = require('../shared/utils');

class SoloChatManager {
  constructor(client, config, domHelper) {
    this.client = client;
    this.config = config;
    this.domHelper = domHelper;
  }

  async listSoloChats() {
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (async function() {
          var sidebar = document.querySelector('.soloaisidebar');
          if (!sidebar || sidebar.offsetParent === null) {
            return { mode: 'not_solo', chats: [], count: 0, reason: 'solo_sidebar_not_visible' };
          }
          function settle() {
            return new Promise(function(resolve) {
              requestAnimationFrame(function() { requestAnimationFrame(resolve); });
            });
          }
          function findScrollHost() {
            var ancestors = [];
            var current = sidebar;
            while (current && current !== document.documentElement) {
              ancestors.push(current);
              current = current.parentElement;
            }
            var nodes = ancestors
              .concat(Array.from(sidebar.querySelectorAll('*')))
              .concat([document.scrollingElement, document.documentElement, document.body])
              .filter(Boolean);
            var seenNodes = new Set();
            var candidates = nodes.map(function(el) {
              if (!el || seenNodes.has(el) || (el !== document.body && el !== document.documentElement && el.offsetParent === null)) return null;
              seenNodes.add(el);
              var clientHeight = el === document.body || el === document.documentElement
                ? Math.max(el.clientHeight || 0, window.innerHeight || 0)
                : (el.clientHeight || 0);
              if (clientHeight < 80) return null;
              var scrollable = (el.scrollHeight || 0) - clientHeight;
              var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
              var overflow = style ? [style.overflowY, style.overflow].join(' ') : '';
              var taskCount = el.querySelectorAll ? el.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]').length : 0;
              var likelyScroller = /(auto|scroll|overlay)/i.test(overflow) || taskCount > 1 || el === sidebar;
              if (scrollable <= 24 && !likelyScroller) return null;
              return { el: el, scrollable: scrollable, taskCount: taskCount, likelyScroller: likelyScroller };
            }).filter(Boolean).sort(function(a, b) {
              if ((b.scrollable > 24) !== (a.scrollable > 24)) return (b.scrollable > 24 ? 1 : 0) - (a.scrollable > 24 ? 1 : 0);
              if (b.taskCount !== a.taskCount) return b.taskCount - a.taskCount;
              return b.scrollable - a.scrollable;
            });
            return candidates.length && candidates[0].scrollable > 24 ? candidates[0].el : null;
          }
          function visibleChatNodes() {
            return Array.from(sidebar.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]'))
              .filter(function(el) {
                if (!el || el.offsetParent === null) return false;
                var cls = (el.className || '').toString();
                if (/task-items-list|task-item-info|task-item-title|task-item-desc|task-item-action|task-item-actions|task-status|conversation-item-(?:info|title|desc|list|header)|chat-item-(?:info|title|desc|list|header)/i.test(cls)) return false;
                var rect = el.getBoundingClientRect();
                if (rect.width < 40 || rect.height < 20) return false;
                var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
                if (!text) return false;
                if (/^\\s*(新任务|New Task|New Chat|新对话)/i.test(text) && text.length < 30) return false;
                return true;
              });
          }
          var seen = new Set();
          var chats = [];
          function collectVisible() {
            visibleChatNodes().forEach(function(el) {
              var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
              if (!text || seen.has(text)) return;
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
            });
          }
          var scrollHost = findScrollHost();
          if (!scrollHost) {
            collectVisible();
            return { mode: 'solo', chats: chats, count: chats.length, scanned: 'visible' };
          }
          var originalTop = scrollHost.scrollTop;
          var maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
          var step = Math.max(120, Math.floor(scrollHost.clientHeight * 0.75));
          try {
            scrollHost.scrollTop = 0;
            await settle();
            collectVisible();
            var previousTop = -1;
            for (var guard = 0; guard < 80 && scrollHost.scrollTop < maxTop && scrollHost.scrollTop !== previousTop; guard++) {
              previousTop = scrollHost.scrollTop;
              scrollHost.scrollTop = Math.min(maxTop, scrollHost.scrollTop + step);
              await settle();
              collectVisible();
              maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
            }
          } finally {
            scrollHost.scrollTop = originalTop;
          }
          return { mode: 'solo', chats: chats, count: chats.length, scanned: 'scroll', scrollHeight: scrollHost.scrollHeight, clientHeight: scrollHost.clientHeight };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });
    return result.result?.value || { mode: 'unknown', chats: [], count: 0 };
  }

  async _findSoloChatActionPoint(candidate = {}) {
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (async function() {
          var candidate = ${safeJsValue(candidate)};
          var sidebar = document.querySelector('.soloaisidebar');
          if (!sidebar || sidebar.offsetParent === null) return null;
          function settle() {
            return new Promise(function(resolve) {
              requestAnimationFrame(function() { requestAnimationFrame(resolve); });
            });
          }
          function norm(value) {
            return String(value || '').replace(/[\\u00a0\\t\\r\\n]+/g, ' ').replace(/\\s+/g, ' ').trim().toLowerCase();
          }
          function findScrollHost() {
            var ancestors = [];
            var current = sidebar;
            while (current && current !== document.documentElement) {
              ancestors.push(current);
              current = current.parentElement;
            }
            var nodes = ancestors
              .concat(Array.from(sidebar.querySelectorAll('*')))
              .concat([document.scrollingElement, document.documentElement, document.body])
              .filter(Boolean);
            var seenNodes = new Set();
            var candidates = nodes.map(function(el) {
              if (!el || seenNodes.has(el) || (el !== document.body && el !== document.documentElement && el.offsetParent === null)) return null;
              seenNodes.add(el);
              var clientHeight = el === document.body || el === document.documentElement
                ? Math.max(el.clientHeight || 0, window.innerHeight || 0)
                : (el.clientHeight || 0);
              if (clientHeight < 80) return null;
              var scrollable = (el.scrollHeight || 0) - clientHeight;
              var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
              var overflow = style ? [style.overflowY, style.overflow].join(' ') : '';
              var taskCount = el.querySelectorAll ? el.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]').length : 0;
              var likelyScroller = /(auto|scroll|overlay)/i.test(overflow) || taskCount > 1 || el === sidebar;
              if (scrollable <= 24 && !likelyScroller) return null;
              return { el: el, scrollable: scrollable, taskCount: taskCount, likelyScroller: likelyScroller };
            }).filter(Boolean).sort(function(a, b) {
              if ((b.scrollable > 24) !== (a.scrollable > 24)) return (b.scrollable > 24 ? 1 : 0) - (a.scrollable > 24 ? 1 : 0);
              if (b.taskCount !== a.taskCount) return b.taskCount - a.taskCount;
              return b.scrollable - a.scrollable;
            });
            return candidates.length && candidates[0].scrollable > 24 ? candidates[0].el : null;
          }
          function visibleItems() {
            var nodes = Array.from(sidebar.querySelectorAll('[class*="task-item"], [class*="chat-item"], [class*="conversation-item"]'))
              .filter(function(el) {
                if (!el || el.offsetParent === null) return false;
                var cls = String(el.className || '');
                if (/task-items-list|task-item-info|task-item-title|task-item-desc|task-item-action|task-item-actions|task-status|conversation-item-(?:info|title|desc|list|header)|chat-item-(?:info|title|desc|list|header)/i.test(cls)) return false;
                var rect = el.getBoundingClientRect();
                var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
                return rect.width > 40 && rect.height > 20 && text;
              });
            return nodes.map(function(el, index) {
              return { el: el, index: index, text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() };
            });
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
            var rowRect = target.el.getBoundingClientRect();
            var action = target.el.querySelector('[class*="task-item-actions-wrap"], [class*="task-item-action"]');
            var actionRect = action && action.getBoundingClientRect ? action.getBoundingClientRect() : null;
            var actionPoint = actionRect && actionRect.width >= 8 && actionRect.height >= 8
              ? { x: actionRect.x + actionRect.width / 2, y: actionRect.y + actionRect.height / 2, kind: 'action' }
              : { x: rowRect.x + rowRect.width - 19, y: rowRect.y + Math.min(20, rowRect.height / 2), kind: 'row-right' };
            return {
              index: target.index,
              title: target.text.slice(0, 160),
              actionPoint: actionPoint,
              rowPoint: { x: rowRect.x + rowRect.width / 2, y: rowRect.y + rowRect.height / 2, kind: 'row' }
            };
          }
          var target = findTarget();
          if (target) return pointForTarget(target);
          var scrollHost = findScrollHost();
          if (!scrollHost || (!candidate.title && !candidate.text)) return null;
          var maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
          var step = Math.max(120, Math.floor(scrollHost.clientHeight * 0.75));
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
          return null;
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });
    return result.result?.value || null;
  }

  async _findSoloDeleteMenuPoint(anchorPoint = {}) {
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var anchor = ${safeJsValue(anchorPoint)};
          var anchorX = Number(anchor.x);
          var anchorY = Number(anchor.y);
          function text(node) {
            return String((node && (node.innerText || node.textContent)) || '').replace(/\\s+/g, ' ').trim();
          }
          function visible(node) {
            if (!node || node.offsetParent === null || !node.getBoundingClientRect) return false;
            var rect = node.getBoundingClientRect();
            return rect.width >= 8 && rect.height >= 8;
          }
          var nodes = Array.from(document.querySelectorAll('[class*="context-menu"], [class*="menu"], [role="menuitem"], [role="button"], button, li, a, div, span'));
          var candidates = [];
          for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (!visible(node)) continue;
            var label = text(node);
            var cls = String(node.className || '');
            var combined = label + ' ' + cls;
            if (!/(删除任务|删除会话|delete task|delete conversation|remove task|remove conversation)/i.test(combined)) continue;
            if (/(重命名.*导出|导出.*复制|复制会话.*删除|rename.*export|export.*copy|copy.*delete)/i.test(label) && !/row|item|text|delete|remove|trash|container-delete/i.test(cls)) continue;
            var clickable = node.closest && node.closest('[class*="context-menu-row"], [class*="context-menu-container"], [role="menuitem"], button, [role="button"]') || node;
            if (!visible(clickable)) clickable = node;
            var rect = clickable.getBoundingClientRect();
            var cx = rect.x + rect.width / 2;
            var cy = rect.y + rect.height / 2;
            var score = 100 - Math.min(80, rect.width * rect.height / 600);
            if (/container-delete|delete|trash|row|text/i.test(cls)) score += 20;
            if (/^(删除任务|删除会话|delete task|delete conversation)$/i.test(label)) score += 30;
            if (Number.isFinite(anchorX) && Number.isFinite(anchorY)) {
              if (Math.abs(cx - anchorX) > 520 || cy < anchorY - 220 || cy > anchorY + 480) continue;
              score += Math.max(0, 20 - Math.abs(cx - anchorX) / 20);
              score += Math.max(0, 20 - Math.abs(cy - anchorY) / 12);
            }
            candidates.push({
              x: cx,
              y: cy,
              score: score,
              nodeText: label.slice(0, 120),
              nodeClass: cls.slice(0, 180),
              clickClass: String(clickable.className || '').slice(0, 180)
            });
          }
          candidates.sort(function(a, b) { return b.score - a.score; });
          return candidates[0] || null;
        })()
      `,
      returnByValue: true
    });
    return result.result?.value || null;
  }

  async _findSoloDeleteConfirmPoint() {
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          function text(node) {
            return String((node && (node.innerText || node.textContent)) || '').replace(/\\s+/g, ' ').trim();
          }
          function visible(node) {
            if (!node || node.offsetParent === null || !node.getBoundingClientRect) return false;
            var rect = node.getBoundingClientRect();
            return rect.width >= 8 && rect.height >= 8;
          }
          var roots = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [class*="dialog"], [class*="modal"]'))
            .filter(function(root) {
              return visible(root) && /(删除|delete|confirm|确认|确定)/i.test(text(root));
            });
          if (roots.length === 0) return null;
          var nodes = [];
          roots.forEach(function(root) {
            nodes = nodes.concat(Array.from(root.querySelectorAll('button, [role="button"], .monaco-button, .monaco-text-button, div, span')));
          });
          var candidates = [];
          for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (!visible(node)) continue;
            var label = text(node);
            var cls = String(node.className || '');
            if (/取消|cancel/i.test(label)) continue;
            if (!/^(确认|确定|删除|delete|confirm)$/i.test(label) && !/(确认删除|确定删除|delete|confirm)/i.test(label + ' ' + cls)) continue;
            var rect = node.getBoundingClientRect();
            candidates.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, score: 100 - Math.min(80, rect.width * rect.height / 600), nodeText: label.slice(0, 120), nodeClass: cls.slice(0, 180) });
          }
          candidates.sort(function(a, b) { return b.score - a.score; });
          return candidates[0] || null;
        })()
      `,
      returnByValue: true
    });
    return result.result?.value || null;
  }

  _normalizeSoloChatDeleteMatchText(value) {
    return String(value || '')
      .replace(/重命名|导出|复制会话|复制|删除任务|删除会话/gi, ' ')
      .replace(/rename|export|copy conversation|copy|delete task|delete conversation|remove task|remove conversation|delete|remove/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  _soloChatMatchesDeleteCandidate(chat = {}, candidate = {}) {
    const haystack = this._normalizeSoloChatDeleteMatchText(`${chat.title || ''} ${chat.text || ''}`);
    if (!haystack) return false;
    const title = this._normalizeSoloChatDeleteMatchText(candidate.title);
    const text = this._normalizeSoloChatDeleteMatchText(candidate.text);
    return Boolean((title && haystack.includes(title)) || (text && haystack.includes(text)));
  }

  async deleteSoloChats(options = {}) {
    const candidates = Array.isArray(options.candidates) ? options.candidates : [];
    if (candidates.length === 0) {
      return { deleted: 0, attempts: [], totalCandidates: 0, support: 'delete_candidates_not_provided' };
    }
    const attempts = [];
    let deleted = 0;
    const sorted = candidates.slice().sort((a, b) => (Number(b.index) || 0) - (Number(a.index) || 0));
    for (const candidate of sorted) {
      const action = await this._findSoloChatActionPoint(candidate);
      if (!action) {
        attempts.push({ success: false, reason: 'chat_not_found', candidate });
        continue;
      }
      await this.domHelper.dispatchTrustedMouseClick(action.actionPoint);
      await sleep(350);
      let deletePoint = await this._findSoloDeleteMenuPoint(action.actionPoint);
      if (!deletePoint) {
        await this.domHelper.dispatchTrustedMouseClick(action.rowPoint, { button: 'right' });
        await sleep(350);
        deletePoint = await this._findSoloDeleteMenuPoint(action.rowPoint);
      }
      if (!deletePoint) {
        attempts.push({ success: false, reason: 'delete_control_not_found', candidate, action });
        continue;
      }
      await this.domHelper.dispatchTrustedMouseClick(deletePoint);
      await sleep(this.config.postActionDelayMs || 500);
      const confirmPoint = await this._findSoloDeleteConfirmPoint();
      if (confirmPoint) {
        await this.domHelper.dispatchTrustedMouseClick(confirmPoint);
        await sleep(this.config.postActionDelayMs || 500);
      }
      const after = await this.listSoloChats();
      const stillPresent = Array.isArray(after.chats) && after.chats.some(chat => this._soloChatMatchesDeleteCandidate(chat, candidate));
      const success = !stillPresent;
      if (success) deleted += 1;
      attempts.push({ success, reason: success ? null : 'delete_verification_failed', candidate, action, deletePoint, confirmPoint });
    }
    return { deleted, attempts, totalCandidates: candidates.length, support: 'delete_supported' };
  }

  async getActiveSoloChat() {
    const result = await this.listSoloChats();
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

  async switchSoloChat(criteria = {}) {
    const index = Number.isInteger(criteria.index) ? criteria.index : null;
    const textIncludes = typeof criteria.textIncludes === 'string' ? criteria.textIncludes.trim() : '';
    const titleIncludes = typeof criteria.titleIncludes === 'string' ? criteria.titleIncludes.trim() : '';
    if (index === null && !textIncludes && !titleIncludes) {
      throw new Error('switchSoloChat requires index, textIncludes, or titleIncludes');
    }

    const result = await this.client.send('Runtime.evaluate', {
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
      await sleep(this.config.postActionDelayMs || 500);
    }
    return value;
  }
}

module.exports = { SoloChatManager };
