import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  UserMemory,
  normalizeReason,
  MAX_INJECTED_PREFERENCES,
} from '../src/storage/userMemory';

suite('normalizeReason', () => {
  test('collapses whitespace, punctuation and leading verbs', () => {
    assert.strictEqual(normalizeReason('添加 None 保护'), normalizeReason('需要添加None检查'));
    assert.strictEqual(normalizeReason('添加 None 保护。'), normalizeReason('添加None保护'));
    assert.strictEqual(normalizeReason('改为使用上下文管理器'), normalizeReason('使用上下文管理器'));
  });

  test('keeps meaningful differences', () => {
    assert.notStrictEqual(normalizeReason('添加空值保护'), normalizeReason('删除空值保护'));
  });
});

suite('UserMemory', () => {
  let dir: string;
  let file: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errmem-'));
    file = path.join(dir, 'memory.json');
  });

  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('implicit learning: first observation is candidate, second promotes to active', () => {
    const memory = new UserMemory(file);
    memory.init();
    memory.recordAcceptedReasons(['添加 None 保护']);
    assert.strictEqual(memory.getAll().length, 1);
    assert.strictEqual(memory.getAll()[0].status, 'candidate');

    memory.recordAcceptedReasons(['需要添加None检查']);
    const promoted = memory.getAll()[0];
    assert.strictEqual(promoted.status, 'active');
    assert.strictEqual(promoted.hitCount, 2);
  });

  test('different reasons stay separate candidates', () => {
    const memory = new UserMemory(file);
    memory.init();
    memory.recordAcceptedReasons(['添加 None 保护', '提前返回并记录日志']);
    const entries = memory.getAll();
    assert.strictEqual(entries.length, 2);
    assert.ok(entries.every(e => e.status === 'candidate'));
  });

  test('confirmCandidate promotes an entry to active and injects it', () => {
    const memory = new UserMemory(file);
    memory.init();
    memory.recordAcceptedReasons(['添加 None 保护']);
    const candidate = memory.getAll()[0];
    assert.ok(memory.confirmCandidate(candidate.id));

    const block = memory.buildMemoryBlock(['fix'], { includeStats: false });
    assert.ok(block);
    assert.ok(block!.includes('## 用户记忆'));
    assert.ok(block!.includes('仅供参考'));
  });

  test('explicit entries are active and confidence 1.0', () => {
    const memory = new UserMemory(file);
    memory.init();
    memory.addExplicit('analysis', '根因分析请先给结论再展开');
    const entry = memory.getAll()[0];
    assert.strictEqual(entry.status, 'active');
    assert.strictEqual(entry.source, 'explicit');
    assert.strictEqual(entry.confidence, 1);
  });

  test('candidates are never injected; empty memory returns null', () => {
    const memory = new UserMemory(file);
    memory.init();
    assert.strictEqual(memory.buildMemoryBlock(['fix'], { includeStats: false }), null);

    memory.recordAcceptedReasons(['添加 None 保护']);
    assert.strictEqual(memory.buildMemoryBlock(['fix'], { includeStats: false }), null);
  });

  test('memory block routes categories and includes top error stats', () => {
    const memory = new UserMemory(file);
    memory.init();
    memory.addExplicit('fix', '只改根因，不做无关重构');
    memory.addExplicit('analysis', '先给结论再展开');
    memory.recordErrorStat('AttributeError');
    memory.recordErrorStat('AttributeError');
    memory.recordErrorStat('FileNotFoundError');

    const fixBlock = memory.buildMemoryBlock(['fix'], { includeStats: false });
    assert.ok(fixBlock!.includes('只改根因'));
    assert.ok(!fixBlock!.includes('先给结论'));
    assert.ok(!fixBlock!.includes('常犯错误'));

    const analysisBlock = memory.buildMemoryBlock(['analysis', 'fixSuggestion'], { includeStats: true });
    assert.ok(analysisBlock!.includes('先给结论'));
    assert.ok(analysisBlock!.includes('常犯错误'));
    assert.ok(analysisBlock!.includes('AttributeError（2 次）'));
  });

  test('persists across instances', () => {
    const a = new UserMemory(file);
    a.init();
    a.addExplicit('fix', '倾向于最小改动');

    const b = new UserMemory(file);
    b.init();
    assert.strictEqual(b.getAll().length, 1);
    assert.strictEqual(b.getAll()[0].statement, '倾向于最小改动');
  });

  test('caps injected preferences at MAX_INJECTED_PREFERENCES', () => {
    const memory = new UserMemory(file);
    memory.init();
    for (let i = 0; i < MAX_INJECTED_PREFERENCES + 10; i++) {
      memory.addExplicit('fix', `偏好 ${i}`);
    }
    const injected = memory.getInjectionPreferences(['fix']);
    assert.strictEqual(injected.length, MAX_INJECTED_PREFERENCES);
  });

  test('delete and clear', () => {
    const memory = new UserMemory(file);
    memory.init();
    const pref = memory.addExplicit('fix', '要删除');
    memory.recordErrorStat('KeyError');
    assert.ok(memory.deleteEntry(pref!.id));
    assert.strictEqual(memory.getAll().length, 0);
    assert.strictEqual(memory.getErrorStatsTop().length, 1);

    memory.addExplicit('fix', '再来一条');
    memory.clearAll();
    assert.strictEqual(memory.getAll().length, 0);
    assert.strictEqual(memory.getErrorStatsTop().length, 0);
  });
});
