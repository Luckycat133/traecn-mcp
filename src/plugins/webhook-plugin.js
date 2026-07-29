'use strict';

function getEnv(key, fallback) {
  return process.env[key] || fallback;
}

function parseWebhookUrls(envValue) {
  if (!envValue) return [];
  return envValue.split(',').map(s => s.trim()).filter(Boolean);
}

function parseWebhookEvents(envValue) {
  if (!envValue) return ['task.completed', 'task.error', 'gateway.startup', 'gateway.shutdown'];
  return envValue.split(',').map(s => s.trim()).filter(Boolean);
}

async function sendWebhook(url, payload, timeout = 5000) {
  const body = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...payload
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TraeCNclaw-Webhook/1.0'
      },
      body,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return { success: true, status: response.status };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Webhook timeout after ${timeout}ms`);
    }
    throw err;
  }
}

function formatTaskPayload(event, ctx, result) {
  return {
    event,
    data: {
      task: ctx.task || null,
      sessionId: ctx.sessionId || null,
      taskId: ctx.taskId || null,
      result: result ? {
        text: result.text?.substring(0, 500) || null,
        stable: result.stable || false,
        elapsedMs: result.elapsedMs || null,
        error: result.error || null,
        needsApproval: result.needsApproval || false
      } : null
    }
  };
}

function formatErrorPayload(ctx, error) {
  return {
    event: 'task.error',
    data: {
      task: ctx.task || null,
      sessionId: ctx.sessionId || null,
      taskId: ctx.taskId || null,
      error: {
        message: error.message,
        code: error.code || 'UNKNOWN',
        stack: error.stack?.split('\n').slice(0, 5).join('\n')
      }
    }
  };
}

function formatLifecyclePayload(event, gateway) {
  return {
    event,
    data: {
      host: gateway.host,
      port: gateway.port,
      version: gateway.version || 'unknown',
      uptime: process.uptime(),
      activeTasks: gateway.taskQueue?.size || 0,
      activeSessions: gateway.sessions?.size || 0
    }
  };
}

function createWebhookPlugin(options = {}) {
  const webhookUrls = options.urls || parseWebhookUrls(
    getEnv('TRAECN_WEBHOOK_URLS', getEnv('TRAE_WEBHOOK_URLS', ''))
  );

  const enabledEvents = options.events || parseWebhookEvents(
    getEnv('TRAECN_WEBHOOK_EVENTS', getEnv('TRAE_WEBHOOK_EVENTS', ''))
  );

  const timeout = options.timeout || parseInt(
    getEnv('TRAECN_WEBHOOK_TIMEOUT', getEnv('TRAE_WEBHOOK_TIMEOUT', '5000')),
    10
  );

  const retryCount = options.retryCount || parseInt(
    getEnv('TRAECN_WEBHOOK_RETRY_COUNT', getEnv('TRAE_WEBHOOK_RETRY_COUNT', '3')),
    10
  );

  const retryDelay = options.retryDelay || parseInt(
    getEnv('TRAECN_WEBHOOK_RETRY_DELAY', getEnv('TRAE_WEBHOOK_RETRY_DELAY', '1000')),
    10
  );

  if (webhookUrls.length === 0) {
    console.log('[webhook-plugin] No webhook URLs configured, plugin will be disabled');
  }

  const sentWebhooks = [];

  async function notifyAll(event, payload) {
    if (!enabledEvents.includes(event) && !enabledEvents.includes('*')) {
      return;
    }

    const results = [];

    for (const url of webhookUrls) {
      let lastError = null;

      for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
            console.log(`[webhook-plugin] Retry ${attempt}/${retryCount} for ${event} to ${url}`);
          }

          const result = await sendWebhook(url, payload, timeout);
          results.push({ url, success: true, status: result.status });
          sentWebhooks.push({ event, url, timestamp: new Date().toISOString(), success: true });
          console.log(`[webhook-plugin] Webhook sent: ${event} to ${url}`);
          break;
        } catch (err) {
          lastError = err;
          if (attempt === retryCount) {
            results.push({ url, success: false, error: err.message });
            sentWebhooks.push({ event, url, timestamp: new Date().toISOString(), success: false, error: err.message });
            console.error(`[webhook-plugin] Webhook failed: ${event} to ${url} - ${err.message}`);
          }
        }
      }
    }

    return results;
  }

  return {
    name: 'webhook-plugin',
    version: '1.0.0',

    hooks: {
      onStartup: async (gateway) => {
        if (webhookUrls.length === 0) {
          console.log('[webhook-plugin] Disabled - no URLs configured');
          return;
        }

        console.log(`[webhook-plugin] Enabled with ${webhookUrls.length} webhook(s), listening for: ${enabledEvents.join(', ')}`);

        await notifyAll('gateway.startup', formatLifecyclePayload('gateway.startup', gateway));
      },

      onShutdown: async (gateway) => {
        if (webhookUrls.length === 0) return;

        await notifyAll('gateway.shutdown', formatLifecyclePayload('gateway.shutdown', gateway));
      },

      afterTask: async (ctx, result) => {
        if (webhookUrls.length === 0) return result;

        const event = result?.error ? 'task.error' : 'task.completed';

        if (event === 'task.error') {
          await notifyAll('task.error', formatErrorPayload(ctx, result));
        } else {
          await notifyAll('task.completed', formatTaskPayload(event, ctx, result));
        }

        return result;
      },

      onError: async (ctx, error) => {
        if (webhookUrls.length === 0) return;

        await notifyAll('task.error', formatErrorPayload(ctx, error));
      }
    },

    getSentWebhooks: () => [...sentWebhooks],

    routes: [
      {
        method: 'GET',
        path: '/api/webhooks/status',
        handler: async (ctx, req, res) => {
          return {
            body: {
              configured: webhookUrls.length > 0,
              urls: webhookUrls,
              enabledEvents,
              timeout,
              retryCount,
              totalSent: sentWebhooks.length,
              recent: sentWebhooks.slice(-10)
            },
            contentType: 'application/json'
          };
        }
      }
    ]
  };
}

module.exports = createWebhookPlugin;
module.exports.default = createWebhookPlugin;
module.exports.sendWebhook = sendWebhook;
