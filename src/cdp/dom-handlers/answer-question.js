'use strict';

/**
 * answer-question handlers.
 *
 * Moved verbatim from src/cdp/dom-driver.js. Each method is now an
 * exported function with signature `function method(driver, ...args)`
 * taking the DomDriver instance as `driver`. Behavior is preserved 1:1.
 *
 * Covers: the multi-choice "review scope" question card flow — picking
 * the option that matches a caller-supplied answer (with CN/EN alias
 * normalization) and clicking Next.
 *
 * The DomDriver retains a thin delegating shim so existing
 * dom-driver.test.js cases that call `driver.answerQuestionDialog()`
 * continue to work unchanged.
 */

const { sleep, safeJsValue } = require('../../shared/utils');

async function answerQuestionDialog(driver, answer) {
  const selectedAnswer = String(answer || '').trim();
  if (!selectedAnswer) {
    return { success: false, action: 'answer', error: 'answer is required' };
  }

  const dialog = await driver.checkForApprovalDialog();
  if (!dialog.needsApproval) {
    return { success: false, action: 'answer', answer: selectedAnswer, error: 'No question dialog found' };
  }

  const result = await driver.client.send('Runtime.evaluate', {
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

  await sleep(driver.config.postActionDelayMs);
  const dialogAfter = await driver.checkForApprovalDialog();
  return {
    success: !dialogAfter.needsApproval,
    action: 'answer',
    answer: selectedAnswer,
    selectedOption: answerResult.selectedOption,
    buttonClicked: answerResult.buttonClicked,
    error: dialogAfter.needsApproval ? 'Question dialog remained visible after answering' : undefined
  };
}

module.exports = { answerQuestionDialog };