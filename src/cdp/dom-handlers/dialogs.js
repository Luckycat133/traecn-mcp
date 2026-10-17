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

const REVIEW_QUESTION_CARD_SELECTOR = '.ask-user-question-bottom-panel, .ask-user-question-card-container, [class*="ask-user-question-card"]';
const NATIVE_REVIEW_OPTION_SELECTOR = '[class*="optionItem-"]:not([class*="optionItemOther-"])';
const NATIVE_COMMAND_PANEL_SELECTOR = '.panel-Byyvlz';
const NATIVE_COMMAND_PANEL = Symbol('nativeCommandPanel');

function nativeApprovalVisible(node, allowOffscreen = false) {
  if (!node || node.offsetParent === null) return false;
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0
    || (!allowOffscreen && (rect.bottom < 0 || rect.top > window.innerHeight))) return false; // eslint-disable-line no-undef -- Serialized page-side helper.
  for (let current = node; current; current = current.parentElement) {
    const style = getComputedStyle(current); // eslint-disable-line no-undef -- Serialized page-side helper.
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function inspectNativeCommandPanel(panel) {
  if (!nativeApprovalVisible(panel)
    || panel.closest('.notifications-toasts, .notifications-list-container, .notification-toast, .notification-toast-container, .notification-list-item, pre, code, .markdown-renderer')) return null;
  const title = panel.querySelector('.titleText-riH9wY');
  const warning = panel.querySelector('.permissionDesc-r9VNEE');
  const block = panel.querySelector('.commandBlock-FOjqqZ');
  const commandNode = block?.querySelector('.commandText-rHrSgO');
  if (!nativeApprovalVisible(title) || !nativeApprovalVisible(warning) || !nativeApprovalVisible(commandNode)) return null;
  const question = String(title.textContent || '').trim();
  const command = String(commandNode.textContent || '').trim();
  if (!/^是否允许运行这个命令[？?]$/.test(question)
    || !/检测到高风险命令/.test(warning.textContent || '') || !command) return null;
  const actions = Array.from(panel.querySelectorAll('.confirmActionItem-R9PwIE')).flatMap(node => {
    const labelNode = node.querySelector('.confirmActionLabel-FBOWQC');
    const label = nativeApprovalVisible(labelNode) ? String(labelNode.textContent || '').trim() : '';
    return nativeApprovalVisible(node) && /^(运行|跳过)$/.test(label) ? [{ node, label }] : [];
  });
  if (!actions.some(item => item.label === '运行') || !actions.some(item => item.label === '跳过')
    || actions.some(item => item.node.getAttribute('aria-busy') === 'true')) return null;
  const enabled = actions.filter(item => !item.node.disabled && item.node.getAttribute('disabled') === null
    && item.node.getAttribute('aria-disabled') !== 'true' && item.node.getAttribute('data-disabled') !== 'true');
  return enabled.length ? { question, command, actions: enabled } : null;
}

function isReviewScopeQuestionCard(card) {
  if (card.matches('.ask-user-question-bottom-panel')) {
    const title = card.querySelector('[class*="title-"]');
    return /What would you like me to review\?|Review Scope/i.test(title?.textContent || '');
  }
  return /What would you like me to review\?|Review Scope|Latest commit changes|Uncommitted changes|Specific files or folder/i.test(card.textContent || '');
}

function reviewQuestionButtonText(node) {
  function textWithoutKeyboardHint(current) {
    if (!current || current.tagName === 'KBD') return '';
    if (current.nodeType === 3) return current.textContent || '';
    const children = Array.from(current.childNodes || []);
    return children.length ? children.map(textWithoutKeyboardHint).join('') : (current.innerText || current.textContent || '');
  }
  return textWithoutKeyboardHint(node).replace(/\s+/g, ' ').trim();
}

function _assessCommandApproval(command) {
  const value = String(command || '').replace(/\s+/g, ' ').trim();
  if (!value) {
    return { decision: 'agent_review', risk: 'unknown', reasonCodes: ['unknown_command'] };
  }

  const riskRules = [
    {
      pattern: /\bgit\s+(?:push|commit|reset|checkout|switch|clean|restore|rebase|merge|cherry-pick|tag)\b/i,
      code: 'git_write_or_remote'
    },
    {
      pattern: /\b(?:curl|wget|scp|sftp|ssh|nc|netcat|rsync)\b/i,
      code: 'network_or_data_transfer'
    },
    {
      pattern: /\b(?:rm|mv|cp|install|unlink|truncate|dd)\b|\b(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|publish)\b/i,
      code: 'filesystem_or_package_write'
    },
    {
      pattern: /\b(?:sudo|su|chmod|chown|launchctl|kill|pkill|killall)\b/i,
      code: 'privilege_or_process_control'
    },
    {
      pattern: /\bfind\b[^;&|]*(?:-delete|-exec(?:dir)?|-ok(?:dir)?|-fprint|-fprintf|-fls)\b/i,
      code: 'filesystem_write_via_find'
    },
    {
      pattern: /\bsed\b[^;&|]*(?:^|[;'"])[^;'"]*(?:w\s+\S+|e\s+\S+)/i,
      code: 'filesystem_or_command_via_sed'
    },
    {
      pattern: /\b(?:npm|pnpm|yarn)\s+(?:test|run)\b|\bnode\s+--test\b/i,
      code: 'project_script_side_effects_unknown'
    },
    {
      pattern: /\brg\b[^;&|]*--pre(?:-glob)?\b|\bgit\s+(?:diff|show|log)\b[^;&|]*(?:--ext-diff|--textconv)\b/i,
      code: 'read_command_external_hook'
    }
  ];
  for (const rule of riskRules) {
    if (rule.pattern.test(value)) {
      return { decision: 'agent_review', risk: 'high', reasonCodes: [rule.code] };
    }
  }

  const withoutDevNull = value.replace(/\s*\d?>\s*\/dev\/null\b/g, '');
  if (/(^|[^<])>{1,2}(?!\s*\/dev\/null)|<<|\x60|\$\(/.test(withoutDevNull)) {
    return { decision: 'agent_review', risk: 'high', reasonCodes: ['shell_write_or_expansion'] };
  }

  const segments = withoutDevNull
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map(segment => segment.trim())
    .filter(Boolean);
  const readOnlySegmentPatterns = [
    /^cd\s+\S+(?:\s+\S+)*$/i,
    /^(?:pwd|ls|rg|grep|cat|head|tail|wc|stat)\b/i,
    /^git\s+(?:status|diff|log|show|branch|rev-parse|ls-files)\b/i,
    /^echo\b/i
  ];
  if (segments.length > 0 && segments.every(segment => readOnlySegmentPatterns.some(pattern => pattern.test(segment)))) {
    return { decision: 'agent_review', risk: 'low', reasonCodes: ['explicit_command_review_required'] };
  }

  return { decision: 'agent_review', risk: 'unknown', reasonCodes: ['unknown_command'] };
}

async function checkForApprovalDialog(driver) {
  try {
    const result = await driver.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var reviewButtonText = ${reviewQuestionButtonText.toString()};
          var isReviewScopeQuestionCard = ${isReviewScopeQuestionCard.toString()};
          var notificationSelector = '.notifications-toasts, .notifications-list-container, .notification-toast, .notification-toast-container, .notification-list-item';
          var nativeApprovalVisible = ${nativeApprovalVisible.toString()};
          var inspectNativeCommandPanel = ${inspectNativeCommandPanel.toString()};
          var nativePanels = document.querySelectorAll(${safeJsValue(NATIVE_COMMAND_PANEL_SELECTOR)});
          for (var np = 0; np < nativePanels.length; np++) {
            var nativePanel = inspectNativeCommandPanel(nativePanels[np]);
            if (nativePanel) return {
              found: true, title: nativePanel.question,
              command: nativePanel.command, buttons: nativePanel.actions.map(function(item) { return item.label; }),
              type: 'command_execution', isCommandExec: true, canAutoApprove: false, nativePanel: true
            };
          }
          function isApplicationNotification(el) {
            return !!el && (!!el.closest(notificationSelector)
              || (el.matches('.monaco-list-row') && !!el.querySelector('.notification-list-item')));
          }
          var indicatorSelectors = [
            '[role="dialog"]',
            '[role="alertdialog"]',
            '.modal',
            '.modal-overlay',
            '[class*="dialog"]',
            'button[aria-label*="\\u6279\\u51c6"]',
            'button[aria-label*="Approve"]',
            'button[aria-label*="\\u5141\\u8bb8"]',
            'button[aria-label*="Allow"]',
            'button[class*="approve"]',
            '.ipc-overlay',
            '.monaco-dialog',
            '[aria-label*="\\u9700\\u8981\\u786e\\u8ba4"]'
          ];
          var indicators = [];
          indicatorSelectors.forEach(function(selector) {
            document.querySelectorAll(selector).forEach(function(el) {
              if (!isApplicationNotification(el)
                && !el.closest('pre, code, .markdown-renderer, ' + ${safeJsValue(NATIVE_COMMAND_PANEL_SELECTOR)})
                && !el.querySelector(${safeJsValue(NATIVE_COMMAND_PANEL_SELECTOR)})
                && !indicators.includes(el)) indicators.push(el);
            });
          });

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

          var visibleReviewCards = document.querySelectorAll(${safeJsValue(REVIEW_QUESTION_CARD_SELECTOR)});
          for (var vc = 0; vc < visibleReviewCards.length; vc++) {
            var visibleCard = visibleReviewCards[vc];
            if (!visibleCard || visibleCard.offsetParent === null || isApplicationNotification(visibleCard)) continue;
            var visibleRect = visibleCard.getBoundingClientRect();
            if (visibleRect.width < 100 || visibleRect.height < 40) continue;
            if (visibleRect.bottom < 0 || visibleRect.top > window.innerHeight) continue;
            var visibleCardText = visibleCard.textContent || '';
            var nativeBottomPanel = visibleCard.matches('.ask-user-question-bottom-panel');
            var isReviewScopeCard = isReviewScopeQuestionCard(visibleCard);
            var isPendingQuestion = /\\u6b63\\u5728\\u7b49\\u5f85\\u4f60\\u7684\\u64cd\\u4f5c|Cancel|Next|\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a/i.test(visibleCardText);
            if (!isReviewScopeCard) continue;
            var visibleReviewButtons = [];
            var visibleOptions = [];
            var visibleReviewButtonNodes = visibleCard.querySelectorAll(${safeJsValue(`${DIALOG_BUTTON_SELECTOR}, [class*="button"], [class*="btn"], div, span`)});
            visibleReviewButtonNodes.forEach(function(b) {
              if (!b || b.offsetParent === null) return;
              var text = reviewButtonText(b);
              if (!text) return;
              if (/^(\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|\\u63d0\\u4ea4|Cancel|Next|Submit)$/i.test(text) && !visibleReviewButtons.includes(text)) {
                if (/^(\\u63d0\\u4ea4|Submit)$/i.test(text) && !b.closest(${safeJsValue(`${DIALOG_BUTTON_SELECTOR}, [class*="button"], [class*="btn"]`)})) return;
                visibleReviewButtons.push(text);
              }
            });
            if (!isPendingQuestion && !visibleReviewButtons.some(function(text) { return /^(\\u63d0\\u4ea4|Submit)$/i.test(text); })) continue;
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
            var optionNodes = visibleCard.querySelectorAll(nativeBottomPanel
              ? ${safeJsValue(NATIVE_REVIEW_OPTION_SELECTOR)}
              : '.ask-user-single-choice-item, .icd-checkbox-item-container, [class*="single-choice"], [class*="checkbox-item"], [role="radio"], [role="option"]');
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
              var nativeLabel = nativeBottomPanel ? option.querySelector('[class*="optionLabel-"]') : null;
              if (nativeLabel) label = (nativeLabel.innerText || nativeLabel.textContent || '').trim();
              var nativeDescription = nativeBottomPanel ? option.querySelector('[class*="optionDescription-"]') : null;
              var description = nativeDescription
                ? (nativeDescription.innerText || nativeDescription.textContent || '').trim()
                : text.replace(label, '').trim();
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
            if (!nativeBottomPanel && parsedOptions.length >= 2) {
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
          var legacyExcludedSelector = notificationSelector + ', pre, code, .markdown-renderer, ' + ${safeJsValue(NATIVE_COMMAND_PANEL_SELECTOR)};
          if (document.querySelector(legacyExcludedSelector)) {
            // Known panels and quoted/notification content must not become a
            // pending approval through the legacy whole-page text fallback.
            var textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
              acceptNode: function(node) {
                return isApplicationNotification(node.parentElement) || node.parentElement.closest(legacyExcludedSelector)
                  ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
              }
            });
            bodyText = '';
            var textNode;
            while ((textNode = textWalker.nextNode())) bodyText += textNode.textContent;
          }
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
          var pendingReviewCard = Array.from(document.querySelectorAll('.ask-user-question-card-status-pending'))
            .some(function(card) { return !isApplicationNotification(card); });
          if (reviewScopeHits >= 2 && pendingReviewCard) {
            var reviewButtons = [];
            var reviewButtonNodes = document.querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)});
            reviewButtonNodes.forEach(function(b) {
              if (!b || b.offsetParent === null || isApplicationNotification(b)) return;
              var text = (b.innerText || b.textContent || '').trim();
              if (!text) return;
              if (/^(\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|\\u63d0\\u4ea4|Cancel|Next|Submit)$/i.test(text) && !reviewButtons.includes(text)) {
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

          var inlineCommandButtons = document.querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)});
          for (var ic = 0; ic < inlineCommandButtons.length; ic++) {
            var runButton = inlineCommandButtons[ic];
            if (!runButton || runButton.offsetParent === null || isApplicationNotification(runButton)) continue;
            var runText = (runButton.innerText || runButton.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!/^(\\u8fd0\\u884c|Run)$/i.test(runText)) continue;
            var commandCard = runButton;
            var commandText = '';
            for (var up = 0; up < 8 && commandCard; up++) {
              commandText = (commandCard.innerText || commandCard.textContent || '').replace(/\\s+/g, ' ').trim();
              var isActiveCommandCard = commandCard.matches('.icd-run-command-card-v2.icd-card-container-active, [class*="run-command-card"][class*="active"]');
              if (isActiveCommandCard
                && /\\u547d\\u4ee4\\u5728\\u6c99\\u7bb1\\u4e2d\\u8fd0\\u884c\\u4e0d\\u901a\\u8fc7|\\u68c0\\u6d4b\\u5230\\u9ad8\\u98ce\\u9669\\u547d\\u4ee4|outside (?:the )?sandbox|run .*outside/i.test(commandText)) {
                var commandButtons = [];
                var commandInput = commandCard.querySelector('textarea, input[type="text"], [contenteditable="true"]');
                var commandValue = commandInput
                  ? (commandInput.value || commandInput.innerText || commandInput.textContent || '').trim()
                  : '';
                commandCard.querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)}).forEach(function(button) {
                  if (!button || button.offsetParent === null) return;
                  var label = (button.innerText || button.textContent || '').replace(/\\s+/g, ' ').trim();
                  if (label && !commandButtons.includes(label)) commandButtons.push(label);
                });
                return {
                  found: true,
                  title: commandText.substring(0, 200),
                  buttons: commandButtons.slice(0, 5),
                  type: 'command_execution',
                  isCommandExec: true,
                  canAutoApprove: false,
                  command: commandValue
                };
              }
              commandCard = commandCard.parentElement;
            }
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
      const commandAssessment = dialog.isCommandExec
        ? _assessCommandApproval(dialog.command)
        : null;
      const snapshot = {
        needsApproval: true,
        question: dialog.title || 'Trae\\u9700\\u8981\\u60a8\\u786e\\u8ba4',
        dialogType: dialog.type || 'approval',
        buttons: dialog.buttons || [],
        options: dialog.options || [],
        isCommandExec: dialog.isCommandExec || false,
        canAutoApprove: dialog.isCommandExec ? false : dialog.canAutoApprove === true,
        command: dialog.command ? (dialog.nativePanel ? String(dialog.command) : String(dialog.command).slice(0, 1200)) : null,
        approvalDecision: commandAssessment?.decision || null,
        commandRisk: commandAssessment?.risk || null,
        riskReasons: commandAssessment?.reasonCodes || [],
      };
      // Keep the observed DOM kind private; clients retain command_execution.
      if (dialog.nativePanel) Object.defineProperty(snapshot, NATIVE_COMMAND_PANEL, { value: true });
      return snapshot;
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

async function approveDialog(driver, action, options = {}) {
  try {
    const dialog = await driver.checkForApprovalDialog();
    if (dialog.transient) {
      return { success: false, action, error: dialog.error, transient: true };
    }
    if (!dialog.needsApproval) {
      return { success: false, action, error: 'No dialog found to approve' };
    }

    const targetLabels = _getButtonLabelsForAction(action);
    const nativePanel = dialog[NATIVE_COMMAND_PANEL] === true;
    const requestedCommand = options.expectedCommand === undefined ? dialog.command : options.expectedCommand;
    const expectedCommand = typeof requestedCommand === 'string' ? requestedCommand.trim() : requestedCommand;
    if (options.expectedCommand !== undefined
      && (typeof expectedCommand !== 'string' || !expectedCommand
        || typeof dialog.command !== 'string' || dialog.command.trim() !== expectedCommand)) {
      return { success: false, action, error: 'Current command approval no longer matches the authorized command' };
    }
    if (nativePanel && (typeof expectedCommand !== 'string' || !expectedCommand)) {
      return { success: false, action, error: 'Native command approval requires the complete expected command' };
    }

    const result = await driver.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var reviewButtonText = ${reviewQuestionButtonText.toString()};
          var targetLabels = ${JSON.stringify(targetLabels)};
          var action = ${JSON.stringify(action)};
          if (${nativePanel}) {
            var nativeApprovalVisible = ${nativeApprovalVisible.toString()};
            var inspectNativeCommandPanel = ${inspectNativeCommandPanel.toString()};
            var expectedCommand = ${safeJsValue(expectedCommand)};
            var pendingPanels = Array.from(document.querySelectorAll(${safeJsValue(NATIVE_COMMAND_PANEL_SELECTOR)}))
              .map(inspectNativeCommandPanel).filter(Boolean);
            if (pendingPanels.length !== 1 || pendingPanels[0].command !== expectedCommand) {
              return { clicked: false, error: 'Native command approval changed or is no longer pending' };
            }
            var target = pendingPanels[0].actions.find(function(item) {
              return targetLabels.some(function(label) { return label.toLowerCase() === item.label.toLowerCase(); });
            });
            if (!target) return { clicked: false, error: 'No enabled native approval action found' };
            target.node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
            return { clicked: true, buttonText: target.label };
          }
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

          var reviewCards = document.querySelectorAll(${safeJsValue(REVIEW_QUESTION_CARD_SELECTOR)});
          for (var rc = 0; rc < reviewCards.length; rc++) {
            var card = reviewCards[rc];
            if (!card || card.offsetParent === null) continue;
            var cardText = card.textContent || '';
            if (!/Review Scope|What would you like me to review\\?|\\u6b63\\u5728\\u7b49\\u5f85\\u4f60\\u7684\\u64cd\\u4f5c/i.test(cardText)) continue;
            var cardNodes = card.querySelectorAll('button, [role="button"], [class*="button"], [class*="btn"], div, span');
            for (var cn = 0; cn < cardNodes.length; cn++) {
              var node = cardNodes[cn];
              if (!node || node.offsetParent === null) continue;
              var nodeText = reviewButtonText(node);
              if (!/^(\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|Cancel|Next)$/i.test(nodeText)) continue;
              var clickable = node.closest('button, a[role="button"], [role="button"], .monaco-button, .monaco-text-button, [class*="button"], [class*="btn"]') || node;
              var nodeRect = clickable.getBoundingClientRect();
              if (nodeRect.width < 12 || nodeRect.height < 12) continue;
              if (!buttonsToSearch.includes(clickable)) buttonsToSearch.push(clickable);
            }
          }

          var inlineRunButtons = document.querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)});
          for (var ir = 0; ir < inlineRunButtons.length; ir++) {
            var inlineButton = inlineRunButtons[ir];
            if (!inlineButton || inlineButton.offsetParent === null) continue;
            var inlineText = (inlineButton.innerText || inlineButton.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!/^(\\u8fd0\\u884c|Run)$/i.test(inlineText)) continue;
            var inlineCard = inlineButton;
            for (var iu = 0; iu < 8 && inlineCard; iu++) {
              var inlineCardText = (inlineCard.innerText || inlineCard.textContent || '').replace(/\\s+/g, ' ').trim();
              var isActiveInlineCard = inlineCard.matches('.icd-run-command-card-v2.icd-card-container-active, [class*="run-command-card"][class*="active"]');
              if (isActiveInlineCard
                && /\\u547d\\u4ee4\\u5728\\u6c99\\u7bb1\\u4e2d\\u8fd0\\u884c\\u4e0d\\u901a\\u8fc7|\\u68c0\\u6d4b\\u5230\\u9ad8\\u98ce\\u9669\\u547d\\u4ee4|outside (?:the )?sandbox|run .*outside/i.test(inlineCardText)) {
                var inlineCardButtons = inlineCard.querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)});
                for (var ib = 0; ib < inlineCardButtons.length; ib++) {
                  var inlineCardButton = inlineCardButtons[ib];
                  if (!inlineCardButton || inlineCardButton.offsetParent === null) continue;
                  var inlineCardButtonText = (inlineCardButton.innerText || inlineCardButton.textContent || '').trim();
                  var inlineCardButtonRect = inlineCardButton.getBoundingClientRect();
                  if (!inlineCardButtonText || inlineCardButtonRect.width < 12 || inlineCardButtonRect.height < 12) continue;
                  if (!buttonsToSearch.includes(inlineCardButton)) buttonsToSearch.push(inlineCardButton);
                }
                break;
              }
              inlineCard = inlineCard.parentElement;
            }
          }

          // First pass: exact match
          for (var b = 0; b < buttonsToSearch.length; b++) {
            var btn = buttonsToSearch[b];
            if (btn.offsetParent === null) continue;
            var text = (btn.closest(${safeJsValue(REVIEW_QUESTION_CARD_SELECTOR)})
              ? reviewButtonText(btn) : (btn.innerText || btn.textContent || '').trim()).toLowerCase();
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
      if (nativePanel) {
        const remaining = await driver.client.send('Runtime.evaluate', {
          expression: `(function() {
            var nativeApprovalVisible = ${nativeApprovalVisible.toString()};
            return Array.from(document.querySelectorAll(${safeJsValue(NATIVE_COMMAND_PANEL_SELECTOR)})).some(function(panel) {
              var command = panel.querySelector('.commandText-rHrSgO');
              return nativeApprovalVisible(panel, true) && command
                && !panel.closest('.notifications-toasts, .notifications-list-container, .notification-toast, .notification-toast-container, .notification-list-item, pre, code, .markdown-renderer')
                && String(command.textContent || '').trim() === ${safeJsValue(expectedCommand)};
            });
          })()`,
          returnByValue: true
        });
        if (remaining.result?.value !== false) {
          return { success: false, action, buttonClicked: clickResult.buttonText, error: 'Native command approval panel disappearance could not be confirmed' };
        }
      }
      const dialogAfter = await driver.checkForApprovalDialog();
      if (dialogAfter.transient || dialogAfter.needsApproval !== false) {
        return {
          success: false,
          action,
          buttonClicked: clickResult.buttonText,
          error: dialogAfter.error || 'Dialog remained visible after click'
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
      return ['是，我信任此作者', '信任此作者', '信任', 'Trust', '信任此文件夹', '信任文件夹', '打开', '运行', 'Run'];
    case 'allow':
      return ['允许', 'Allow', '批准', 'Approve', '允许此操作'];
    case 'confirm':
      return ['确认', 'Confirm', '确定', 'OK', '确认执行', '运行'];
    case 'approve':
      return ['是，我信任此作者', '批准', 'Approve', '允许', 'Allow', '确认', 'Confirm', '信任', 'Trust', '运行', 'Run'];
    case 'deny':
      return ['跳过', 'Skip', '拒绝', 'Deny', '不允许', '禁止', '拒绝此操作'];
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
  REVIEW_QUESTION_CARD_SELECTOR,
  NATIVE_REVIEW_OPTION_SELECTOR,
  isReviewScopeQuestionCard,
  reviewQuestionButtonText,
  checkForApprovalDialog,
  approveDialog,
  _assessCommandApproval,
  _getButtonLabelsForAction,
  checkReadiness
};
