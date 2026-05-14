'use strict';

const assert = require('assert');
const { Counter, Gauge, Histogram, MetricsCollector, createMetricsMiddleware, getHistogramBuckets } = require('./metrics');

function testHistogramBuckets() {
  const buckets = getHistogramBuckets();
  assert.ok(Array.isArray(buckets));
  assert.ok(buckets.includes(5));
  assert.ok(buckets.includes(1000));
  assert.ok(buckets.includes(10000));
  console.log('✓ testHistogramBuckets passed');
}

function testCounterCreation() {
  const counter = new Counter('test_counter', 'Test counter');
  assert.strictEqual(counter.name, 'test_counter');
  assert.strictEqual(counter.help, 'Test counter');
  console.log('✓ testCounterCreation passed');
}

function testCounterInc() {
  const counter = new Counter('test_counter', 'Test counter');
  counter.inc();
  assert.strictEqual(counter.get(), 1);
  counter.inc();
  assert.strictEqual(counter.get(), 2);
  console.log('✓ testCounterInc passed');
}

function testCounterIncBy() {
  const counter = new Counter('test_counter', 'Test counter');
  counter.incBy(5);
  assert.strictEqual(counter.get(), 5);
  counter.incBy(3);
  assert.strictEqual(counter.get(), 8);
  console.log('✓ testCounterIncBy passed');
}

function testCounterWithLabels() {
  const counter = new Counter('test_counter', 'Test counter', ['method', 'status']);
  counter.inc({ method: 'GET', status: '200' });
  counter.inc({ method: 'GET', status: '200' });
  counter.inc({ method: 'POST', status: '201' });

  assert.strictEqual(counter.get({ method: 'GET', status: '200' }), 2);
  assert.strictEqual(counter.get({ method: 'POST', status: '201' }), 1);
  assert.strictEqual(counter.get({ method: 'DELETE', status: '404' }), 0);
  console.log('✓ testCounterWithLabels passed');
}

function testCounterGetAll() {
  const counter = new Counter('test_counter', 'Test counter', ['method']);
  counter.inc({ method: 'GET' });
  counter.inc({ method: 'GET' });
  counter.inc({ method: 'POST' });

  const all = counter.getAll();
  assert.ok(Object.values(all).some(v => v === 2));
  assert.ok(Object.values(all).some(v => v === 1));
  console.log('✓ testCounterGetAll passed');
}

function testCounterReset() {
  const counter = new Counter('test_counter', 'Test counter');
  counter.inc();
  counter.inc();
  counter.reset();
  assert.strictEqual(counter.get(), 0);
  console.log('✓ testCounterReset passed');
}

function testCounterPrometheusOutput() {
  const counter = new Counter('http_requests', 'HTTP requests', ['method', 'status']);
  counter.inc({ method: 'GET', status: '200' });
  counter.inc({ method: 'GET', status: '200' });
  counter.inc({ method: 'POST', status: '201' });

  const output = counter.toPrometheus();
  assert.ok(output.includes('# HELP http_requests HTTP requests'));
  assert.ok(output.includes('# TYPE http_requests counter'));
  assert.ok(output.includes('http_requests{method="GET",status="200"}'));
  assert.ok(output.includes('http_requests{method="POST",status="201"}'));
  console.log('✓ testCounterPrometheusOutput passed');
}

function testGaugeCreation() {
  const gauge = new Gauge('test_gauge', 'Test gauge');
  assert.strictEqual(gauge.name, 'test_gauge');
  console.log('✓ testGaugeCreation passed');
}

function testGaugeSet() {
  const gauge = new Gauge('test_gauge', 'Test gauge');
  gauge.set(10);
  assert.strictEqual(gauge.get(), 10);
  gauge.set(20);
  assert.strictEqual(gauge.get(), 20);
  console.log('✓ testGaugeSet passed');
}

function testGaugeIncDec() {
  const gauge = new Gauge('test_gauge', 'Test gauge');
  gauge.set(5);
  gauge.inc();
  assert.strictEqual(gauge.get(), 6);
  gauge.dec();
  assert.strictEqual(gauge.get(), 5);
  console.log('✓ testGaugeIncDec passed');
}

function testGaugeWithLabels() {
  const gauge = new Gauge('test_gauge', 'Test gauge', ['status']);
  gauge.set(10, { status: 'active' });
  gauge.set(5, { status: 'idle' });

  assert.strictEqual(gauge.get({ status: 'active' }), 10);
  assert.strictEqual(gauge.get({ status: 'idle' }), 5);
  console.log('✓ testGaugeWithLabels passed');
}

function testGaugePrometheusOutput() {
  const gauge = new Gauge('memory_usage', 'Memory usage bytes', ['type']);
  gauge.set(1024, { type: 'heap' });
  gauge.set(2048, { type: 'rss' });

  const output = gauge.toPrometheus();
  assert.ok(output.includes('# TYPE memory_usage gauge'));
  assert.ok(output.includes('memory_usage{type="heap"} 1024'));
  console.log('✓ testGaugePrometheusOutput passed');
}

