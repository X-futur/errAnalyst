import * as assert from 'assert';
import { PythonTracebackParser } from '../src/parser/pythonTraceback';
import {
  detectStreamTier,
  extractLogError,
  getCooldownMs,
  isStreamStructuredEligible,
  normalizeLogMessage,
} from '../src/terminalStream';

suite('TerminalStream（流式触发）', () => {
  test('detectStreamTier: Python Traceback 头部 → structured', () => {
    assert.strictEqual(detectStreamTier('Traceback (most recent call last):\n'), 'structured');
    assert.strictEqual(detectStreamTier('  Traceback (most recent call last):'), 'structured');
  });

  test('detectStreamTier: 具体错误类型行 → structured', () => {
    assert.strictEqual(detectStreamTier('TypeError: object of type ...'), 'structured');
    assert.strictEqual(detectStreamTier('ModuleNotFoundError: No module named x'), 'structured');
    assert.strictEqual(detectStreamTier('ValueError: bad value'), 'structured');
  });

  test('detectStreamTier: ERROR 级日志 → log-line', () => {
    assert.strictEqual(detectStreamTier('ERROR:root:Connection refused'), 'log-line');
    assert.strictEqual(detectStreamTier('[ERROR] Failed to start server'), 'log-line');
    assert.strictEqual(detectStreamTier('2026-08-15 20:00:01 ERROR: boom'), 'log-line');
    assert.strictEqual(detectStreamTier('CRITICAL: out of memory'), 'log-line');
  });

  test('detectStreamTier: WARNING/INFO/普通输出 → null', () => {
    assert.strictEqual(detectStreamTier('WARNING: something'), null);
    assert.strictEqual(detectStreamTier('INFO: started'), null);
    assert.strictEqual(detectStreamTier('GET / 200 OK'), null);
    assert.strictEqual(detectStreamTier(''), null);
  });

  test('extractLogError: 提取最近 ERROR 行并剥离 logger 名', () => {
    const buffer = 'INFO: started\nERROR:root:Connection refused\n';
    const log = extractLogError(buffer);
    assert.ok(log, 'Should extract log error');
    assert.strictEqual(log!.errorType, 'RuntimeLog');
    assert.strictEqual(log!.errorMessage, 'Connection refused');
  });

  test('extractLogError: uvicorn 风格', () => {
    const log = extractLogError('ERROR:    Exception in ASGI application');
    assert.ok(log);
    assert.strictEqual(log!.errorMessage, 'Exception in ASGI application');
  });

  test('extractLogError: 无错误日志 → null；空消息跳过', () => {
    assert.strictEqual(extractLogError('INFO: all good\nWARNING: meh'), null);
    assert.strictEqual(extractLogError('ERROR:'), null);
  });

  test('normalizeLogMessage: 剥离时间戳', () => {
    assert.strictEqual(
      normalizeLogMessage('[2026-08-15 20:00:00] Connection refused'),
      'Connection refused',
    );
    assert.strictEqual(
      normalizeLogMessage('2026-08-15 20:00:00 Connection refused'),
      'Connection refused',
    );
  });

  test('getCooldownMs: 分档冷却时长', () => {
    assert.strictEqual(getCooldownMs('structured'), 10000);
    assert.strictEqual(getCooldownMs('log-line'), 60000);
  });

  test('isStreamStructuredEligible: 有栈帧即合格', () => {
    const tb = `Traceback (most recent call last):
  File "main.py", line 10, in <module>
    a / b
ZeroDivisionError: division by zero`;
    const parsed = PythonTracebackParser.parse(tb, ['/home/user/project']);
    assert.ok(parsed);
    assert.strictEqual(isStreamStructuredEligible(parsed!), true);
  });

  test('isStreamStructuredEligible: 无栈帧时排除通用 Error', () => {
    assert.strictEqual(isStreamStructuredEligible({
      errorType: 'ModuleNotFoundError',
      errorMessage: "No module named 'x'",
      filePath: '',
      lineNumber: 0,
      stackFrames: [],
      fullTraceback: "ModuleNotFoundError: No module named 'x'",
      chain: [],
    }), true);
    assert.strictEqual(isStreamStructuredEligible({
      errorType: 'Error',
      errorMessage: 'boom',
      filePath: '',
      lineNumber: 0,
      stackFrames: [],
      fullTraceback: 'Error: boom',
      chain: [],
    }), false);
  });
});
