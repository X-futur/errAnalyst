import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextBuilder } from '../src/context/contextBuilder';
import { computeAnchors, isProjectFile } from '../src/context/projectFiles';
import { sanitizeConfigText } from '../src/context/sanitize';
import type { ParsedTraceback } from '../src/parser';

function makeTraceback(overrides: Partial<ParsedTraceback> = {}): ParsedTraceback {
  return {
    errorType: 'AuthenticationError',
    errorMessage: '401 Unauthorized',
    filePath: '',
    lineNumber: 0,
    stackFrames: [],
    fullTraceback: '',
    chain: [],
    ...overrides,
  };
}

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'erranalyst-context-'));
}

function writeFile(dir: string, rel: string, content: string): string {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

suite('ContextBuilder — project-only context', () => {
  test('excludes system files even when they appear in the stack', () => {
    const ws = makeTempWorkspace();
    const mainPy = writeFile(ws, 'main.py', 'import openai\nprint("hi")\n');
    const sysFile = '/usr/local/lib/python3.12/site-packages/openai/api.py';

    const tb = makeTraceback({
      filePath: sysFile,
      lineNumber: 42,
      stackFrames: [
        { file: mainPy, line: 2, function: '<module>', codeLine: 'result = client.chat.completions.create(...)' },
        { file: sysFile, line: 42, function: 'create', codeLine: 'raise AuthenticationError()' },
      ],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.ok(!ctx.mainFile, 'a system last frame must not become the main file');
    assert.ok(ctx.stackFiles.some(f => f.path === mainPy));
    assert.ok(!ctx.stackFiles.some(f => f.path.includes('site-packages')));
    assert.ok(!ctx.configFiles.some(f => f.path.includes('site-packages')));
    assert.ok(!ctx.siblingFiles.some(f => f.path.includes('site-packages')));
    assert.ok(!ctx.guessedFiles.some(f => f.path.includes('site-packages')));
  });

  test('keeps last frame as mainFile when it is a project file', () => {
    const ws = makeTempWorkspace();
    const mainPy = writeFile(ws, 'main.py', 'x = 1 / 0\n');
    const tb = makeTraceback({
      errorType: 'ZeroDivisionError',
      filePath: mainPy,
      lineNumber: 1,
      stackFrames: [{ file: mainPy, line: 1, function: '<module>', codeLine: 'x = 1 / 0' }],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.ok(ctx.mainFile);
    assert.strictEqual(ctx.mainFile!.path, mainPy);
  });

  test('captures .env config with secret values redacted', () => {
    const ws = makeTempWorkspace();
    writeFile(ws, 'agent.py', 'import openai\n');
    const envPath = writeFile(
      ws,
      '.env',
      'OPENAI_API_KEY=sk-secret123\nBASE_URL=https://api.example.com\nOPENAI_API_KEY_EMPTY=\n',
    );
    const tb = makeTraceback({
      filePath: path.join(ws, 'agent.py'),
      lineNumber: 2,
      stackFrames: [{ file: path.join(ws, 'agent.py'), line: 2, function: '<module>' }],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    const env = ctx.configFiles.find(f => f.path === envPath);
    assert.ok(env, '.env should be in configFiles');
    assert.ok(env!.content.includes('OPENAI_API_KEY=(已配置)'));
    assert.ok(!env!.content.includes('sk-secret123'));
    assert.ok(env!.content.includes('BASE_URL=https://api.example.com'));
    assert.ok(env!.content.includes('OPENAI_API_KEY_EMPTY=(为空)'));
  });

  test('discovers config files referenced by project code', () => {
    const ws = makeTempWorkspace();
    const agentPy = writeFile(
      ws,
      'agent.py',
      'import json\ncfg = json.load(open("app_settings.json"))\n',
    );
    const settings = writeFile(
      ws,
      'app_settings.json',
      '{"token": "abc123", "url": "https://x.com"}\n',
    );
    const tb = makeTraceback({
      filePath: agentPy,
      lineNumber: 2,
      stackFrames: [{ file: agentPy, line: 2, function: '<module>' }],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    const found = ctx.configFiles.find(f => f.path === settings);
    assert.ok(found, 'referenced config file should be discovered');
    assert.ok(found!.content.includes('"token": "(已配置)"'));
    assert.ok(found!.content.includes('"url": "https://x.com"'));
  });

  test('guesses files importing the failing module when no project frames exist', () => {
    const ws = makeTempWorkspace();
    writeFile(ws, 'other.py', 'print("unrelated")\n');
    const agentPy = writeFile(ws, 'agent.py', 'import openai\nclient = openai.OpenAI()\n');
    const sysFile = '/usr/local/lib/python3.12/site-packages/openai/api.py';
    const tb = makeTraceback({
      filePath: sysFile,
      lineNumber: 10,
      stackFrames: [
        { file: sysFile, line: 10, function: 'create', codeLine: 'raise AuthenticationError()' },
      ],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.ok(
      ctx.guessedFiles.some(f => f.path === agentPy),
      'agent.py importing openai should be guessed',
    );
    assert.strictEqual(ctx.guessedFiles[0]?.path, agentPy, 'import match ranks first');
    assert.ok(ctx.guessedFiles.length <= 3, 'guessed files are capped');
  });

  test('falls back to entry files when nothing imports the failing module', () => {
    const ws = makeTempWorkspace();
    const mainPy = writeFile(ws, 'main.py', 'print("hello")\n');
    const tb = makeTraceback({
      errorMessage: "Cannot find module 'numpy'",
      filePath: '/usr/local/lib/python3.12/site-packages/numpy/core/overrides.py',
      lineNumber: 5,
      stackFrames: [
        { file: '/usr/local/lib/python3.12/site-packages/numpy/core/overrides.py', line: 5, function: 'array' },
      ],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.ok(ctx.guessedFiles.some(f => f.path === mainPy));
  });

  test('does not scan siblings from a system directory', () => {
    const ws = makeTempWorkspace();
    writeFile(ws, 'main.py', 'x = 1\n');
    const sysFile = '/usr/local/lib/python3.12/site-packages/somepkg/api.py';
    const tb = makeTraceback({
      filePath: sysFile,
      lineNumber: 1,
      stackFrames: [{ file: sysFile, line: 1, function: 'f' }],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.strictEqual(ctx.siblingFiles.length, 0);
  });
});

suite('projectFiles', () => {
  test('adds error file directory as fallback anchor when outside workspace', () => {
    const anchors = computeAnchors(['/ws'], '/tmp/foo.py');
    assert.ok(anchors.includes('/tmp'));
    assert.ok(isProjectFile('/tmp/foo.py', anchors));
    assert.ok(!isProjectFile('/usr/local/lib/python3.12/site-packages/x.py', anchors));
  });

  test('no fallback anchor when error file is inside a dependency directory', () => {
    const anchors = computeAnchors(['/ws'], '/usr/local/lib/python3.12/site-packages/x/y.py');
    assert.deepStrictEqual(anchors, ['/ws']);
  });

  test('dependency dirs inside the workspace are not project files', () => {
    const anchors = computeAnchors(['/ws']);
    assert.ok(!isProjectFile('/ws/node_modules/foo/index.js', anchors));
    assert.ok(!isProjectFile('/ws/.venv/lib/python3.12/site-packages/openai/api.py', anchors));
    assert.ok(isProjectFile('/ws/agent.py', anchors));
  });
});

suite('sanitizeConfigText', () => {
  test('redacts sensitive key values and keeps other values', () => {
    const out = sanitizeConfigText(
      'OPENAI_API_KEY=sk-123\nBASE_URL=https://api.example.com\nMY_SECRET=\nSECRET="abc"',
      '/p/.env',
    );
    assert.ok(out.includes('OPENAI_API_KEY=(已配置)'));
    assert.ok(out.includes('BASE_URL=https://api.example.com'));
    assert.ok(out.includes('MY_SECRET=(为空)'));
    assert.ok(out.includes('SECRET=(已配置)'));
    assert.ok(!out.includes('sk-123'));
  });

  test('redacts JSON secrets', () => {
    const out = sanitizeConfigText(
      '{"api_key": "sk-123", "base_url": "https://x.com", "api_key_empty": ""}',
      '/p/config.json',
    );
    assert.ok(out.includes('"api_key": "(已配置)"'));
    assert.ok(out.includes('"base_url": "https://x.com"'));
    assert.ok(out.includes('"api_key_empty": "(为空)"'));
  });

  test('redacts YAML secrets', () => {
    const out = sanitizeConfigText(
      'api_key: sk-123\nbase_url: https://x.com\n',
      '/p/config.yaml',
    );
    assert.ok(out.includes('api_key: (已配置)'));
    assert.ok(out.includes('base_url: https://x.com'));
  });
});