function testHistogramCreation() {
  const histogram = new Histogram('request_duration', 'Request duration');
  assert.strictEqual(histogram.name, 'request_duration');
  assert.ok(histogram.buckets.length > 0);
  console.log('✓ testHistogramCreation passed');
}

function testHistogramObserve() {
  const histogram = new Histogram('request_duration', 'Request duration', [10, 50, 100, 500]);

  histogram.observe(5);
  histogram.observe(25);
  histogram.observe(75);
  histogram.observe(150);

  const data = histogram.get();
  assert.strictEqual(data.count, 4);
  assert.ok(data.sum > 0);
  assert.ok(data.buckets[10] >= 1);
  assert.ok(data.buckets[100] >= 3);
  console.log('✓ testHistogramObserve passed');
}

function testHistogramWithLabels() {
  const histogram = new Histogram('request_duration', 'Request duration', [10, 50, 100], ['method']);

  histogram.observe(5, { method: 'GET' });
  histogram.observe(25, { method: 'GET' });
  histogram.observe(75, { method: 'POST' });

  const getData = histogram.get({ method: 'GET' });
  assert.strictEqual(getData.count, 2);

  const postData = histogram.get({ method: 'POST' });
  assert.strictEqual(postData.count, 1);
  console.log('✓ testHistogramWithLabels passed');
}

function testHistogramPercentile() {
  const histogram = new Histogram('request_duration', 'Request duration', [10, 50, 100, 500]);

  histogram.observe(10);
  histogram.observe(20);
  histogram.observe(30);
  histogram.observe(40);
  histogram.observe(50);

  const p50 = histogram.getPercentile({}, 0.5);
  assert.ok(p50 >= 10 && p50 <= 50);
  console.log('✓ testHistogramPercentile passed');
}

function testHistogramReset() {
  const histogram = new Histogram('request_duration', 'Request duration');
  histogram.observe(100);
  histogram.observe(200);
  histogram.reset();

  const data = histogram.get();
  assert.strictEqual(data.count, 0);
  assert.strictEqual(data.sum, 0);
  console.log('✓ testHistogramReset passed');
}

function testHistogramPrometheusOutput() {
  const histogram = new Histogram('request_duration', 'Request duration', [10, 50, 100]);

  histogram.observe(5);
  histogram.observe(25);
  histogram.observe(75);

  const output = histogram.toPrometheus();
  assert.ok(output.includes('# TYPE request_duration histogram'));
  assert.ok(output.includes('request_duration_bucket'));
  assert.ok(output.includes('request_duration_sum'));
  assert.ok(output.includes('request_duration_count'));
  console.log('✓ testHistogramPrometheusOutput passed');
}

function testMetricsCollectorCreation() {
  const collector = new MetricsCollector({ prefix: 'test' });
  assert.ok(collector.httpRequestsTotal);
  assert.ok(collector.httpRequestDuration);
  assert.ok(collector.activeSessions);
  assert.ok(collector.tasksTotal);
  collector.close();
  console.log('✓ testMetricsCollectorCreation passed');
}

function testRecordHttpRequest() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });

  collector.recordHttpRequest('GET', '/api/status', 200, 50, 0, 100);
  collector.recordHttpRequest('POST', '/api/delegate', 200, 500, 50, 200);
  collector.recordHttpRequest('POST', '/api/delegate', 500, 100, 0, 50);

  const metrics = collector.getMetrics();
  assert.ok(metrics.httpRequests);
  assert.ok(metrics.httpDuration);
  collector.close();
  console.log('✓ testRecordHttpRequest passed');
}

function testSetActiveSessions() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });

  collector.setActiveSessions(5);
  assert.strictEqual(collector.activeSessions.get(), 5);

  collector.setActiveSessions(10);
  assert.strictEqual(collector.activeSessions.get(), 10);
  collector.close();
  console.log('✓ testSetActiveSessions passed');
}

function testSetActiveTasks() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });

  collector.setActiveTasks(3);
  assert.strictEqual(collector.activeTasks.get(), 3);
  collector.close();
  console.log('✓ testSetActiveTasks passed');
}

function testRecordTaskStartComplete() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });

  collector.recordTaskStart();
  collector.recordTaskStart();
  assert.strictEqual(collector.activeTasks.get(), 2);

  collector.recordTaskComplete('success', 1000);
  assert.strictEqual(collector.activeTasks.get(), 1);

  collector.recordTaskComplete('error', 500);
  assert.strictEqual(collector.activeTasks.get(), 0);

  const metrics = collector.getMetrics();
  assert.ok(metrics.tasksTotal);
  collector.close();
  console.log('✓ testRecordTaskStartComplete passed');
}

function testRecordError() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });

  collector.recordError('http');
  collector.recordError('task');
  collector.recordError('task');

  const count = collector.errorsTotal.get({ type: 'task' });
  assert.strictEqual(count, 2);
  collector.close();
  console.log('✓ testRecordError passed');
}

function testSetCdpConnection() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });

  collector.setCdpConnection('connected');
  collector.setCdpConnection('disconnected');

  collector.close();
  console.log('✓ testSetCdpConnection passed');
}

