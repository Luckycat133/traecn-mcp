'use strict';

/**
 * DialogHandler — handles approval dialogs, question dialogs, review gates,
 * and restricted mode.
 * Extracted from DomDriver to isolate dialog-interaction responsibility.
 */

const { safeJsValue } = require('../shared/utils');
const { sleep } = require('../shared/utils');
const { DIALOG_BUTTON_SELECTOR } = require('./dom-driver-utils');

class DialogHandler {
  constructor(client, config, domHelper) {
    this.client = client;
    this.config = config;
    this.domHelper = domHelper;
  }

  // ── Approval dialog detection ──────────────────────────────────────────

  async checkForApprovalDialog() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
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
      return { needsApproval: false, error: e.message };
    }
  }

  // ── Dialog approval ────────────────────────────────────────────────────

  async approveDialog(action) {
    try {
      const dialog = await this.checkForApprovalDialog();
      if (!dialog.needsApproval) {
        return { success: false, action, error: 'No dialog found to approve' };
      }

      const targetLabels = this._getButtonLabelsForAction(action);

      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var targetLabels = ${JSON.stringify(targetLabels)};
            var action = ${JSON.stringify(action)};
            function isNegativeMatch(text) {
              if (!text) return false;
              if (action !== 'trust' && action !== 'approve') return false;
              return /不信任|deny|cancel|关闭|dismiss/i.test(text);
            }

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
        await sleep(this.config.postActionDelayMs);
        const dialogAfter = await this.checkForApprovalDialog();
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

  async answerQuestionDialog(answer) {
    const selectedAnswer = String(answer || '').trim();
    if (!selectedAnswer) {
      return { success: false, action: 'answer', error: 'answer is required' };
    }

    const dialog = await this.checkForApprovalDialog();
    if (!dialog.needsApproval) {
      return { success: false, action: 'answer', answer: selectedAnswer, error: 'No question dialog found' };
    }

    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var answer = ${safeJsValue(selectedAnswer)};
          var aliases = [answer];
          if (/current|uncommitted|workspace|staged|\\u672a\\u63d0\\u4ea4|\\u5de5\\u4f5c\\u533a/i.test(answer)) {
            aliases.push('Current workspace changes', 'Uncommitted changes', 'Review uncommitted/staged changes in the workspace', 'Review any uncommitted or staged workspace changes');
          }
          if (/latest|commit|recent|\\u6700\\u8fd1|\\u63d0\\u4ea4/i.test(answer)) {
            aliases.push('Latest commit changes', 'Review only the changes in the most recent commit');
          }
          if (/specific|file|folder|path|\\u6587\\u4ef6|\\u76ee\\u5f55/i.test(answer)) {
            aliases.push('Specific files', 'Specific files or folder', 'Review specific file(s) in the project', 'Review a specific file, directory, or set of files');
          }
          if (/branch|compare|\\u5206\\u652f|\\u5bf9\\u6bd4/i.test(answer)) {
            aliases.push('Compare with a branch', 'Review changes compared to another branch');
          }
          if (/other|\\u5176\\u4ed6/i.test(answer)) {
            aliases.push('\\u5176\\u4ed6', 'Other');
          }

          function isVisible(el) {
            if (!el || el.offsetParent === null) return false;
            var rect = el.getBoundingClientRect();
            return rect.width >= 12 && rect.height >= 12 && rect.bottom >= 0 && rect.top <= window.innerHeight;
          }

          function clickElement(el) {
            var rect = el.getBoundingClientRect();
            var x = rect.x + rect.width / 2;
            var y = rect.y + rect.height / 2;
            el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerType: 'mouse' }));
            el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 0, pointerType: 'mouse' }));
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            if (typeof el.click === 'function') el.click();
          }

          var cards = document.querySelectorAll('.ask-user-question-card-container, [class*="ask-user-question-card"]');
          var targetCard = null;
          for (var c = 0; c < cards.length; c++) {
            if (!isVisible(cards[c])) continue;
            var cardText = cards[c].textContent || '';
            if (/What would you like me to review\\?|Review Scope|Latest commit changes|Uncommitted changes|Specific files or folder/i.test(cardText)) {
              targetCard = cards[c];
              break;
            }
          }
          if (!targetCard) return { success: false, error: 'No visible question card found' };

          var optionNodes = targetCard.querySelectorAll('.ask-user-single-choice-item, .icd-checkbox-item-container, [class*="single-choice"], [class*="checkbox-item"], [role="radio"], [role="option"], div');
          var selectedOption = null;
          var selectedText = '';
          for (var i = 0; i < optionNodes.length; i++) {
            var option = optionNodes[i];
            if (!isVisible(option)) continue;
            var text = (option.innerText || option.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!text) continue;
            for (var a = 0; a < aliases.length; a++) {
              var alias = String(aliases[a] || '').replace(/\\s+/g, ' ').trim();
              if (!alias) continue;
              if (text.toLowerCase().includes(alias.toLowerCase()) || alias.toLowerCase().includes(text.toLowerCase())) {
                selectedOption = option.closest('.ask-user-single-choice-item, .icd-checkbox-item-container, [role="radio"], [role="option"]') || option;
                selectedText = text;
                break;
              }
            }
            if (selectedOption) break;
          }
          if (!selectedOption) return { success: false, error: 'No matching answer option found', answer: answer };
          clickElement(selectedOption);

          var nextNodes = targetCard.querySelectorAll('button, [role="button"], [class*="button"], [class*="btn"], div, span');
          var nextButton = null;
          for (var n = 0; n < nextNodes.length; n++) {
            var node = nextNodes[n];
            if (!isVisible(node)) continue;
            var nodeText = (node.innerText || node.textContent || '').trim();
            if (/^(\\u4e0b\\u4e00\\u4e2a|Next)$/i.test(nodeText)) {
              nextButton = node.closest('button, a[role="button"], [role="button"], .monaco-button, .monaco-text-button, [class*="button"], [class*="btn"]') || node;
              break;
            }
          }
          if (!nextButton) return { success: false, error: 'No next button found', selectedOption: selectedText };
          clickElement(nextButton);
          return { success: true, selectedOption: selectedText, buttonClicked: (nextButton.innerText || nextButton.textContent || '').trim() };
        })()
      `,
      returnByValue: true
    });

    const answerResult = result.result?.value || {};
    if (!answerResult.success) {
      return { success: false, action: 'answer', answer: selectedAnswer, error: answerResult.error || 'Failed to answer question dialog' };
    }

    await sleep(this.config.postActionDelayMs);
    const dialogAfter = await this.checkForApprovalDialog();
    return {
      success: !dialogAfter.needsApproval,
      action: 'answer',
      answer: selectedAnswer,
      selectedOption: answerResult.selectedOption,
      buttonClicked: answerResult.buttonClicked,
      error: dialogAfter.needsApproval ? 'Question dialog remained visible after answering' : undefined
    };
  }

  _getButtonLabelsForAction(action) {
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

  // ── Review gate ────────────────────────────────────────────────────────

  async checkTaskReviewGate() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const controls = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"]'));
            const visibleControls = controls
              .filter(el => el && el.offsetParent !== null)
              .map(el => {
                const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
                const rect = el.getBoundingClientRect();
                return {
                  text,
                  className: el.className || '',
                  aria: el.getAttribute('aria-label') || '',
                  x: rect.x + rect.width / 2,
                  y: rect.y + rect.height / 2,
                  width: rect.width,
                  height: rect.height
                };
              })
              .filter(item => item.text);

            const keepAll = visibleControls.find(item => item.text === '全部保留' || /^Keep All$/i.test(item.text));
            const revertAll = visibleControls.find(item => item.text === '全部撤销' || /^Discard All$/i.test(item.text));
            const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
            const reviewCountMatch = bodyText.match(/(\\d+)\\s*个文件待审查/);
            const taskCompleted = bodyText.includes('任务完成') || bodyText.includes('Task completed');
            const waitingToSend = bodyText.includes('等待发送');
            const newChat = document.querySelector('[aria-label="新建会话"]');
            const newChatDisabled = newChat ? /disabled/.test(newChat.className || '') : null;

            return {
              awaitingReview: !!(keepAll || revertAll),
              taskCompleted,
              waitingToSend,
              reviewCount: reviewCountMatch ? Number(reviewCountMatch[1]) : null,
              keepAll: keepAll || null,
              revertAll: revertAll || null,
              newChatDisabled,
              visibleButtons: visibleControls
                .filter(item => /保留|撤销|审查|Review|Keep|Discard/.test(item.text))
                .slice(0, 10)
            };
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || {
        awaitingReview: false,
        taskCompleted: false,
        waitingToSend: false,
        reviewCount: null,
        keepAll: null,
        revertAll: null,
        newChatDisabled: null,
        visibleButtons: []
      };
    } catch (e) {
      return {
        awaitingReview: false,
        taskCompleted: false,
        waitingToSend: false,
        reviewCount: null,
        keepAll: null,
        revertAll: null,
        newChatDisabled: null,
        visibleButtons: [],
        error: e.message
      };
    }
  }

  async resolveTaskReviewGate(preferredAction = 'keep_all') {
    const gate = await this.checkTaskReviewGate();
    if (!gate.awaitingReview) {
      return { success: false, action: preferredAction, reason: 'no_review_gate' };
    }

    const target = ['discard_all', 'revert_all'].includes(preferredAction) ? gate.revertAll : gate.keepAll;
    if (!target) {
      return { success: false, action: preferredAction, reason: 'target_button_not_found', gate };
    }

    try {
      const waitForResolution = async () => {
        for (let attempt = 0; attempt < 12; attempt++) {
          await sleep(Math.max(this.config.postActionDelayMs, 250));
          const after = await this.checkTaskReviewGate();
          if (!after.awaitingReview || after.newChatDisabled === false) {
            return {
              success: true,
              action: preferredAction,
              reviewCount: gate.reviewCount,
              buttonText: target.text,
              newChatDisabled: after.newChatDisabled
            };
          }
        }
        return null;
      };

      await this.client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: target.x,
        y: target.y,
        button: 'left',
        clickCount: 1
      });
      await this.client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: target.x,
        y: target.y,
        button: 'left',
        clickCount: 1
      });

      const mouseResolution = await waitForResolution();
      if (mouseResolution) return mouseResolution;

      await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const buttons = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"]'));
            const target = buttons.find(el => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ') === ${safeJsValue(target.text)});
            if (!target) return { ok: false };
            target.focus();
            return { ok: true };
          })()
        `,
        returnByValue: true
      });
      await this.client.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      });
      await this.client.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      });

      const keyboardResolution = await waitForResolution();
      if (keyboardResolution) return keyboardResolution;

      await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const controls = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .icd-btn, .icube-btn'));
            const target = controls.find(el => {
              const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
              const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
              const style = window.getComputedStyle(el);
              return text === ${safeJsValue(target.text)}
                && rect && rect.width > 0 && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
            });
            if (!target) return { ok: false, reason: 'target_not_found' };
            target.scrollIntoView({ block: 'center', inline: 'center' });
            target.focus();
            const rect = target.getBoundingClientRect();
            const opts = {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: window,
              clientX: rect.x + rect.width / 2,
              clientY: rect.y + rect.height / 2,
              button: 0,
              buttons: 1
            };
            for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
              target.dispatchEvent(new Ctor(type, opts));
            }
            return { ok: true };
          })()
        `,
        returnByValue: true
      });

      const syntheticResolution = await waitForResolution();
      if (syntheticResolution) return syntheticResolution;

      if (['keep_all', 'keep'].includes(preferredAction)) {
        const individualResult = await this.client.send('Runtime.evaluate', {
          expression: `
            (async () => {
              const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
              let clicked = 0;
              for (let attempt = 0; attempt < 20; attempt++) {
                const buttons = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .monaco-button, .icube-btn'));
                const keep = buttons.find(el => {
                  const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
                  const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
                  return text === '保留' && rect && rect.width > 0 && rect.height > 0;
                });
                if (!keep) break;
                keep.click();
                clicked++;
                await sleep(250);
              }
              return { clicked };
            })()
          `,
          awaitPromise: true,
          returnByValue: true
        });
        const individualResolution = await waitForResolution();
        if (individualResolution) {
          individualResolution.individualClicks = individualResult.result?.value?.clicked || 0;
          return individualResolution;
        }
      }

      const finalGate = await this.checkTaskReviewGate();
      return {
        success: false,
        action: preferredAction,
        reason: 'review_gate_persisted',
        gate: finalGate,
        buttonText: target.text
      };
    } catch (e) {
      return { success: false, action: preferredAction, reason: 'error', error: e.message };
    }
  }

  // ── Restricted mode ────────────────────────────────────────────────────

  _summarizeRestrictedModeState(snapshot = {}) {
    const rawBody = String(snapshot.bodyText || '');
    const body = rawBody.trim();
    const bodyLower = body.toLowerCase();
    const buttonTexts = Array.isArray(snapshot.buttonTexts)
      ? snapshot.buttonTexts.map(text => String(text || '').trim()).filter(Boolean)
      : [];

    const hasAny = (haystack, needles) => needles.some(needle => haystack.includes(needle));
    const buttonMatches = (patterns) => buttonTexts.some(text => patterns.some(pattern => pattern.test(text)));

    const onWorkspaceTrustPage = hasAny(bodyLower, ['工作区信任', 'workspace trust']);
    const trustedCopyVisible = hasAny(bodyLower, [
      '你信任此文件夹',
      'you trust this folder',
      'all files in the current window are trusted'
    ]);
    const untrustButtonVisible = buttonMatches([/不信任/i, /don't trust/i, /stop trusting/i]);
    const trustButtonVisible = buttonMatches([/^信任$/, /^trust$/i, /信任此文件夹/, /trust this folder/i, /信任父级/, /trust parent/i]);
    const manageButtonVisible = buttonMatches([/^管理$/, /^manage$/i]);

    if (onWorkspaceTrustPage && (trustedCopyVisible || untrustButtonVisible)) {
      return {
        restricted: false,
        trusted: true,
        panelOpen: true,
        title: '工作区信任',
        trustButtonFound: false,
        trustButtonText: '',
        manageButtonFound: false,
        hasOverlay: snapshot.hasOverlay === true
      };
    }

    const hasRestrictedBanner = hasAny(bodyLower, [
      '受限模式',
      'restricted mode',
      '安全地浏览代码',
      'trust this folder',
      '信任此文件夹',
      '点击「信任」',
      '点击信任'
    ]);

    if (onWorkspaceTrustPage || hasRestrictedBanner) {
      const title = onWorkspaceTrustPage
        ? '工作区信任'
        : (snapshot.title || '受限模式');
      return {
        restricted: true,
        trusted: false,
        panelOpen: onWorkspaceTrustPage,
        title,
        trustButtonFound: trustButtonVisible,
        trustButtonText: trustButtonVisible
          ? buttonTexts.find(text => /^信任$|^trust$|信任此文件夹|trust this folder|信任父级|trust parent/i.test(text)) || ''
          : '',
        manageButtonFound: manageButtonVisible,
        hasOverlay: snapshot.hasOverlay === true
      };
    }

    return {
      restricted: false,
      trusted: false,
      panelOpen: false,
      trustButtonFound: false,
      trustButtonText: '',
      manageButtonFound: false,
      hasOverlay: snapshot.hasOverlay === true
    };
  }

  async checkRestrictedMode() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const body = document.body ? (document.body.innerText || document.body.textContent || '') : '';
            const titleEl = document.querySelector('.monaco-dialog-title, [role="heading"], h1, h2, h3, .pane-header');
            const title = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : '';
            const controls = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .monaco-button, .monaco-text-button, [class*="button"], [class*="btn"]'));
            const buttonTexts = controls
              .filter(el => el && el.offsetParent !== null)
              .map(el => (el.innerText || el.textContent || '').trim())
              .filter(Boolean);
            const modals = document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="overlay"], [class*="mask"]');
            const hasOverlay = Array.from(modals).some(m => {
              const rect = m.getBoundingClientRect();
              return rect.width > 100 && rect.height > 50;
            });

            return {
              bodyText: body,
              title,
              buttonTexts,
              hasOverlay
            };
          })()
        `,
        returnByValue: true,
        timeout: 5000
      });

      return this._summarizeRestrictedModeState(result.result?.value || {});
    } catch (err) {
      return { restricted: false, error: err.message };
    }
  }

  async clickRestrictedModeTrust() {
    try {
      const restrictedCheck = await this.checkRestrictedMode();
      if (!restrictedCheck || !restrictedCheck.restricted) {
        if (restrictedCheck?.trusted) {
          return { success: true, action: 'already_trusted', panelOpen: restrictedCheck.panelOpen === true };
        }
        return { success: false, reason: 'no_restricted_mode_found' };
      }

      const openManage = async () => {
        const result = await this.client.send('Runtime.evaluate', {
          expression: `
            (() => {
              const candidates = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .monaco-button'));
              for (const el of candidates) {
                if (!el || el.offsetParent === null) continue;
                const text = (el.innerText || el.textContent || '').trim();
                if (!text) continue;
                if (!/管理|manage/i.test(text)) continue;
                const rect = el.getBoundingClientRect();
                el.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, cancelable: true, composed: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                  button: 0, buttons: 1, pointerType: 'mouse'
                }));
                el.dispatchEvent(new PointerEvent('pointerup', {
                  bubbles: true, cancelable: true, composed: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                  button: 0, buttons: 1, pointerType: 'mouse'
                }));
                el.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
                }));
                if (typeof el.click === 'function') el.click();
                return { clicked: true, text };
              }
              return { clicked: false };
            })()
          `,
          returnByValue: true
        });
        return result.result?.value || { clicked: false };
      };

      const clickTrustFromRestrictedPanel = async () => {
        const result = await this.client.send('Runtime.evaluate', {
          expression: `
            (() => {
              const preferred = ['信任', 'Trust', '信任父级', 'Trust Parent'];
              const candidates = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .monaco-button, .monaco-text-button, .quick-input-widget button'));
              for (const label of preferred) {
                for (const el of candidates) {
                  if (!el || el.offsetParent === null) continue;
                  const text = (el.innerText || el.textContent || '').trim();
                  if (!text || text !== label) continue;
                  const rect = el.getBoundingClientRect();
                  if (rect.width < 12 || rect.height < 12) continue;
                  el.dispatchEvent(new PointerEvent('pointerdown', {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                    button: 0, buttons: 1, pointerType: 'mouse'
                  }));
                  el.dispatchEvent(new PointerEvent('pointerup', {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                    button: 0, buttons: 1, pointerType: 'mouse'
                  }));
                  el.dispatchEvent(new MouseEvent('click', {
                    bubbles: true, cancelable: true,
                    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
                  }));
                  if (typeof el.click === 'function') el.click();
                  return { clicked: true, text };
                }
              }
              return { clicked: false };
            })()
          `,
          returnByValue: true
        });
        return result.result?.value || { clicked: false };
      };

      if (restrictedCheck.trustButtonFound) {
        const approveResult = await this.approveDialog('trust');
        if (approveResult.success) {
          await sleep(this.config.postActionDelayMs * 2);
          return { success: true, action: 'trust_clicked', buttonText: approveResult.buttonText };
        }
      }

      if (restrictedCheck.manageButtonFound) {
        const manageResult = await openManage();
        if (manageResult.clicked) {
          for (let attempt = 0; attempt < 8; attempt++) {
            await sleep(Math.max(this.config.postActionDelayMs, 200));
            const restrictedAfterManage = await this.checkRestrictedMode();
            if (!restrictedAfterManage.restricted || restrictedAfterManage.trusted) {
              return {
                success: true,
                action: 'trust_clicked',
                buttonText: manageResult.text
              };
            }
          }
          const panelTrustResult = await clickTrustFromRestrictedPanel();
          if (panelTrustResult.clicked) {
            await sleep(this.config.postActionDelayMs * 2);
            const restrictedAfter = await this.checkRestrictedMode();
            if (!restrictedAfter.restricted || restrictedAfter.trusted) {
              return {
                success: true,
                action: 'trust_clicked',
                buttonText: panelTrustResult.text,
                manageButtonText: manageResult.text
              };
            }
          }

          const approveResult = await this.approveDialog('trust');
          if (approveResult.success) {
            await sleep(this.config.postActionDelayMs * 2);
            return {
              success: true,
              action: 'trust_clicked',
              buttonText: approveResult.buttonText,
              manageButtonText: manageResult.text
            };
          }
        }
      }

      return {
        success: false,
        reason: 'trust_button_not_found_or_click_failed',
        restrictedInfo: restrictedCheck,
        message: '受限模式已启用，请手动在Trae CN窗口中点击「信任」按钮'
      };
    } catch (e) {
      return { success: false, reason: 'error', error: e.message };
    }
  }
}

module.exports = { DialogHandler };
