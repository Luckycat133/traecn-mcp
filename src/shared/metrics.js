'use strict';

const { getEnvWithFallback } = require('./utils');

function getHistogramBuckets() {
  return [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
}

class Counter {
  constructor(name, help, labels = []) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.values = new Map();
  }

  inc(labels = {}) {
    const key = this._labelKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + 1);
  }

  incBy(value, labels = {}) {
    const key = this._labelKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  get(labels = {}) {
    return this.values.get(this._labelKey(labels)) || 0;
  }

  getAll() {
    const result = {};
    for (const [key, value] of this.values) {
      result[key] = value;
    }
    return result;
  }

  reset() {
    this.values.clear();
  }

  _labelKey(labels) {
    if (this.labels.length === 0) return '_total';
    const parts = [];
    for (const label of this.labels) {
      parts.push(`${label}="${labels[label] || 'unknown'}"`);
    }
    return parts.join(',');
  }

  toPrometheus() {
    const lines = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} counter`);
    for (const [key, value] of this.values) {
      if (key === '_total') {
        lines.push(`${this.name} ${value}`);
      } else {
        lines.push(`${this.name}{${key}} ${value}`);
      }
    }
    return lines.join('\n');
  }
}

class Gauge {
  constructor(name, help, labels = []) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.values = new Map();
  }

  set(value, labels = {}) {
    const key = this._labelKey(labels);
    this.values.set(key, value);
  }

  inc(labels = {}) {
    const key = this._labelKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + 1);
  }

  dec(labels = {}) {
    const key = this._labelKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current - 1);
  }

  get(labels = {}) {
    return this.values.get(this._labelKey(labels)) || 0;
  }

  getAll() {
    const result = {};
    for (const [key, value] of this.values) {
      result[key] = value;
    }
    return result;
  }

  reset() {
    this.values.clear();
  }

  _labelKey(labels) {
    if (this.labels.length === 0) return '_total';
    const parts = [];
    for (const label of this.labels) {
      parts.push(`${label}="${labels[label] || 'unknown'}"`);
    }
    return parts.join(',');
  }

  toPrometheus() {
    const lines = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} gauge`);
    for (const [key, value] of this.values) {
      if (key === '_total') {
        lines.push(`${this.name} ${value}`);
      } else {
        lines.push(`${this.name}{${key}} ${value}`);
      }
    }
    return lines.join('\n');
  }
}

