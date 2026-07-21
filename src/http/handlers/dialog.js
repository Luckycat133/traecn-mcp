'use strict';

const { parseBody } = require('../request-gate');
const { rejectBadRequest, requireDriverCapability } = require('./helpers');

/**
 * dialog handlers.
 *
 * Moved verbatim from src/http/gateway.js. Each handler is now an
 * exported function with signature `function handleX(req, res, ctx, ...pathParams)`
 * taking the gateway instance as `ctx`. Behavior is preserved 1:1.
 *
 * The Gateway retains thin delegating shims (e.g. `_handleCreateSession`) so
 * existing gateway.test.js cases that call `gateway._handleCreateSession(...)`
 * continue to work unchanged.
 */

const ROUTES = [
    {
      "method": "POST",
      "path": "/api/dialog/approve",
      "handler": "_handleDialogApprove",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "POST",
      "path": "/api/dialog/dismiss",
      "handler": "_handleDialogDismiss",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "GET",
      "path": "/api/dialog/status",
      "handler": "_handleDialogStatus",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    }
  ];

async function handleDialogApprove(req, res, ctx) {
  const body = await parseBody(req);
  const action = (body.action || 'auto').toLowerCase();

  const confirmationFailure = ctx._confirmationFailure(req, body, 'approve_dialog', { action });
  if (confirmationFailure) return ctx._json(req, res, confirmationFailure, 409);

  await ctx._ensureConnection();
  const currentDialog = await ctx.driver.checkForApprovalDialog();
  const currentRestricted = currentDialog.needsApproval ? null : await ctx.driver.checkRestrictedMode();

  if (action === 'trust' && currentRestricted?.restricted) {
    const restrictedResult = await ctx.driver.clickRestrictedModeTrust();
    return ctx._json(req, res, {
      success: restrictedResult.success,
      action,
      dialogType: 'restricted_mode_banner',
      buttonClicked: restrictedResult.buttonText || restrictedResult.manageButtonText,
      error: restrictedResult.error || restrictedResult.reason
    });
  }

  if (action === 'auto') {
    // Auto-detect the best action based on dialog type
    const dialog = currentDialog;
    if (!dialog.needsApproval) {
      if (currentRestricted?.restricted) {
        const restrictedResult = await ctx.driver.clickRestrictedModeTrust();
        return ctx._json(req, res, {
          success: restrictedResult.success,
          action: 'trust',
          dialogType: 'restricted_mode_banner',
          buttonClicked: restrictedResult.buttonText || restrictedResult.manageButtonText,
          error: restrictedResult.error || restrictedResult.reason
        });
      }
      return ctx._json(req, res, { success: false, error: 'No dialog found to approve' });
    }
    const autoAction = dialog.canAutoApprove ? 'trust' : 'allow';
    const result = await ctx.driver.approveDialog(autoAction);
    return ctx._json(req, res, {
      success: result.success,
      action: autoAction,
      dialogType: dialog.dialogType,
      buttonClicked: result.buttonClicked,
      error: result.error
    });
  }

  if (action === 'answer') {
    const answer = body.answer || body.option || body.value;
    if (!answer) {
      return rejectBadRequest(req, res, ctx, 'answer is required for dialog answer action');
    }
    if (!requireDriverCapability(req, res, ctx, 'answerQuestionDialog', 'Driver does not support question dialog answers')) {
      return;
    }
    const result = await ctx.driver.answerQuestionDialog(answer);
    const resumedTaskIds = result.success
      ? ctx._resumeApprovalRequiredTasksAfterDialogAnswer(answer, result)
      : [];
    return ctx._json(req, res, {
      success: result.success,
      action,
      answer,
      resumedTaskIds,
      selectedOption: result.selectedOption,
      buttonClicked: result.buttonClicked,
      error: result.error
    });
  }

  if (!['trust', 'allow', 'confirm', 'approve', 'deny', 'cancel', 'dismiss'].includes(action)) {
    return ctx._json(req, res, { error: 'Invalid action: ' + action }, 400);
  }

  let result = await ctx.driver.approveDialog(action);
  if (!result.success && action === 'trust') {
    const restrictedResult = await ctx.driver.clickRestrictedModeTrust();
    if (restrictedResult.success) {
      result = {
        success: true,
        action,
        buttonClicked: restrictedResult.buttonText || 'Manage -> Trust'
      };
    }
  }
  ctx._json(req, res, {
    success: result.success,
    action,
    buttonClicked: result.buttonClicked,
    error: result.error
  });
}
async function handleDialogDismiss(req, res, ctx) {
  const body = await parseBody(req);
  const confirmationFailure = ctx._confirmationFailure(req, body, 'dismiss_dialog', {});
  if (confirmationFailure) return ctx._json(req, res, confirmationFailure, 409);

  await ctx._ensureConnection();
  const result = await ctx.driver.approveDialog('dismiss');
  ctx._json(req, res, {
    success: result.success,
    action: 'dismiss',
    buttonClicked: result.buttonClicked,
    error: result.error
  });
}
async function handleDialogStatus(req, res, ctx) {
  await ctx._ensureConnection();
  let dialog = await ctx.driver.checkForApprovalDialog();
  if (!dialog.needsApproval) {
    const restricted = await ctx.driver.checkRestrictedMode();
    if (restricted?.restricted) {
      dialog = {
        needsApproval: true,
        dialogType: 'restricted_mode_banner',
        question: restricted.title || '受限模式已启用',
        buttons: restricted.manageButtonFound ? ['管理'] : [],
        canAutoApprove: restricted.trustButtonFound === true || restricted.manageButtonFound === true
      };
    }
  }
  ctx._json(req, res, {
    hasDialog: dialog.needsApproval,
    dialogType: dialog.dialogType || null,
    question: dialog.question || null,
    buttons: dialog.buttons || [],
    options: dialog.options || [],
    answerAction: dialog.dialogType === 'review_scope_question'
      ? { endpoint: '/api/dialog/approve', method: 'POST', body: { action: 'answer', answer: '<option label>' } }
      : null,
    canAutoApprove: dialog.canAutoApprove || false
  });
}

module.exports = { ROUTES, handleDialogApprove, handleDialogDismiss, handleDialogStatus };