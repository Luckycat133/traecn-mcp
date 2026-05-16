'use strict';

class MetricsCollector {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.timers = new Map();
  }

  increment(name, labels = {}, value = 1) {
    const key = this._makeKey(name, labels);
    const current = this.counters.get(key) || { value: 0, labels, createdAt: Date.now() };
    current.value += value;
    this.counters.set(key, current);
  }

  decrement(name, labels = {}, value = 1) {
    this.increment(name, labels, -value);
  }

  gauge(name, value, labels = {}) {
    const key = this._makeKey(name, labels);
    this.gauges.set(key, { value, labels, updatedAt: Date.now() });
  }

  observe(name, value, labels = {}) {
    const key = this._makeKey(name, labels);
    const buckets = this.histograms.get(key) || { values: [], labels, createdAt: Date.now() };
    buckets.values.push(value);
    if (buckets.values.length > 1000) {
      buckets.values = buckets.values.slice(-1000);
    }
    this.histograms.set(key, buckets);
  }

  startTimer(name, labels = {}) {
    const key = this._makeKey(name, labels);
    this.timers.set(key, Date.now());
  }

  stopTimer(name, labels = {}) {
    const key = this._makeKey(name, labels);
    const startTime = this.timers.get(key);
    if (startTime) {
      const elapsed = Date.now() - startTime;
      this.timers.delete(key);
      this.observe(name, elapsed, labels);
      return elapsed;
    }
    return null;
  }

  getCounter(name, labels = {}) {
    const key = this._makeKey(name, labels);
    return this.counters.get(key)?.value || 0;
  }

  getGauge(name, labels = {}) {
    const key = this._makeKey(name, labels);
    return this.gauges.get(key)?.value || 0;
  }

  getHistogramStats(name, labels = {}) {
    const key = this._makeKey(name, labels);
    const buckets = this.histograms.get(key);
    if (!buckets || buckets.values.length === 0) {
      return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
    }

    const values = [...buckets.values].sort((a, b) => a - b);
    const count = values.length;
    const sum = values.reduce((a, b) => a + b, 0);

    return {
      count,
      min: values[0],
      max: values[count - 1],
      avg: sum / count,
      p50: values[Math.floor(count * 0.5)],
      p95: values[Math.floor(count * 0.95)],
      p99: values[Math.floor(count * 0.99)]
    };
  }

  getAllMetrics() {
    const result = {
      counters: {},
      gauges: {},
      histograms: {},
      summary: {
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      }
    };

    for (const [key, data] of this.counters) {
      result.counters[key] = data.value;
    }

    for (const [key, data] of this.gauges) {
      result.gauges[key] = data.value;
    }

    for (const [key, data] of this.histograms) {
      result.histograms[key] = this.getHistogramStats(key.split(':')[0], {});
    }

    return result;
  }

  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.timers.clear();
  }

  _makeKey(name, labels) {
    const labelParts = Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join(',');
    return labelParts ? `${name}:${labelParts}` : name;
  }
}

let globalMetrics = null;

function getGlobalMetrics() {
  if (!globalMetrics) {
    globalMetrics = new MetricsCollector();
  }
  return globalMetrics;
}

