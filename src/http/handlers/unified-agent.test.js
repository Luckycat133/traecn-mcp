'use strict';

const assert = require('assert');
const { Readable } = require('stream');
const {
  handleSubmit,
  handleListModels,
  handleListConversations,
  handleManageConversation,
  handleResolveInteraction,
  conversationId,
  parseConversationId,
  stableConversationTitle
} = require('./unified-agent');
const { generateOpenAPISpec } = require('../openapi');
const { Gateway } = require('../gateway');
const { errorToHttpStatus, errorToBody } = require('../error-mapping');

function request(body, headers = {}) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.headers = headers;
  return stream;
}

async function verifyModelListingSerialization(ctx) {
  const order = [];
  let finishSend;
  let finishListing;
  const sending = new Promise(resolve => { finishSend = resolve; });
  const listing = new Promise(resolve => { finishListing = resolve; });
  const catalog = { current: 'GLM-5.2', models: ['GLM-5.2', 'Seed-Code'] };
  const lockedCtx = {
    ...ctx,
    _withUiActionLock: Gateway.prototype._withUiActionLock,
    driver: {
      ...ctx.driver,
      listModels: async () => {
        order.push('model-picker-open');
        await listing;
        order.push('model-picker-closed');
        return catalog;
      }
    }
  };
  const sendRun = lockedCtx._withUiActionLock(async () => {
    order.push('sender-start');
    await sending;
    order.push('sender-finished');
  });
  await new Promise(setImmediate);
  const res = {};
  const listRun = handleListModels(request({}), res, lockedCtx);
  await new Promise(setImmediate);
  const listingWaitedForSend = !order.includes('model-picker-open');
  finishSend();
  await sendRun;
  await new Promise(setImmediate);
  const nextRun = lockedCtx._withUiActionLock(async () => { order.push('next-ui-action'); });
  await new Promise(setImmediate);
  const nextActionWaitedForPickerClose = !order.includes('next-ui-action');
  finishListing();
  await Promise.all([listRun, nextRun]);
  assert.strictEqual(listingWaitedForSend, true, 'model listing must not move focus while a task is being sent');
  assert.strictEqual(nextActionWaitedForPickerClose, true, 'model picker must close before the next UI action');
  assert.deepStrictEqual(order, ['sender-start', 'sender-finished', 'model-picker-open', 'model-picker-closed', 'next-ui-action']);
  assert.deepStrictEqual(res.body, catalog);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(lockedCtx.uiActionInFlight, 0);

  const failure = new Error('offline model picker failure');
  lockedCtx.driver.listModels = async () => { throw failure; };
  await assert.rejects(() => handleListModels(request({}), {}, lockedCtx), error => error === failure);
  await lockedCtx._withUiActionLock(async () => { order.push('after-picker-failure'); });
  assert.strictEqual(order.at(-1), 'after-picker-failure');
  assert.strictEqual(lockedCtx.uiActionInFlight, 0);
}

async function verifyModelListingAfterShutdown(ctx) {
  for (const state of [
    { shutdown: true, clearDriver: true },
    { shutdown: true, clearDriver: false },
    { shutdown: false, clearDriver: true }
  ]) {
    let releaseSend;
    let modelCalls = 0;
    const sending = new Promise(resolve => { releaseSend = resolve; });
    const lockedCtx = {
      ...ctx,
      _withUiActionLock: Gateway.prototype._withUiActionLock,
      driver: { listModels: async () => { modelCalls++; return { models: [] }; } }
    };
    const sendRun = lockedCtx._withUiActionLock(async () => sending);
    await new Promise(setImmediate);
    const listRun = handleListModels(request({}), {}, lockedCtx)
      .then(result => ({ result }), error => ({ error }));
    await new Promise(setImmediate);
    assert.strictEqual(modelCalls, 0, 'model listing must still be queued behind the sender');
    if (state.shutdown) lockedCtx._shutdownInProgress = Promise.resolve();
    if (state.clearDriver) lockedCtx.driver = null;
    releaseSend();
    await sendRun;
    const outcome = await listRun;
    assert.ok(outcome.error, 'a disconnected queued model listing must fail without opening the picker');
    assert.strictEqual(outcome.error.name, 'TraeCNAutomationError');
    assert.strictEqual(outcome.error.code, 'CDP_DISCONNECTED');
    assert.strictEqual(errorToHttpStatus(outcome.error), 503);
    assert.strictEqual(errorToBody(outcome.error).code, 'CDP_DISCONNECTED');
    assert.strictEqual(modelCalls, 0, 'a shutting down or missing driver must not receive a late UI call');
    assert.strictEqual(lockedCtx.uiActionInFlight, 0);
    await lockedCtx._withUiActionLock(async () => {});
    assert.strictEqual(lockedCtx.uiActionInFlight, 0, 'the queued failure must release the UI lock');
  }

  const unsupported = {};
  await handleListModels(request({}), unsupported, { ...ctx, driver: {} });
  assert.strictEqual(unsupported.status, 501);
  assert.match(unsupported.body.error, /model listing is not supported/);
}

