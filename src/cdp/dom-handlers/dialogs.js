'use strict';

/**
 * dialogs handlers.
 *
 * Moved verbatim from src/cdp/dom-driver.js. Each method is now an
 * exported function with signature `function method(driver, ...args)`
 * taking the DomDriver instance as `driver`. Behavior is preserved 1:1.
 *
 * Covers: approval dialog detection + answering + restricted-mode trust
 * + readiness probe.
 *
 * The DomDriver retains thin delegating shims so existing
 * dom-driver.test.js cases that call `driver.checkForApprovalDialog()`,
 * `driver.approveDialog()`, `driver.answerQuestionDialog()`,
 * `driver.checkRestrictedMode()`, `driver.clickRestrictedModeTrust()`,
 * `driver.checkReadiness()`, and the `_getButtonLabelsForAction` /
 * `_summarizeRestrictedModeState` helpers continue to work unchanged.
 */

const { sleep, safeJsValue } = require('../../shared/utils');

const DIALOG_BUTTON_SELECTOR = [
  'button',
  'a[role="button"]',
  '[role="button"].monaco-button',
  '.monaco-button',
  '.monaco-text-button',
  '[role="button"]'
].join(', ');

async function checkForApprovalDialog(driver) {
  try {
    const result = await driver.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var indicators = [
            document.querySelector('[role="dialog"]'),
            document.querySelector('[role="alertdialog"]'),
            document.querySelector('.modal'),
            document.querySelector('.modal-overlay'),
            document.querySelector('[class*="dialog"]'),
            document.querySelector('button[aria-label*="\\u6279\\u51c6"]'),
            document.querySelector('button[aria-label*="Approve"]'),
            document.querySelector('button[aria-label*="\\u5141\\u8bb8"]'),
            document.querySelector('button[aria-label*="Allow"]'),
            document.querySelector('button[class*="approve"]'),
            document.querySelector('.ipc-overlay'),
            document.querySelector('.monaco-dialog'),
            document.querySelector('[aria-label*="\\u9700\\u8981\\u786e\\u8ba4"]')
          ];

          for (var i = 0; i < indicators.length; i++) {
            var el = indicators[i];
            if (el && el.offsetParent !== null && el.getBoundingClientRect().width > 0) {
              var titleEl = el.querySelector('.monaco-dialog-title') || el.querySelector('[class*="title"]') || el.querySelector('[role="heading"]') || el;
              var buttons = el.querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)});
              var buttonTexts = [];
              buttons.forEach(function(b) {
                if (!b || b.offsetParent === null) return;
                var text = (b.innerText || b.textContent || '').trim();
                if (!text) return;
                if (!buttonTexts.includes(text)) buttonTexts.push(text);
              });
              var fullText = (titleEl.textContent || '').trim().substring(0, 200);
              // Detect if this is a command execution approval dialog
              var cmdKeywords = ['执行', '运行', '命令', 'command'];
              var isCmdExec = false;
              for (var p = 0; p < cmdKeywords.length; p++) {
                if (fullText.toLowerCase().includes(cmdKeywords[p].toLowerCase())) {
                  isCmdExec = true; break;
                }
              }
              return {
                found: true,
                title: fullText,
                buttons: buttonTexts.slice(0, 5),
                type: el.className || 'modal',
                isCommandExec: isCmdExec
              };
            }
          }

          var visibleReviewCards = document.querySelectorAll('.ask-user-question-card-container, [class*="ask-user-question-card"]');
          for (var vc = 0; vc < visibleReviewCards.length; vc++) {
            var visibleCard = visibleReviewCards[vc];
            if (!visibleCard || visibleCard.offsetParent === null) continue;
            var visibleRect = visibleCard.getBoundingClientRect();
            if (visibleRect.width < 100 || visibleRect.height < 40) continue;
            if (visibleRect.bottom < 0 || visibleRect.top > window.innerHeight) continue;
            var visibleCardText = visibleCard.textContent || '';
            var isReviewScopeCard = /What would you like me to review\\?|Review Scope|Latest commit changes|Uncommitted changes|Specific files or folder/i.test(visibleCardText);
            var isPendingQuestion = /\\u6b63\\u5728\\u7b49\\u5f85\\u4f60\\u7684\\u64cd\\u4f5c|Cancel|Next|\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a/i.test(visibleCardText);
            if (!isReviewScopeCard || !isPendingQuestion) continue;
            var visibleReviewButtons = [];
            var visibleOptions = [];
            var visibleReviewButtonNodes = visibleCard.querySelectorAll(${safeJsValue(`${DIALOG_BUTTON_SELECTOR}, [class*="button"], [class*="btn"], div, span`)});
            visibleReviewButtonNodes.forEach(function(b) {
              if (!b || b.offsetParent === null) return;
              var text = (b.innerText || b.textContent || '').trim();
              if (!text) return;
              if (/^(\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|Cancel|Next)$/i.test(text) && !visibleReviewButtons.includes(text)) {
                visibleReviewButtons.push(text);
              }
            });
            var knownLabels = [
              'Latest commit changes',
              'Uncommitted changes',
              'Current workspace changes',
              'Changes compared to a branch',
              'A specific MR/PR',
              'Specific files',
              'Specific files or folder',
              'Compare with a branch',
              '\\u5176\\u4ed6'
            ];
            var optionNodes = visibleCard.querySelectorAll('.ask-user-single-choice-item, .icd-checkbox-item-container, [class*="single-choice"], [class*="checkbox-item"], [role="radio"], [role="option"]');
            optionNodes.forEach(function(option) {
              if (!option || option.offsetParent === null) return;
              var rect = option.getBoundingClientRect();
              if (rect.width < 50 || rect.height < 20) return;
              var text = (option.innerText || option.textContent || '').replace(/\\s+/g, ' ').trim();
              if (!text) return;
              var label = '';
              for (var ko = 0; ko < knownLabels.length; ko++) {
                if (text.includes(knownLabels[ko])) {
                  label = knownLabels[ko];
                  break;
                }
              }
              if (!label) return;
              var description = text.replace(label, '').trim();
              if (!visibleOptions.some(function(item) { return item.label === label; })) {
                visibleOptions.push({ label: label, description: description });
              }
            });
            var compactText = visibleCardText.replace(/\\s+/g, ' ').trim();
            var hits = [];
            knownLabels.forEach(function(label) {
              var idx = compactText.indexOf(label);
              if (idx >= 0) hits.push({ label: label, index: idx });
            });
            hits.sort(function(a, b) { return a.index - b.index; });
            var parsedOptions = [];
            for (var hi = 0; hi < hits.length; hi++) {
              var start = hits[hi].index + hits[hi].label.length;
              var end = hi + 1 < hits.length ? hits[hi + 1].index : compactText.length;
              var desc = compactText.slice(start, end)
                .replace(/^(What would you like me to review\\?|Review scope|Review Scope|1\\/2|Cancel|Next|\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|\\u6b63\\u5728\\u7b49\\u5f85\\u4f60\\u7684\\u64cd\\u4f5c)\\s*/i, '')
                .replace(/\\s*(1\\/2|Review scope|Review Scope|Cancel|Next|\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|\\u6b63\\u5728\\u7b49\\u5f85\\u4f60\\u7684\\u64cd\\u4f5c).*$/i, '')
                .trim();
              if (!parsedOptions.some(function(item) { return item.label === hits[hi].label; })) {
                parsedOptions.push({ label: hits[hi].label, description: desc });
              }
            }
            if (parsedOptions.length >= 2) {
              visibleOptions = parsedOptions;
            }
            return {
              found: true,
              title: 'Review Scope',
              buttons: visibleReviewButtons.slice(0, 5),
              options: visibleOptions.slice(0, 8),
              type: 'review_scope_question',
              isCommandExec: false,
              canAutoApprove: false
            };
          }

          var bodyText = document.body.textContent || '';
          var reviewScopePatterns = [
            'What would you like me to review?',
            'Review Scope',
            'Latest commit changes',
            'Uncommitted changes',
            'Specific files or folder',
            '\\u6b63\\u5728\\u7b49\\u5f85\\u4f60\\u7684\\u64cd\\u4f5c'
          ];
          var reviewScopeHits = 0;
          for (var r = 0; r < reviewScopePatterns.length; r++) {
            if (bodyText.includes(reviewScopePatterns[r])) reviewScopeHits++;
          }
          if (reviewScopeHits >= 2 && document.querySelector('.ask-user-question-card-status-pending')) {
            var reviewButtons = [];
            var reviewButtonNodes = document.querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)});
            reviewButtonNodes.forEach(function(b) {
              if (!b || b.offsetParent === null) return;
              var text = (b.innerText || b.textContent || '').trim();
              if (!text) return;
              if (/^(\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|Cancel|Next)$/i.test(text) && !reviewButtons.includes(text)) {
                reviewButtons.push(text);
              }
            });
            return {
              found: true,
              title: 'Review Scope',
              buttons: reviewButtons.slice(0, 5),
              type: 'review_scope_question',
              isCommandExec: false,
              canAutoApprove: false
            };
          }
          var approvalPatterns = ['\\u9700\\u8981\\u60a8\\u6388\\u6743', '\\u9700\\u8981\\u60a8\\u7684\\u6279\\u51c6', '\\u662f\\u5426\\u5141\\u8bb8', 'Do you want to proceed', 'requires your confirmation'];
          for (var j = 0; j < approvalPatterns.length; j++) {
            if (bodyText.includes(approvalPatterns[j])) {
              return { found: true, title: approvalPatterns[j], buttons: [], type: 'text-pattern', isCommandExec: false };
            }
          }

          return { found: false };
        })()
      `,
      returnByValue: true
    });

    const dialog = result.result?.value;
    if (dialog && dialog.found) {
      return {
        needsApproval: true,
        question: dialog.title || 'Trae\\u9700\\u8981\\u60a8\\u786e\\u8ba4',
        dialogType: dialog.type || 'approval',
        buttons: dialog.buttons || [],
        options: dialog.options || [],
        isCommandExec: dialog.isCommandExec || false,
        canAutoApprove: dialog.canAutoApprove === true,
      };
    }
    return { needsApproval: false };
  } catch (e) {
    const errorCode = e.code || 0;
    const isConnectionError = errorCode === -32603 || errorCode === -32000 || /disconnect|connection|websocket/i.test(e.message);
    if (isConnectionError) {
      throw e;
    }
    return { needsApproval: false, error: e.message, transient: true };
  }
}

async function approveDialog(driver, action) {
  try {
    const dialog = await driver.checkForApprovalDialog();
    if (dialog.transient) {
      return { success: false, action, error: dialog.error, transient: true };
    }
    if (!dialog.needsApproval) {
      return { success: false, action, error: 'No dialog found to approve' };
    }

    const targetLabels = _getButtonLabelsForAction(action);

    const result = await driver.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var targetLabels = ${JSON.stringify(targetLabels)};
          var action = ${JSON.stringify(action)};
          function isNegativeMatch(text) {
            if (!text) return false;
            if (action !== 'trust' && action !== 'approve') return false;
            return /不信任|deny|cancel|关闭|dismiss/i.test(text);
          }

          // Find all clickable elements in visible dialogs
          var dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .modal-overlay, [class*="dialog"], [class*="overlay"], .monaco-dialog');
          var buttonsToSearch = [];

          if (dialogs.length > 0) {
            for (var d = 0; d < dialogs.length; d++) {
              if (dialogs[d].offsetParent === null) continue;
              var btns = dialogs[d].querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)});
              for (var b = 0; b < btns.length; b++) {
                var btn = btns[b];
                if (!btn || btn.offsetParent === null) continue;
                var text = (btn.innerText || btn.textContent || '').trim();
                var rect = btn.getBoundingClientRect();
                if (!text || rect.width < 12 || rect.height < 12) continue;
                buttonsToSearch.push(btn);
              }
            }
          } else {
            // Fallback: search all buttons
            var allButtons = document.querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)});
            for (var b = 0; b < allButtons.length; b++) {
              var fallbackBtn = allButtons[b];
              if (!fallbackBtn || fallbackBtn.offsetParent === null) continue;
              var fallbackText = (fallbackBtn.innerText || fallbackBtn.textContent || '').trim();
              var fallbackRect = fallbackBtn.getBoundingClientRect();
              if (!fallbackText || fallbackRect.width < 12 || fallbackRect.height < 12) continue;
              buttonsToSearch.push(fallbackBtn);
            }
          }

          var reviewCards = document.querySelectorAll('.ask-user-question-card-container, [class*="ask-user-question-card"]');
          for (var rc = 0; rc < reviewCards.length; rc++) {
            var card = reviewCards[rc];
            if (!card || card.offsetParent === null) continue;
            var cardText = card.textContent || '';
            if (!/Review Scope|What would you like me to review\\?|\\u6b63\\u5728\\u7b49\\u5f85\\u4f60\\u7684\\u64cd\\u4f5c/i.test(cardText)) continue;
            var cardNodes = card.querySelectorAll('button, [role="button"], [class*="button"], [class*="btn"], div, span');
            for (var cn = 0; cn < cardNodes.length; cn++) {
              var node = cardNodes[cn];
              if (!node || node.offsetParent === null) continue;
              var nodeText = (node.innerText || node.textContent || '').trim();
              if (!/^(\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|Cancel|Next)$/i.test(nodeText)) continue;
              var clickable = node.closest('button, a[role="button"], [role="button"], .monaco-button, .monaco-text-button, [class*="button"], [class*="btn"]') || node;
              var nodeRect = clickable.getBoundingClientRect();
              if (nodeRect.width < 12 || nodeRect.height < 12) continue;
              if (!buttonsToSearch.includes(clickable)) buttonsToSearch.push(clickable);
            }
          }

          // First pass: exact match
          for (var b = 0; b < buttonsToSearch.length; b++) {
            var btn = buttonsToSearch[b];
            if (btn.offsetParent === null) continue;
            var text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            if (isNegativeMatch(text)) continue;
            for (var t = 0; t < targetLabels.length; t++) {
              if (text === targetLabels[t].toLowerCase() || text.includes(targetLabels[t].toLowerCase())) {
                var rect = btn.getBoundingClientRect();
                btn.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, cancelable: true, composed: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                  button: 0, buttons: 1, pointerType: 'mouse'
                }));
                btn.dispatchEvent(new PointerEvent('pointerup', {
                  bubbles: true, cancelable: true, composed: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                  button: 0, buttons: 1, pointerType: 'mouse'
                }));
                btn.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
                }));
                btn.click();
                return { clicked: true, buttonText: (btn.innerText || btn.textContent || '').trim() };
              }
            }
          }

          // Second pass: partial match
          for (var b = 0; b < buttonsToSearch.length; b++) {
            var btn = buttonsToSearch[b];
            if (btn.offsetParent === null) continue;
            var text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            if (isNegativeMatch(text)) continue;
            for (var t = 0; t < targetLabels.length; t++) {
              if (text.includes(targetLabels[t].toLowerCase()) || targetLabels[t].toLowerCase().includes(text)) {
                var rect = btn.getBoundingClientRect();
                btn.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, cancelable: true, composed: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                  button: 0, buttons: 1, pointerType: 'mouse'
                }));
                btn.dispatchEvent(new PointerEvent('pointerup', {
                  bubbles: true, cancelable: true, composed: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                  button: 0, buttons: 1, pointerType: 'mouse'
                }));
                btn.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
                }));
                btn.click();
                return { clicked: true, buttonText: (btn.innerText || btn.textContent || '').trim() };
              }
            }
          }

          return { clicked: false, error: 'No matching button found', searchedLabels: targetLabels };
        })()
      `,
      returnByValue: true
    });

    const clickResult = result.result?.value || {};
    if (clickResult.clicked) {
      await sleep(driver.config.postActionDelayMs);
      const dialogAfter = await driver.checkForApprovalDialog();
      if (dialogAfter.needsApproval) {
        return {
          success: false,
          action,
          buttonClicked: clickResult.buttonText,
          error: 'Dialog remained visible after click'
        };
      }
      return {
        success: true,
        action,
        buttonClicked: clickResult.buttonText
      };
    }

    return {
      success: false,
      action,
      error: clickResult.error || 'Failed to click button',
      searchedLabels: clickResult.searchedLabels
    };
  } catch (e) {
    return { success: false, action, error: e.message };
  }
}

