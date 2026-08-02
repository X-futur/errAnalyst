import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ChatSessionManager,
  MAX_HISTORY_MESSAGES,
} from '../src/chat/session';
import {
  ChatContextManager,
  MAX_FILE_CHARS,
  MAX_TOTAL_CHARS,
} from '../src/chat/contextFiles';
import { buildChatMessages } from '../src/chat/prompt';
import {
  buildChatFixPrompts,
  parseFixResponseWithReason,
} from '../src/fix/prompt';

const traceback = {
  errorType: 'ValueError',
  errorMessage: 'bad value',
  filePath: '/p/main.py',
  lineNumber: 3,
  stackFrames: [],
  fullTraceback: 'Traceback (most recent call last):\nValueError: bad value',
  chain: [],
};

suite('ChatPrompt', () => {
  test('builds system, context, history, and question messages', () => {
    const messages = buildChatMessages({
      traceback: traceback as any,
      analysisText: '分析结果',
      contextPayload: '### /p/main.py\n```\nx = 1\n```',
      history: [
        { id: '1', role: 'user', content: '为什么报错？', createdAt: 1 },
        { id: '2', role: 'assistant', content: '因为 x 为空。', createdAt: 2 },
      ],
      question: '具体是哪一行？',
    });
    assert.strictEqual(messages[0].role, 'system');
    assert.strictEqual(messages[1].role, 'user');
    assert.ok(messages[1].content.includes('## 当前报错'));
    assert.ok(messages[1].content.includes('## 对话上下文文件'));
    assert.strictEqual(messages[2].role, 'user');
    assert.strictEqual(messages[3].role, 'assistant');
    assert.strictEqual(messages[4].role, 'user');
    assert.strictEqual(messages[4].content, '具体是哪一行？');
  });

  test('ignores notice messages in LLM history', () => {
    const messages = buildChatMessages({
      traceback: traceback as any,
      analysisText: '',
      contextPayload: '',
      history: [
        { id: '1', role: 'notice', content: '更早消息已截断', createdAt: 1 },
        { id: '2', role: 'user', content: '继续', createdAt: 2 },
      ],
      question: '再解释一次',
    });
    assert.strictEqual(messages.length, 4);
    assert.strictEqual(messages[messages.length - 2].content, '继续');
  });
});

suite('ChatSession', () => {
  test('starts a fresh session per error', () => {
    const snapshots: any[] = [];
    const session = new ChatSessionManager(s => snapshots.push(s));
    session.startForError([{
      path: '/p/main.py',
      startLine: 1,
      endLine: 2,
      content: 'x\ny',
    }]);
    session.addUserMessage('为什么报错？');
    session.newSession();
    assert.strictEqual(session.snapshot().messages.length, 0);
    assert.strictEqual(session.snapshot().contextFiles.length, 1);
  });

  test('truncates history to the recent window', () => {
    const session = new ChatSessionManager(() => undefined);
    session.startForError([]);
    for (let i = 0; i < 30; i++) {
      session.addUserMessage('q' + i);
      session.appendAssistantMessage('a' + i);
    }
    const history = session.getLlmHistory();
    assert.ok(history.length <= MAX_HISTORY_MESSAGES);
    assert.strictEqual(history[history.length - 1].content, 'a29');
    assert.ok(session.snapshot().messages.some(m => m.role === 'notice'));
  });

  test('excludes the just-typed question from history', () => {
    const session = new ChatSessionManager(() => undefined);
    session.startForError([]);
    session.addUserMessage('q1');
    session.appendAssistantMessage('a1');
    session.addUserMessage('q2');
    assert.deepStrictEqual(
      session.getLlmHistory(true).map(m => m.content),
      ['q1', 'a1'],
    );
  });
});

suite('ChatContext', () => {
  let dir: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errchat-'));
  });

  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('rejects binary files', async () => {
    const file = path.join(dir, 'bin.dat');
    fs.writeFileSync(file, Buffer.from([0, 1, 2, 3]));
    const manager = new ChatContextManager();
    const results = await manager.addUserFiles([file]);
    assert.strictEqual(results[0].ok, false);
    assert.ok(results[0].error?.includes('二进制'));
  });

  test('truncates a single large file', async () => {
    const file = path.join(dir, 'big.txt');
    fs.writeFileSync(file, 'x'.repeat(MAX_FILE_CHARS + 100));
    const manager = new ChatContextManager();
    const results = await manager.addUserFiles([file]);
    assert.strictEqual(results[0].ok, true);
    const payload = manager.buildPayload();
    assert.strictEqual(payload.views[0].truncated, true);
    assert.ok(payload.payload.includes('已截断'));
  });

  test('skips files beyond the total budget', async () => {
    const manager = new ChatContextManager();
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    const c = path.join(dir, 'c.txt');
    fs.writeFileSync(a, 'a'.repeat(MAX_FILE_CHARS));
    fs.writeFileSync(b, 'b'.repeat(MAX_FILE_CHARS));
    fs.writeFileSync(c, 'c'.repeat(MAX_FILE_CHARS));
    await manager.addUserFiles([a, b, c]);
    const payload = manager.buildPayload();
    assert.strictEqual(payload.views.filter(v => !v.skipped).length, 2);
    assert.strictEqual(payload.views.filter(v => v.skipped).length, 1);
    assert.ok(MAX_FILE_CHARS * 3 > MAX_TOTAL_CHARS);
  });

  test('restoreDefaults removes user files', async () => {
    const main = path.join(dir, 'main.py');
    const extra = path.join(dir, 'extra.txt');
    fs.writeFileSync(main, 'x\ny');
    fs.writeFileSync(extra, 'hi');
    const manager = new ChatContextManager();
    manager.setAutoFiles([{
      path: main,
      startLine: 1,
      endLine: 2,
      content: 'x\ny',
    }]);
    await manager.addUserFiles([extra]);
    manager.restoreDefaults();
    const views = manager.getViews();
    assert.strictEqual(views.length, 1);
    assert.strictEqual(views[0].source, 'auto');
  });

  test('detects changed auto-loaded files', () => {
    const main = path.join(dir, 'main.py');
    fs.writeFileSync(main, 'x\ny\nz');
    const manager = new ChatContextManager();
    manager.setAutoFiles([{
      path: main,
      startLine: 1,
      endLine: 3,
      content: 'x\ny\nz',
    }]);
    assert.strictEqual(manager.buildPayload().views[0].changed, false);
    fs.writeFileSync(main, 'x\ny\nchanged');
    assert.strictEqual(manager.buildPayload().views[0].changed, true);
  });
});

suite('ChatFixPrompt', () => {
  test('includes conversation history in the patch prompt', () => {
    const prompts = buildChatFixPrompts(
      traceback as any,
      '分析',
      '### /p/main.py',
      [
        { role: 'user', content: '不要改 db.py' },
        { role: 'assistant', content: '好的，只改 main.py。' },
      ],
    );
    assert.ok(prompts.userPrompt.includes('Conversation History'));
    assert.ok(prompts.userPrompt.includes('不要改 db.py'));
  });

  test('parses empty changes with a reason', () => {
    const parsed = parseFixResponseWithReason(
      JSON.stringify({
        changes: [],
        reason: '数据库未配置，请检查 DATABASE_URL',
      }),
      ['/p/main.py'],
    );
    assert.deepStrictEqual(parsed.hunks, []);
    assert.strictEqual(parsed.reason, '数据库未配置，请检查 DATABASE_URL');
  });
});