(async () => {
  const calls = [];
  let duplicatePersistCalls = 0;
  const idempotencyWrites = [];
  const auditEntries = [];
  const task = {
    taskId: 'task_gateway_1',
    status: 'queued',
    followupTasks: []
  };
  const ctx = {
    _json: (_req, res, body, status = 200) => {
      res.body = body;
      res.status = status;
      return res;
    },
    _ensureConnection: async () => calls.push('connect'),
    _withUiActionLock: operation => operation(),
    _ensureRequestedWorkspace: async workspace => calls.push(['workspace', workspace]),
    _createQueuedTask: body => {
      calls.push(['queue', body]);
      return task;
    },
    _ensureBackgroundPolling: () => calls.push('poll'),
    _storeIdempotency: (key, response) => idempotencyWrites.push([key, response]),
    _fingerprintTaskRequest: () => 'submit-fingerprint-1',
    _resolveTaskIdempotency: () => null,
    _resumeApprovalRequiredTasksAfterInteraction: (action, dialog, result) => {
      calls.push(['resume-interaction', action, dialog.command, result.success]);
      return ['task_gateway_1'];
    },
    _syncTaskHistoryMirror: () => {},
    _persistActiveQueue: () => { duplicatePersistCalls++; },
    driver: {
      detectMode: async () => ({ mode: 'solo' }),
      listModels: async () => ({ current: 'GLM-5.2', models: ['GLM-5.2', 'DeepSeek-V3.2'] }),
      listSoloChats: async () => ({
        mode: 'solo',
        chats: [
          { index: 2, title: 'Review API', active: true },
          { index: 3, title: 'Old review', active: false }
        ],
        count: 2
      }),
      deleteSoloChats: async input => {
        calls.push(['delete', input]);
        return { deleted: 1 };
      },
      checkForApprovalDialog: async () => ({
        needsApproval: true,
        isCommandExec: true,
        approvalDecision: 'agent_review',
        command: 'git push origin main',
        commandRisk: 'high',
        riskReasons: ['git_write_or_remote']
      }),
      approveDialog: async action => ({ success: true, action })
    },
    auditLogger: {
      log: entry => auditEntries.push(entry)
    }
  };

  const activeSession = '6ac05d3c1407a4b5492e7496';
  const otherSession = '6ac05c911407a4b5492e7476';
  const nativeId = `solo-session:${activeSession}`;
  assert.strictEqual(conversationId({ sessionId: activeSession, title: 'Review API 进行中 09:40' }), nativeId);
  assert.strictEqual(conversationId({ sessionId: activeSession, title: 'Review API 任务中断 09:41' }), nativeId);
  assert.deepStrictEqual(parseConversationId(nativeId), { sessionId: activeSession });
  assert.deepStrictEqual(parseConversationId('solo-session:opaque%2Fsession'), { sessionId: 'opaque/session' });
  assert.strictEqual(parseConversationId('solo-session:%XX'), null);
  assert.strictEqual(parseConversationId('solo-session:%00'), null);
  assert.deepStrictEqual(parseConversationId('solo:2'), { index: 2 });
  assert.deepStrictEqual(parseConversationId('solo:UmV2aWV3IEFQSQ'), { titleIncludes: 'Review API' });
  assert.strictEqual(stableConversationTitle('Review API 任务中断 09:41'), 'Review API');

  const nativeCalls = [];
  const nativeChats = [
    { index: 0, sessionId: activeSession, title: 'Same title', active: true },
    { index: 1, sessionId: otherSession, title: 'Same title', active: false }
  ];
  const nativeCtx = {
    ...ctx,
    _ensureConnection: async () => {},
    _ensureBackgroundPolling: () => {},
    _createQueuedTask: body => { nativeCalls.push(['queue', body]); return { taskId: 'native-owned-task' }; },
    driver: {
      ...ctx.driver,
      listSoloChats: async () => ({ mode: 'solo', chats: nativeChats }),
      switchSoloChat: async criteria => { nativeCalls.push(['select', criteria]); return { success: true }; },
      deleteSoloChats: async options => { nativeCalls.push(['delete', options]); return { deleted: 1 }; }
    }
  };
  const nativeListRes = {};
  await handleListConversations(request({}), nativeListRes, nativeCtx);
  assert.deepStrictEqual(nativeListRes.body.conversations.map(chat => chat.id), [nativeId, `solo-session:${otherSession}`]);
  await handleManageConversation(request({ action: 'select', conversationId: nativeId }), {}, nativeCtx);
  assert.deepStrictEqual(nativeCalls.at(-1), ['select', { sessionId: activeSession }]);

  await handleSubmit(request({ message: 'Continue the native conversation', conversationId: nativeId }), {}, nativeCtx);
  assert.deepStrictEqual(nativeCalls.at(-1)[1].soloChat, { sessionId: activeSession });
  await handleSubmit(request({ message: 'Bind the active native conversation' }), {}, nativeCtx);
  assert.deepStrictEqual(nativeCalls.at(-1)[1].soloChat, { sessionId: activeSession });

  const nativeDeleteRes = {};
  await handleManageConversation(request({ action: 'delete', conversationId: `solo-session:${otherSession}`,
    expectedTitle: 'Same title', acknowledgePermanentDeletion: true }), nativeDeleteRes, nativeCtx);
  assert.strictEqual(nativeDeleteRes.status, 200);
  assert.deepStrictEqual(nativeCalls.at(-1), ['delete', {
    candidates: [{ index: 1, sessionId: otherSession, title: 'Same title' }]
  }]);
  const missingNativeRes = {};
  const beforeMissing = nativeCalls.length;
  await handleManageConversation(request({ action: 'delete', conversationId: 'solo-session:missing-owned-session',
    expectedTitle: 'Same title', acknowledgePermanentDeletion: true }), missingNativeRes, nativeCtx);
  assert.strictEqual(missingNativeRes.status, 404);
  assert.strictEqual(nativeCalls.length, beforeMissing, 'missing native identity must never delete a title/index match');

  for (const createCase of ['draft', 'stale-active', 'native-created']) {
    let reads = 0;
    const createRes = {};
    const createCtx = { ...nativeCtx, driver: {
      ...nativeCtx.driver,
      newChat: async () => true,
      listSoloChats: async () => ({ mode: 'solo', chats: ++reads === 1 ? nativeChats :
        createCase === 'draft' ? nativeChats.map(chat => ({ ...chat, active: false })) :
          createCase === 'stale-active' ? nativeChats :
            [{ index: 0, sessionId: 'new-owned-session', title: 'New task', active: true }] })
    } };
    await handleManageConversation(request({ action: 'create' }), createRes, createCtx);
    assert.deepStrictEqual(createRes.body, {
      action: 'create', success: true, fresh: true,
      conversationId: createCase === 'native-created' ? 'solo-session:new-owned-session' : null,
      creationDeferred: createCase !== 'native-created'
    });
  }

  const res = {};
  await handleSubmit(request({
    message: 'Review the repository',
    model: 'GLM-5.2',
    mode: 'solo',
    workspace: '/tmp/repo',
    conversationId: 'solo:UmV2aWV3IEFQSQ',
    steps: ['Run tests']
  }, { 'idempotency-key': 'submit-review-1' }), res, ctx);

  assert.strictEqual(res.status, 202);
  assert.deepStrictEqual(res.body, { taskId: 'task_gateway_1', status: 'accepted' });
  assert.strictEqual(duplicatePersistCalls, 0, 'atomic task creation must own the first snapshot write');
  assert.deepStrictEqual(calls[0], 'connect');
  assert.deepStrictEqual(calls[1], ['workspace', '/tmp/repo']);
  assert.deepStrictEqual(calls[2], ['queue', {
    task: 'Review the repository',
    projectPath: '/tmp/repo',
    desiredModel: 'GLM-5.2',
    desiredMode: 'solo',
    soloChat: { titleIncludes: 'Review API' },
    idempotencyKey: 'submit-review-1',
    idempotencyFingerprint: 'submit-fingerprint-1',
    newConversation: false,
    followupTasks: [{ task: 'Run tests', autoContinue: true, reviewRequired: false }],
    autoContinue: true,
    reviewRequired: false,
    autoApproveDialog: 'auto'
  }]);
  assert.strictEqual(calls[3], 'poll');
  assert.deepStrictEqual(idempotencyWrites, []);

  const replayRes = {};
  let replayConnectionAttempted = false;
  await handleSubmit(request({
    message: 'Review the repository',
    model: 'GLM-5.2',
    mode: 'solo',
    workspace: '/tmp/repo',
    conversationId: 'solo:UmV2aWV3IEFQSQ',
    steps: ['Run tests']
  }, { 'idempotency-key': 'submit-review-1' }), replayRes, {
    ...ctx,
    _fingerprintTaskRequest: () => 'terminal-fingerprint-1',
    _resolveTaskIdempotency: (key, intent) => {
      assert.strictEqual(key, 'submit-review-1');
      assert.deepStrictEqual(intent, {
        task: 'Review the repository',
        projectPath: '/tmp/repo',
        desiredModel: 'GLM-5.2',
        desiredMode: 'solo',
        soloChat: { titleIncludes: 'Review API' },
        newConversation: false,
        followupTasks: [{ task: 'Run tests', autoContinue: true, reviewRequired: false }],
        autoContinue: true,
        reviewRequired: false,
        autoApproveDialog: 'auto'
      });
      return {
        data: {
          taskId: 'task_terminal_1',
          status: 'done',
          result: { text: 'original answer', stable: true },
          error: null
        },
        statusCode: 200
      };
    },
    _ensureConnection: async () => {
      replayConnectionAttempted = true;
      throw new Error('terminal replay must not connect to TraeCN');
    },
    _createQueuedTask: () => {
      throw new Error('terminal replay must not enqueue duplicate work');
    }
  });
  assert.strictEqual(replayConnectionAttempted, false);
  assert.strictEqual(replayRes.status, 200);
  assert.deepStrictEqual(replayRes.body, {
    taskId: 'task_terminal_1',
    status: 'done',
    result: { text: 'original answer', stable: true },
    error: null
  });

  // All requests pass the early replay check before asynchronous context
  // discovery finishes. Acceptance must still create only one task per key.
  for (const variant of ['same-intent', 'conflicting-intent', 'distinct-keys']) {
    let unblock;
    let allConnected;
    let connectedCount = 0;
    let acceptedCount = 0;
    const blocked = new Promise(resolve => { unblock = resolve; });
    const connected = new Promise(resolve => { allConnected = resolve; });
    const accepted = new Map();
    const concurrentCtx = {
      ...ctx,
      _ensureConnection: async () => {
        connectedCount++;
        if (connectedCount === 8) allConnected();
        await blocked;
      },
      _fingerprintTaskRequest: intent => JSON.stringify(intent),
      _resolveTaskIdempotency: (key, intent) => {
        const original = accepted.get(key);
        if (!original) return null;
        return original.fingerprint === JSON.stringify(intent)
          ? { data: { taskId: original.taskId, status: 'accepted' }, statusCode: 202 }
          : { data: { error: 'conflict', code: 'IDEMPOTENCY_KEY_CONFLICT', taskId: original.taskId }, statusCode: 409 };
      },
      _createQueuedTask: body => {
        const taskId = `concurrent-${variant}-${++acceptedCount}`;
        accepted.set(body.idempotencyKey, { taskId, fingerprint: body.idempotencyFingerprint });
        return { taskId };
      },
      _ensureBackgroundPolling: () => {},
      driver: { detectMode: async () => ({ mode: 'solo' }) }
    };
    const responses = Array.from({ length: 8 }, () => ({}));
    const submitting = responses.map((response, index) => handleSubmit(request({
      message: variant === 'conflicting-intent' && index >= 4 ? 'Other concurrent intent' : 'One concurrent intent'
    }, { 'idempotency-key': variant === 'distinct-keys' ? `distinct-${index}` : `shared-${variant}` }), response, concurrentCtx));
    let connectionTimeout;
    try {
      await Promise.race([
        connected,
        new Promise((resolve, reject) => {
          connectionTimeout = setTimeout(() => reject(new Error('concurrent submissions did not reach the asynchronous boundary')), 1000);
        })
      ]);
    } finally {
      clearTimeout(connectionTimeout);
      unblock();
    }
    await Promise.all(submitting);
    assert.strictEqual(acceptedCount, variant === 'distinct-keys' ? 8 : 1);
    assert.strictEqual(new Set(responses.map(response => response.body.taskId)).size, acceptedCount);
    if (variant === 'conflicting-intent') {
      assert.strictEqual(responses.filter(response => response.status === 202).length, 4);
      assert.strictEqual(responses.filter(response => response.status === 409).length, 4);
    } else {
      assert.ok(responses.every(response => response.status === 202));
    }
  }

  const oversizedKeyRes = {};
  let oversizedKeyConnected = false;
  await handleSubmit(request({ message: 'must reject the oversized key' }, {
    'idempotency-key': 'k'.repeat(257)
  }), oversizedKeyRes, {
    ...ctx,
    _ensureConnection: async () => {
      oversizedKeyConnected = true;
    }
  });
  assert.strictEqual(oversizedKeyConnected, false);
  assert.strictEqual(oversizedKeyRes.status, 400);
  assert.deepStrictEqual(oversizedKeyRes.body, {
    error: 'Idempotency-Key exceeds 256 characters',
    code: 'INVALID_IDEMPOTENCY_KEY'
  });

  calls.length = 0;
  const continueRes = {};
  await handleSubmit(request({ message: 'Continue the current conversation' }), continueRes, ctx);
  assert.strictEqual(calls[1][0], 'queue');
  assert.strictEqual(calls[1][1].newConversation, false);

  const snapshotCalls = [];
  const snapshotCtx = {
    ...ctx,
    _selectedWorkspacePath: '/tmp/selected',
    _assertProjectWorkspace: async path => ({ rootPath: path }),
    _createQueuedTask: body => {
      snapshotCalls.push(body);
      return { ...task, taskId: 'task_snapshot_1' };
    },
    driver: {
      ...ctx.driver,
      detectMode: async () => ({ mode: 'solo' }),
      getCurrentModel: async () => 'GLM-5.2',
      listSoloChats: async () => ({
        chats: [{ index: 2, title: 'Review API', active: true }]
      })
    }
  };
  await handleSubmit(request({ message: 'Bind current context' }), {}, snapshotCtx);
  assert.deepStrictEqual(snapshotCalls[0], {
    task: 'Bind current context',
    projectPath: '/tmp/selected',
    desiredModel: 'GLM-5.2',
    desiredMode: 'solo',
    soloChat: { titleIncludes: 'Review API' },
    newConversation: false,
    followupTasks: [],
    autoContinue: true,
    reviewRequired: false,
    autoApproveDialog: 'auto'
  });

  snapshotCalls.length = 0;
  await handleSubmit(request({
    message: 'Require a final review',
    reviewRequired: true
  }), {}, snapshotCtx);
  assert.strictEqual(snapshotCalls[0].reviewRequired, true);
  assert.strictEqual(snapshotCalls[0].autoContinue, false, 'requested review must wait for an explicit decision');

  const listRes = {};
  await handleListConversations(request({}), listRes, ctx);
  assert.deepStrictEqual(listRes.body, {
    mode: 'solo',
    conversations: [
      { id: 'solo:UmV2aWV3IEFQSQ', title: 'Review API', active: true },
      { id: 'solo:T2xkIHJldmlldw', title: 'Old review', active: false }
    ]
  });

  const modelRes = {};
  await handleListModels(request({}), modelRes, ctx);
  assert.deepStrictEqual(modelRes.body, {
    current: 'GLM-5.2',
    models: ['GLM-5.2', 'DeepSeek-V3.2']
  });
  await verifyModelListingSerialization(ctx);
  await verifyModelListingAfterShutdown(ctx);

  const deleteRes = {};
  await handleManageConversation(request({
    action: 'delete',
    conversationId: 'solo:T2xkIHJldmlldw',
    expectedTitle: 'Old review',
    acknowledgePermanentDeletion: true
  }), deleteRes, ctx);
  assert.deepStrictEqual(deleteRes.body, {
    action: 'delete',
    conversationId: 'solo:T2xkIHJldmlldw',
    deleted: 1,
    recoverable: false
  });
  assert.deepStrictEqual(calls.at(-1), ['delete', {
    candidates: [{ index: 3, title: 'Old review' }]
  }]);
  assert.strictEqual(auditEntries.at(-1).action, 'conversation.delete');

  const activeDeleteRes = {};
  await handleManageConversation(request({
    action: 'delete',
    conversationId: 'solo:UmV2aWV3IEFQSQ',
    expectedTitle: 'Review API',
    acknowledgePermanentDeletion: true
  }), activeDeleteRes, ctx);
  assert.strictEqual(activeDeleteRes.status, 409);
  assert.strictEqual(activeDeleteRes.body.error, 'active_conversation_delete_forbidden');

  const unconfirmedDeleteRes = {};
  await handleManageConversation(request({
    action: 'delete',
    conversationId: 'solo:T2xkIHJldmlldw',
    expectedTitle: 'Old review'
  }), unconfirmedDeleteRes, ctx);
  assert.strictEqual(unconfirmedDeleteRes.status, 400);
  assert.strictEqual(unconfirmedDeleteRes.body.error, 'permanent_deletion_acknowledgement_required');

  const staleApprovalRes = {};
  await handleResolveInteraction(request({
    action: 'approve',
    expectedCommand: 'rm -rf build',
    acknowledgeRisk: true,
    reason: 'User requested cleanup'
  }), staleApprovalRes, ctx);
  assert.strictEqual(staleApprovalRes.status, 409);
  assert.strictEqual(staleApprovalRes.body.error, 'approval_command_mismatch');

  ctx.driver.checkForApprovalDialog = async () => ({
    needsApproval: true,
    isCommandExec: true,
    approvalDecision: 'auto_approve',
    command: 'git push origin main',
    commandRisk: 'high',
    riskReasons: ['legacy_adapter_metadata']
  });
  const approvalRes = {};
  await handleResolveInteraction(request({
    action: 'approve',
    expectedCommand: 'git push origin main',
    acknowledgeRisk: true,
    reason: 'User explicitly requested publishing the current branch'
  }), approvalRes, ctx);
  assert.strictEqual(approvalRes.status, 200);
  assert.strictEqual(approvalRes.body.success, true);
  assert.deepStrictEqual(approvalRes.body.resumedTaskIds, ['task_gateway_1']);
  assert.deepStrictEqual(calls.at(-1), [
    'resume-interaction',
    'approve',
    'git push origin main',
    true
  ]);
  assert.strictEqual(auditEntries.at(-1).action, 'interaction.approval_decision');

  const spec = generateOpenAPISpec();
  assert.ok(spec.paths['/api/tasks/submit']?.post);
  assert.ok(spec.paths['/api/tasks/submit'].post.responses['503']);
  assert.strictEqual(
    spec.paths['/api/tasks/submit'].post.requestBody.content['application/json']
      .schema.properties.reviewRequired.default,
    false
  );
  assert.ok(spec.paths['/api/status'].get.responses['200']
    .content['application/json'].schema.properties.durability);
  assert.ok(spec.paths['/api/models']?.get);
  assert.ok(spec.paths['/api/conversations']?.get);
  assert.ok(spec.paths['/api/conversations/manage']?.post);
  assert.ok(spec.paths['/api/interactions/resolve']?.post);

  console.log('[unified-agent.test.js] PASS');
})().catch(error => {
  console.error('[unified-agent.test.js] FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
