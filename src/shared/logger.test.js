'use strict';

const assert = require('assert');
const { Logger, sanitizeLog, formatJson, formatText, LOG_LEVELS } = require('./logger');

function testLogLevels() {
  assert.strictEqual(LOG_LEVELS.debug, 0);
  assert.strictEqual(LOG_LEVELS.info, 1);
  assert.strictEqual(LOG_LEVELS.warn, 2);
  assert.strictEqual(LOG_LEVELS.error, 3);
  console.log('✓ testLogLevels passed');
}

function testSanitizeLog() {
  const input = {
    username: 'john',
    password: 'secret123',
    token: 'abc123',
    data: {
      apiSecret: 'key123',
      name: 'test'
    }
  };
  const result = sanitizeLog(input);
  assert.strictEqual(result.username, 'john');
  assert.strictEqual(result.password, '[REDACTED]');
  assert.strictEqual(result.token, '[REDACTED]');
  assert.strictEqual(result.data.apiSecret, '[REDACTED]');
  assert.strictEqual(result.data.name, 'test');
  console.log('✓ testSanitizeLog passed');
}

function testSanitizeLogNonObject() {
  assert.strictEqual(sanitizeLog(null), null);
  assert.strictEqual(sanitizeLog(undefined), undefined);
  assert.strictEqual(sanitizeLog('string'), 'string');
  assert.strictEqual(sanitizeLog(123), 123);
  assert.strictEqual(sanitizeLog(true), true);
  console.log('✓ testSanitizeLogNonObject passed');
}

function testSanitizeLogArray() {
  const input = [
    { name: 'test', password: 'secret' },
    { apiSecret: 'abc' }
  ];
  const result = sanitizeLog(input);
  assert.strictEqual(result[0].name, 'test');
  assert.strictEqual(result[0].password, '[REDACTED]');
  assert.strictEqual(result[1].apiSecret, '[REDACTED]');
  console.log('✓ testSanitizeLogArray passed');
}

function testSanitizeLogCaseInsensitive() {
  const input = {
    PASSWORD: 'secret',
    Token: 'abc',
    AUTHTOKEN: 'xyz'
  };
  const result = sanitizeLog(input);
  assert.strictEqual(result.PASSWORD, '[REDACTED]');
  assert.strictEqual(result.Token, '[REDACTED]');
  assert.strictEqual(result.AUTHTOKEN, '[REDACTED]');
  console.log('✓ testSanitizeLogCaseInsensitive passed');
}

function testFormatJson() {
  const entry = {
    timestamp: '2025-01-01T00:00:00.000Z',
    level: 'info',
    message: 'test message',
    requestId: 'req123'
  };
  const result = formatJson(entry);
  const parsed = JSON.parse(result);
  assert.strictEqual(parsed.level, 'info');
  assert.strictEqual(parsed.message, 'test message');
  assert.strictEqual(parsed.requestId, 'req123');
  console.log('✓ testFormatJson passed');
}

function testFormatText() {
  const entry = {
    timestamp: '2025-01-01T00:00:00.000Z',
    level: 'info',
    message: 'test message',
    requestId: 'req123',
    sessionId: 'sess456',
    duration: 100
  };
  const result = formatText(entry);
  assert.ok(result.includes('[INFO]'));
  assert.ok(result.includes('test message'));
  assert.ok(result.includes('requestId=req123'));
  assert.ok(result.includes('sessionId=sess456'));
  assert.ok(result.includes('duration=100ms'));
  console.log('✓ testFormatText passed');
}

function testFormatTextMetadata() {
  const entry = {
    timestamp: '2025-01-01T00:00:00.000Z',
    level: 'warn',
    message: 'warning',
    metadata: { code: 'W001', count: 5 }
  };
  const result = formatText(entry);
  assert.ok(result.includes('{"code":"W001","count":5}'));
  console.log('✓ testFormatTextMetadata passed');
}

function testLoggerCreation() {
  const logger = new Logger({
    enableConsole: false,
    enableFile: false
  });
  assert.ok(logger);
  assert.strictEqual(logger.level, LOG_LEVELS.info);
  logger.close();
  console.log('✓ testLoggerCreation passed');
}