function testSetQueueSize() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });

  collector.setQueueSize('delegate', 5);
  collector.setQueueSize('delegate', 10);
  collector.setQueueSize('delegate', 8);

  collector.close();
  console.log('✓ testSetQueueSize passed');
}

function testNormalizePath() {
  const collector = new MetricsCollector({ prefix: 'test' });

  assert.strictEqual(collector._normalizePath('/api/sessions/sess123'), '/api/sessions/:id');
  assert.strictEqual(collector._normalizePath('/api/task/task456'), '/api/task/:id');
  assert.strictEqual(collector._normalizePath('/api/status'), '/api/status');
  collector.close();
  console.log('✓ testNormalizePath passed');
}

function testGetMetrics() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });

  collector.recordHttpRequest('GET', '/api/status', 200, 50);
  collector.setActiveSessions(3);
  collector.setActiveTasks(2);

  const metrics = collector.getMetrics();
  assert.ok(metrics.timestamp);
  assert.ok(metrics.httpRequests);
  assert.strictEqual(metrics.activeSessions, 3);
  assert.strictEqual(metrics.activeTasks, 2);
  collector.close();
  console.log('✓ testGetMetrics passed');
}

function testToPrometheus() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });

  collector.recordHttpRequest('GET', '/api/status', 200, 50);
  collector.setActiveSessions(3);

  const output = collector.toPrometheus();
  assert.ok(output.includes('test_http_requests_total'));
  assert.ok(output.includes('test_active_sessions'));
  collector.close();
  console.log('✓ testToPrometheus passed');
}

function testToJson() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });

  collector.recordHttpRequest('GET', '/api/status', 200, 50);

  const json = collector.toJson();
  const parsed = JSON.parse(json);
  assert.ok(parsed.httpRequests);
  collector.close();
  console.log('✓ testToJson passed');
}

function testMetricsReset() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });

  collector.recordHttpRequest('GET', '/api/status', 200, 50);
  collector.recordHttpRequest('POST', '/api/delegate', 200, 500);

  collector.reset();

  const metrics = collector.getMetrics();
  assert.strictEqual(metrics.activeSessions, 0);
  collector.close();
  console.log('✓ testMetricsReset passed');
}

function testCreateMetricsMiddleware() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });

  const middleware = createMetricsMiddleware(collector);

  let reqPassed = false;
  let resEndCalled = false;

  const req = {
    method: 'GET',
    url: '/api/status',
    headers: {}
  };

  const res = {
    statusCode: 200,
    end: function() {
      resEndCalled = true;
    },
    getHeader: () => '0'
  };

  middleware(req, res, () => {
    reqPassed = true;
  });

  assert.ok(reqPassed);
  assert.ok(req.requestId);

  res.end();

  assert.ok(resEndCalled);
  collector.close();
  console.log('✓ testCreateMetricsMiddleware passed');
}

function testMiddlewareAddsRequestId() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });
  const middleware = createMetricsMiddleware(collector);

  const req = {
    method: 'GET',
    url: '/test',
    headers: {}
  };

  const res = {
    statusCode: 200,
    end: function() {},
    getHeader: () => '0'
  };

  middleware(req, res, () => {});

  assert.ok(req.requestId);
  assert.ok(req.requestId.startsWith('req_'));
  collector.close();
  console.log('✓ testMiddlewareAddsRequestId passed');
}

function testMiddlewareUsesExistingRequestId() {
  const collector = new MetricsCollector({ prefix: 'test', enabled: true });
  const middleware = createMetricsMiddleware(collector);

  const req = {
    method: 'GET',
    url: '/test',
    headers: { 'x-request-id': 'existing-id-123' }
  };

  const res = {
    statusCode: 200,
    end: function() {},
    getHeader: () => '0'
  };

  middleware(req, res, () => {});

  assert.strictEqual(req.requestId, 'existing-id-123');
  collector.close();
  console.log('✓ testMiddlewareUsesExistingRequestId passed');
}

function runAllTests() {
  console.log('\n=== Running Metrics Tests ===\n');

  testHistogramBuckets();
  testCounterCreation();
  testCounterInc();
  testCounterIncBy();
  testCounterWithLabels();
  testCounterGetAll();
  testCounterReset();
  testCounterPrometheusOutput();
  testGaugeCreation();
  testGaugeSet();
  testGaugeIncDec();
  testGaugeWithLabels();
  testGaugePrometheusOutput();
  testHistogramCreation();
  testHistogramObserve();
  testHistogramWithLabels();
  testHistogramPercentile();
  testHistogramReset();
  testHistogramPrometheusOutput();
  testMetricsCollectorCreation();
  testRecordHttpRequest();
  testSetActiveSessions();
  testSetActiveTasks();
  testRecordTaskStartComplete();
  testRecordError();
  testSetCdpConnection();
  testSetQueueSize();
  testNormalizePath();
  testGetMetrics();
  testToPrometheus();
  testToJson();
  testMetricsReset();
  testCreateMetricsMiddleware();
  testMiddlewareAddsRequestId();
  testMiddlewareUsesExistingRequestId();

  console.log('\n✓ All Metrics tests passed!\n');
}

if (require.main === module) {
  runAllTests();
}

module.exports = { runAllTests };