class Histogram {
  constructor(name, help, buckets = getHistogramBuckets(), labels = []) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
    this.labels = labels;
    this.counts = new Map();
    this.sums = new Map();
    this.totalCounts = new Map();
  }

  observe(value, labels = {}) {
    const key = this._labelKey(labels);

    if (!this.counts.has(key)) {
      this.counts.set(key, new Map());
      this.sums.set(key, 0);
      this.totalCounts.set(key, 0);
      for (const bucket of this.buckets) {
        this.counts.get(key).set(bucket, 0);
      }
    }

    const bucketCounts = this.counts.get(key);
    for (const bucket of this.buckets) {
      if (value <= bucket) {
        bucketCounts.set(bucket, bucketCounts.get(bucket) + 1);
      }
    }

    this.sums.set(key, this.sums.get(key) + value);
    this.totalCounts.set(key, this.totalCounts.get(key) + 1);
  }

  get(labels = {}) {
    const key = this._labelKey(labels);
    return {
      count: this.totalCounts.get(key) || 0,
      sum: this.sums.get(key) || 0,
      buckets: this.counts.has(key)
        ? Object.fromEntries(this.counts.get(key))
        : Object.fromEntries(this.buckets.map(b => [b, 0]))
    };
  }

  getPercentile(labels = {}, percentile) {
    const data = this.get(labels);
    if (data.count === 0) return 0;
    const targetCount = Math.ceil(data.count * percentile);
    let accumulated = 0;
    for (const [bucket, count] of Object.entries(data.buckets)) {
      accumulated += count;
      if (accumulated >= targetCount) {
        return parseFloat(bucket);
      }
    }
    return data.sum / data.count;
  }

  reset() {
    this.counts.clear();
    this.sums.clear();
    this.totalCounts.clear();
  }

  _labelKey(labels) {
    if (this.labels.length === 0) return '_total';
    const parts = [];
    for (const label of this.labels) {
      parts.push(`${label}="${labels[label] || 'unknown'}"`);
    }
    return parts.join(',');
  }

  toPrometheus() {
    const lines = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} histogram`);

    for (const [key, bucketMap] of this.counts) {
      let cumulative = 0;
      for (const bucket of this.buckets) {
        cumulative += bucketMap.get(bucket) || 0;
        const labelPart = key === '_total' ? '' : `{${key}}`;
        lines.push(`${this.name}_bucket{le="${bucket}"${key !== '_total' ? ',' + key : ''}} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket{le="+Inf"${key !== '_total' ? ',' + key : ''}} ${cumulative}`);
    }

    for (const [key, sum] of this.sums) {
      const labelPart = key === '_total' ? '' : `{${key}}`;
      lines.push(`${this.name}_sum${labelPart} ${sum}`);
    }

    for (const [key, count] of this.totalCounts) {
      const labelPart = key === '_total' ? '' : `{${key}}`;
      lines.push(`${this.name}_count${labelPart} ${count}`);
    }

    return lines.join('\n');
  }
}

class MetricsCollector {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.prefix = options.prefix || 'traecn';

    this.httpRequestsTotal = new Counter(
      `${this.prefix}_http_requests_total`,
      'Total number of HTTP requests',
      ['method', 'path', 'status']
    );

    this.httpRequestDuration = new Histogram(
      `${this.prefix}_http_request_duration_ms`,
      'HTTP request duration in milliseconds',
      getHistogramBuckets(),
      ['method', 'path']
    );

    this.httpRequestSize = new Histogram(
      `${this.prefix}_http_request_size_bytes`,
      'HTTP request size in bytes',
      getHistogramBuckets(),
      []
    );

    this.httpResponseSize = new Histogram(
      `${this.prefix}_http_response_size_bytes`,
      'HTTP response size in bytes',
      getHistogramBuckets(),
      []
    );

    this.activeSessions = new Gauge(
      `${this.prefix}_active_sessions`,
      'Number of active sessions'
    );

    this.activeTasks = new Gauge(
      `${this.prefix}_active_tasks`,
      'Number of active tasks'
    );

    this.tasksTotal = new Counter(
      `${this.prefix}_tasks_total`,
      'Total number of tasks',
      ['status']
    );

    this.taskDuration = new Histogram(
      `${this.prefix}_task_duration_ms`,
      'Task execution duration in milliseconds',
      getHistogramBuckets(),
      ['type']
    );

    this.errorsTotal = new Counter(
      `${this.prefix}_errors_total`,
      'Total number of errors',
      ['type']
    );

    this.cdpConnections = new Gauge(
      `${this.prefix}_cdp_connections`,
      'Number of CDP connections',
      ['status']
    );

    this.queueSize = new Gauge(
      `${this.prefix}_queue_size`,
      'Current queue size',
      ['type']
    );

    this.uptime = new Gauge(
      `${this.prefix}_uptime_seconds`,
      'Process uptime in seconds'
    );

    this.startTime = Date.now();
    this._updateTimer = null;

    if (this.enabled) {
      this._startUpdating();
    }
  }

  _startUpdating() {
    this._updateTimer = setInterval(() => {
      this.uptime.set((Date.now() - this.startTime) / 1000);
    }, 5000);
    if (this._updateTimer.unref) {
      this._updateTimer.unref();
    }
  }

  recordHttpRequest(method, path, statusCode, durationMs, requestSize = 0, responseSize = 0) {
    if (!this.enabled) return;

    const normalizedPath = this._normalizePath(path);
    this.httpRequestsTotal.inc({ method, path: normalizedPath, status: statusCode });
    this.httpRequestDuration.observe(durationMs, { method, path: normalizedPath });
    if (requestSize > 0) {
      this.httpRequestSize.observe(requestSize);
    }
    if (responseSize > 0) {
      this.httpResponseSize.observe(responseSize);
    }

    if (statusCode >= 400) {
      this.errorsTotal.inc({ type: 'http' });
    }
  }

  setActiveSessions(count) {
    if (!this.enabled) return;
    this.activeSessions.set(count);
  }

  setActiveTasks(count) {
    if (!this.enabled) return;
    this.activeTasks.set(count);
  }

  recordTaskStart() {
    if (!this.enabled) return;
    this.activeTasks.inc();
  }

  recordTaskComplete(status, durationMs, type = 'delegate') {
    if (!this.enabled) return;
    this.activeTasks.dec();
    this.tasksTotal.inc({ status });
    this.taskDuration.observe(durationMs, { type });

    if (status === 'error') {
      this.errorsTotal.inc({ type: 'task' });
    }
  }

  recordError(type) {
    if (!this.enabled) return;
    this.errorsTotal.inc({ type });
  }

  setCdpConnection(status) {
    if (!this.enabled) return;
    this.cdpConnections.set(status === 'connected' ? 1 : 0, { status });
  }

  setQueueSize(type, size) {
    if (!this.enabled) return;
    this.queueSize.set(size, { type });
  }

  _normalizePath(path) {
    return path
      .replace(/\/api\/sessions\/[^/]+/g, '/api/sessions/:id')
      .replace(/\/api\/task\/[^/]+/g, '/api/task/:id');
  }

  getMetrics() {
    return {
      httpRequests: this.httpRequestsTotal.getAll(),
      httpDuration: this.httpRequestDuration.get(),
      activeSessions: this.activeSessions.get(),
      activeTasks: this.activeTasks.get(),
      tasksTotal: this.tasksTotal.getAll(),
      errorsTotal: this.errorsTotal.getAll(),
      cdpConnections: this.cdpConnections.getAll(),
      queueSize: this.queueSize.getAll(),
      uptime: this.uptime.get(),
      timestamp: new Date().toISOString()
    };
  }

  toPrometheus() {
    const lines = [
      this.httpRequestsTotal.toPrometheus(),
      this.httpRequestDuration.toPrometheus(),
      this.httpRequestSize.toPrometheus(),
      this.httpResponseSize.toPrometheus(),
      this.activeSessions.toPrometheus(),
      this.activeTasks.toPrometheus(),
      this.tasksTotal.toPrometheus(),
      this.taskDuration.toPrometheus(),
      this.errorsTotal.toPrometheus(),
      this.cdpConnections.toPrometheus(),
      this.queueSize.toPrometheus(),
      this.uptime.toPrometheus()
    ].filter(Boolean);

    return lines.join('\n');
  }

  toJson() {
    return JSON.stringify(this.getMetrics(), null, 2);
  }

  reset() {
    this.httpRequestsTotal.reset();
    this.httpRequestDuration.reset();
    this.httpRequestSize.reset();
    this.httpResponseSize.reset();
    this.tasksTotal.reset();
    this.taskDuration.reset();
    this.errorsTotal.reset();
    this.queueSize.reset();
  }

  close() {
    if (this._updateTimer) {
      clearInterval(this._updateTimer);
      this._updateTimer = null;
    }
  }
}

const globalMetrics = new MetricsCollector({
  enabled: getEnvWithFallback('TRAECN_METRICS_ENABLED', 'TRAE_METRICS_ENABLED', '1') === '1'
});

function createMetricsMiddleware(collector) {
  return function metricsMiddleware(req, res, next) {
    const startTime = Date.now();
    const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    req.requestId = requestId;

    const originalEnd = res.end;
    res.end = function(...args) {
      const duration = Date.now() - startTime;
      const statusCode = res.statusCode || 200;

      collector.recordHttpRequest(
        req.method,
        req.url,
        statusCode,
        duration,
        parseInt(req.headers['content-length'] || '0', 10),
        parseInt(res.getHeader('content-length') || '0', 10)
      );

      return originalEnd.apply(this, args);
    };

    next();
  };
}

module.exports = {
  Counter,
  Gauge,
  Histogram,
  MetricsCollector,
  globalMetrics,
  createMetricsMiddleware,
  getHistogramBuckets
};