function testLoggerCustomLevel() {
  const logger = new Logger({ levelName: 'debug' });
  logger.level = LOG_LEVELS.debug;
  assert.strictEqual(logger.level, LOG_LEVELS.debug);
  logger.close();
  console.log('✓ testLoggerCustomLevel passed');
}

function testShouldLog() {
  const logger = new Logger({ enableConsole: false, enableFile: false });
  logger.level = LOG_LEVELS.info;
  assert.strictEqual(logger._shouldLog('debug'), false);
  assert.strictEqual(logger._shouldLog('info'), true);
  assert.strictEqual(logger._shouldLog('warn'), true);
  assert.strictEqual(logger._shouldLog('error'), true);
  logger.close();
  console.log('✓ testShouldLog passed');
}

function testCreateLogEntry() {
  const logger = new Logger({ enableConsole: false, enableFile: false });
  logger.level = LOG_LEVELS.info;

  const entry = logger._createLogEntry('info', 'test message', {
    requestId: 'req123',
    sessionId: 'sess456',
    duration: 50,
    metadata: { key: 'value' }
  });

  assert.strictEqual(entry.level, 'info');
  assert.strictEqual(entry.message, 'test message');
  assert.strictEqual(entry.requestId, 'req123');
  assert.strictEqual(entry.sessionId, 'sess456');
  assert.strictEqual(entry.duration, 50);
  assert.deepStrictEqual(entry.metadata, { key: 'value' });
  assert.ok(entry.timestamp);
  logger.close();
  console.log('✓ testCreateLogEntry passed');
}

function testCreateLogEntryWithError() {
  const logger = new Logger({ enableConsole: false, enableFile: false });
  logger.level = LOG_LEVELS.info;

  const error = new Error('test error');
  error.name = 'TestError';

  const entry = logger._createLogEntry('error', 'error occurred', {
    error
  });

  assert.strictEqual(entry.error.name, 'TestError');
  assert.strictEqual(entry.error.message, 'test error');
  assert.ok(entry.error.stack);
  logger.close();
  console.log('✓ testCreateLogEntryWithError passed');
}

function testRequestContext() {
  const logger = new Logger({ enableConsole: false, enableFile: false });

  logger.setRequestContext('req1', { sessionId: 'sess1', userId: 'user1' });
  const ctx = logger.getRequestContext('req1');
  assert.strictEqual(ctx.sessionId, 'sess1');
  assert.strictEqual(ctx.userId, 'user1');

  logger.clearRequestContext('req1');
  assert.strictEqual(logger.getRequestContext('req1'), undefined);
  logger.close();
  console.log('✓ testRequestContext passed');
}

function testCreateRequestLogger() {
  const originalFormat = process.env.TRAECN_LOG_FORMAT;
  try {
    process.env.TRAECN_LOG_FORMAT = 'text';
    const logger = new Logger({ enableConsole: true, enableFile: false });
    logger.level = LOG_LEVELS.debug;

    let loggedMessages = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (msg) => {
      loggedMessages.push(msg);
      return true;
    };

    const reqLogger = logger.createRequestLogger('req123', 'sess456');
    reqLogger.info('test info');

    process.stdout.write = originalWrite;

    const hasReqId = loggedMessages.some(m => m.includes('req123'));
    const hasSessId = loggedMessages.some(m => m.includes('sess456'));
    assert.ok(hasReqId, `Expected req123 in messages, got: ${JSON.stringify(loggedMessages)}`);
    assert.ok(hasSessId, `Expected sess456 in messages, got: ${JSON.stringify(loggedMessages)}`);
    logger.close();
    console.log('✓ testCreateRequestLogger passed');
  } finally {
    if (originalFormat !== undefined) {
      process.env.TRAECN_LOG_FORMAT = originalFormat;
    } else {
      delete process.env.TRAECN_LOG_FORMAT;
    }
  }
}