/**
 * Map an approve action to the list of button label patterns to search for.
 * Supports CN and EN labels.
 */
function _getButtonLabelsForAction(action) {
  switch (action) {
    case 'trust':
      return ['是，我信任此作者', '信任此作者', '信任', 'Trust', '信任此文件夹', '信任文件夹', '打开'];
    case 'allow':
      return ['允许', 'Allow', '批准', 'Approve', '允许此操作'];
    case 'confirm':
      return ['确认', 'Confirm', '确定', 'OK', '确认执行', '运行'];
    case 'approve':
      return ['是，我信任此作者', '批准', 'Approve', '允许', 'Allow', '确认', 'Confirm', '信任', 'Trust'];
    case 'deny':
      return ['拒绝', 'Deny', '不允许', '禁止', '拒绝此操作'];
    case 'cancel':
      return ['取消', 'Cancel', '关闭', 'Close', 'Dismiss'];
    case 'dismiss':
      return ['取消', 'Cancel', '关闭', 'Close', 'Dismiss', '不'];
    default:
      return ['确认', 'Confirm', '允许', 'Allow', '批准', 'Approve', '信任', 'Trust', '确定', 'OK'];
  }
}

async function checkReadiness(driver) {
  let composer = await driver.findComposer();
  let sendBtn = await driver.findSendButton();
  let response = await driver.findResponseRegion();
  let workspaceGuide = null;
  let composerFallback = null;
  let sendBtnFallback = null;

  if (!(composer && sendBtn)) {
    workspaceGuide = await driver.dismissWorkspaceGuideIfPresent();
    if (workspaceGuide.dismissed > 0 || workspaceGuide.success) {
      composer = await driver.findComposer();
      sendBtn = await driver.findSendButton();
      response = await driver.findResponseRegion();
    }
  }

  if (!composer) {
    composerFallback = await driver._findVisibleElementRuntime(driver.config.composerSelectors, { allowDisabled: true });
  }
  if (!sendBtn) {
    sendBtnFallback = await driver._findVisibleElementRuntime(driver.config.sendButtonSelectors, { allowDisabled: true });
  }

  // Include mode info
  let modeInfo;
  try {
    modeInfo = await driver.detectMode();
  } catch {
    modeInfo = { mode: 'unknown', confidence: 0, indicators: [] };
  }

  const blockers = await driver.inspectWorkspaceBlockers();
  const restricted = await driver.checkRestrictedMode();
  const dialog = await driver.checkForApprovalDialog();
  let blocker = null;
  const composerReady = !!(composer || composerFallback);
  const sendButtonReady = !!(sendBtn || sendBtnFallback);
  if (!(composerReady && sendButtonReady)) {
    if (dialog.needsApproval) blocker = 'approval_dialog';
    else if (restricted.restricted) blocker = 'trust_workspace';
    else if (blockers.guideVisible) blocker = 'workspace_guide';
    else if (blockers.loginVisible) blocker = 'login_required';
    else if (blockers.newTaskVisible) blocker = 'open_task_panel';
    else blocker = 'composer_unavailable';
  }

  return {
    ready: !!(composerReady && sendButtonReady),
    composer: composer ? { matchedSelector: composer.matchedSelector } : (composerFallback ? {
      matchedSelector: composerFallback.matchedSelector,
      runtimeFallback: true
    } : null),
    sendButton: sendBtn ? { matchedSelector: sendBtn.matchedSelector } : (sendBtnFallback ? {
      matchedSelector: sendBtnFallback.matchedSelector,
      runtimeFallback: true,
      disabled: sendBtnFallback.disabled === true
    } : null),
    responseRegion: response ? { matchedSelector: response.matchedSelector } : null,
    mode: modeInfo,
    blocker,
    workspaceGuide: workspaceGuide ? {
      success: workspaceGuide.success === true,
      dismissed: workspaceGuide.dismissed || 0,
      guideVisible: workspaceGuide.guideVisible === true,
      reason: workspaceGuide.reason || null
    } : null,
    blockers: {
      guideVisible: blockers.guideVisible === true,
      guideButtons: Array.isArray(blockers.guideButtons) ? blockers.guideButtons.map(item => item.text).slice(0, 6) : [],
      loginVisible: blockers.loginVisible === true,
      newTaskVisible: blockers.newTaskVisible === true
    }
  };
}

module.exports = {
  checkForApprovalDialog,
  approveDialog,
  _getButtonLabelsForAction,
  checkReadiness
};