function createMetricsPlugin(config = {}) {
  const collectDefaultMetrics = config.collectDefaultMetrics !== false;
  const metricsPrefix = config.metricsPrefix || 'traecn';

  const metrics = getGlobalMetrics();

  const plugin = {
    name: 'metrics-plugin',
    version: '1.0.0',

    hooks: {
      onStartup: async (gateway) => {
        if (collectDefaultMetrics) {
          metrics.gauge(`${metricsPrefix}_gateway_up`, 1, { host: gateway.host, port: String(gateway.port) });
          console.log(`[metrics-plugin] Started, collecting metrics with prefix "${metricsPrefix}"`);
        }
      },

      onShutdown: async (gateway) => {
        if (collectDefaultMetrics) {
          metrics.gauge(`${metricsPrefix}_gateway_up`, 0, { host: gateway.host, port: String(gateway.port) });
        }
      },

      beforeTask: async (ctx) => {
        const taskId = ctx.taskId || `task_${Date.now()}`;
        ctx.taskId = taskId;

        metrics.increment(`${metricsPrefix}_task_started`, {
          method: ctx.req?.method || 'unknown',
          endpoint: ctx.req?.url || 'unknown'
        });

        metrics.startTimer(`${metricsPrefix}_task_duration`, {
          method: ctx.req?.method || 'unknown'
        });

        return ctx;
      },

      afterTask: async (ctx, result) => {
        const labels = {
          method: ctx.req?.method || 'unknown',
          status: result?.error ? 'error' : 'success'
        };

        metrics.increment(`${metricsPrefix}_task_completed`, labels);

        const elapsed = metrics.stopTimer(`${metricsPrefix}_task_duration`, {
          method: ctx.req?.method || 'unknown'
        });

        if (result?.elapsedMs) {
          metrics.observe(`${metricsPrefix}_task_elapsed`, result.elapsedMs, labels);
        }

        return result;
      },

      onError: async (ctx, error) => {
        const labels = {
          method: ctx.req?.method || 'unknown',
          error_type: error?.name || 'Error'
        };

        metrics.increment(`${metricsPrefix}_task_errors`, labels);

        const elapsed = metrics.stopTimer(`${metricsPrefix}_task_duration`, {
          method: ctx.req?.method || 'unknown'
        });
      }
    },

    middleware: async (ctx, next) => {
      const req = ctx.req;
      if (!req) {
        return next();
      }

      metrics.increment(`${metricsPrefix}_http_requests_total`, {
        method: req.method,
        path: new URL(req._normalizedUrl || req.url, `http://${req.headers.host}`).pathname
      });

      metrics.startTimer(`${metricsPrefix}_http_request_duration`, {
        method: req.method
      });

      try {
        const result = await next();

        metrics.increment(`${metricsPrefix}_http_responses_total`, {
          method: req.method,
          status: '2xx'
        });

        return result;
      } catch (err) {
        metrics.increment(`${metricsPrefix}_http_responses_total`, {
          method: req.method,
          status: '5xx'
        });
        throw err;
      } finally {
        metrics.stopTimer(`${metricsPrefix}_http_request_duration`, {
          method: req.method
        });
      }
    }
  };

  plugin.getMetrics = () => metrics.getAllMetrics();
  plugin.getMetricsCollector = () => metrics;

  plugin.routes = [
    {
      method: 'GET',
      path: '/api/metrics',
      handler: async (ctx, req, res) => {
        const metricsData = metrics.getAllMetrics();
        const format = req.headers['accept']?.includes('text/plain') ? 'prometheus' : 'json';

        if (format === 'prometheus') {
          let output = '';
          for (const [key, value] of Object.entries(metricsData.counters)) {
            output += `# TYPE ${key} counter\n${key} ${value}\n`;
          }
          for (const [key, value] of Object.entries(metricsData.gauges)) {
            output += `# TYPE ${key} gauge\n${key} ${value}\n`;
          }
          for (const [key, stats] of Object.entries(metricsData.histograms)) {
            output += `# TYPE ${key} histogram\n`;
            output += `${key}_count ${stats.count}\n`;
            output += `${key}_sum ${(stats.avg * stats.count).toFixed(2)}\n`;
          }
          return { body: output, contentType: 'text/plain; charset=utf-8' };
        }

        return { body: metricsData, contentType: 'application/json' };
      }
    },
    {
      method: 'GET',
      path: '/api/metrics/summary',
      handler: async (ctx, req, res) => {
        const allMetrics = metrics.getAllMetrics();
        return {
          body: {
            totalRequests: Object.values(allMetrics.counters).reduce((a, b) => a + b, 0),
            tasksStarted: metrics.getCounter(`${metricsPrefix}_task_started`),
            tasksCompleted: metrics.getCounter(`${metricsPrefix}_task_completed`),
            tasksErrors: metrics.getCounter(`${metricsPrefix}_task_errors`),
            uptime: allMetrics.summary.uptime,
            timestamp: allMetrics.summary.timestamp
          },
          contentType: 'application/json'
        };
      }
    }
  ];

  return plugin;
}

module.exports = createMetricsPlugin;
module.exports.default = createMetricsPlugin;
module.exports.MetricsCollector = MetricsCollector;
module.exports.getGlobalMetrics = getGlobalMetrics;