function testLogEntryWithSanitizedMetadata() {
  const originalFormat = process.env.TRAECN_LOG_FORMAT;
  try {
    process.env.TRAECN_LOG_FORMAT = 'json';
    const logger = new Logger({ enableConsole: true, enableFile: false });
    logger.level = LOG_LEVELS.info;

    let logEntry;
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (msg) => {
      logEntry = JSON.parse(msg.trim());
      return true;
    };

    logger.info('test', {
      metadata: {
        user: 'john',
        password: 'secret',
        nested: { apiSecret: 'abc' }
      }
    });

    process.stdout.write = originalWrite;

    assert.ok(logEntry, 'logEntry should be defined');
    assert.strictEqual(logEntry.metadata.user, 'john');
    assert.strictEqual(logEntry.metadata.password, '[REDACTED]');
    assert.strictEqual(logEntry.metadata.nested.apiSecret, '[REDACTED]');
    logger.close();
    console.log('✓ testLogEntryWithSanitizedMetadata passed');
  } finally {
    if (originalFormat !== undefined) {
      process.env.TRAECN_LOG_FORMAT = originalFormat;
    } else {
      delete process.env.TRAECN_LOG_FORMAT;
    }
  }
}

function testDefaultLogFormat() {
  const logger = new Logger({ enableConsole: false, enableFile: false });
  assert.strictEqual(logger.format, 'json');
  logger.close();
  console.log('✓ testDefaultLogFormat passed');
}

function testLogMethodsDoNotThrow() {
  const logger = new Logger({ enableConsole: false, enableFile: false });
  logger.level = LOG_LEVELS.debug;

  assert.doesNotThrow(() => logger.debug('debug message'));
  assert.doesNotThrow(() => logger.info('info message'));
  assert.doesNotThrow(() => logger.warn('warn message'));
  assert.doesNotThrow(() => logger.error('error message'));

  logger.close();
  console.log('✓ testLogMethodsDoNotThrow passed');
}

function testMultipleLogEntries() {
  const originalFormat = process.env.TRAECN_LOG_FORMAT;
  try {
    process.env.TRAECN_LOG_FORMAT = 'json';
    const logger = new Logger({ enableConsole: true, enableFile: false });
    logger.level = LOG_LEVELS.info;

    let count = 0;
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => {
      count++;
      return true;
    };

    logger.info('message 1');
    logger.info('message 2');
    logger.info('message 3');

    process.stdout.write = originalWrite;
    assert.strictEqual(count, 3);
    logger.close();
    console.log('✓ testMultipleLogEntries passed');
  } finally {
    if (originalFormat !== undefined) {
      process.env.TRAECN_LOG_FORMAT = originalFormat;
    } else {
      delete process.env.TRAECN_LOG_FORMAT;
    }
  }
}

function testMetadataExcludedWhenEmpty() {
  const originalFormat = process.env.TRAECN_LOG_FORMAT;
  try {
    process.env.TRAECN_LOG_FORMAT = 'json';
    const logger = new Logger({ enableConsole: true, enableFile: false });
    logger.level = LOG_LEVELS.info;

    let logEntry;
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (msg) => {
      logEntry = JSON.parse(msg.trim());
      return true;
    };

    logger.info('no metadata');

    process.stdout.write = originalWrite;

    assert.ok(logEntry, 'logEntry should be defined');
    assert.strictEqual(logEntry.metadata, undefined);
    logger.close();
    console.log('✓ testMetadataExcludedWhenEmpty passed');
  } finally {
    if (originalFormat !== undefined) {
      process.env.TRAECN_LOG_FORMAT = originalFormat;
    } else {
      delete process.env.TRAECN_LOG_FORMAT;
    }
  }
}

function runAllTests() {
  console.log('\n=== Running Logger Tests ===\n');

  testLogLevels();
  testSanitizeLog();
  testSanitizeLogNonObject();
  testSanitizeLogArray();
  testSanitizeLogCaseInsensitive();
  testFormatJson();
  testFormatText();
  testFormatTextMetadata();
  testLoggerCreation();
  testLoggerCustomLevel();
  testShouldLog();
  testCreateLogEntry();
  testCreateLogEntryWithError();
  testRequestContext();
  testCreateRequestLogger();
  testLogEntryWithSanitizedMetadata();
  testDefaultLogFormat();
  testLogMethodsDoNotThrow();
  testMultipleLogEntries();
  testMetadataExcludedWhenEmpty();

  console.log('\n✓ All Logger tests passed!\n');
}

if (require.main === module) {
  runAllTests();
}

module.exports = { runAllTests };
