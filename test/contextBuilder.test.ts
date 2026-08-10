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
    assert.ok(ctx.runningFile, 'the entry script becomes the running file');
    assert.strictEqual(ctx.runningFile!.path, mainPy);
    assert.ok(!ctx.stackFiles.some(f => f.path === mainPy));
    assert.ok(!ctx.stackFiles.some(f => f.path.includes('site-packages')));
    assert.ok(!ctx.configFiles.some(f => f.path.includes('site-packages')));
    assert.ok(!ctx.siblingFiles.some(f => f.path.includes('site-packages')));
    assert.ok(!ctx.guessedFiles.some(f => f.path.includes('site-packages')));
  });

  test('captures a single-frame script error as the running file in full', () => {
    const ws = makeTempWorkspace();
    const mainPy = writeFile(ws, 'main.py', 'x = 1 / 0\n');
    const tb = makeTraceback({
      errorType: 'ZeroDivisionError',
      filePath: mainPy,
      lineNumber: 1,
      stackFrames: [{ file: mainPy, line: 1, function: '<module>', codeLine: 'x = 1 / 0' }],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.ok(ctx.runningFile);
    assert.strictEqual(ctx.runningFile!.path, mainPy);
    assert.strictEqual(ctx.runningFile!.content, 'x = 1 / 0\n');
    assert.strictEqual(ctx.mainFile, undefined, 'no duplicate main-file entry');
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

suite('ContextBuilder — running file full capture', () => {
  function makeLines(prefix: string, count: number): string {
    return Array.from({ length: count }, (_, i) => `${prefix}_line_${i + 1}`).join('\n');
  }

  test('captures the entry script in full from the command line', () => {
    const ws = makeTempWorkspace();
    const mainPy = writeFile(ws, 'main.py', makeLines('m', 25));
    const utilPy = writeFile(ws, 'util.py', makeLines('u', 15));
    const tb = makeTraceback({
      commandLine: 'python main.py',
      filePath: utilPy,
      lineNumber: 8,
      stackFrames: [
        { file: mainPy, line: 3, function: '<module>', codeLine: 'result = util.compute()' },
        { file: utilPy, line: 8, function: 'compute', codeLine: 'raise ValueError()' },
      ],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.ok(ctx.runningFile, 'running file should be captured');
    assert.strictEqual(ctx.runningFile!.path, mainPy);
    assert.strictEqual(ctx.runningFile!.source, 'running_file');
    assert.strictEqual(ctx.runningFile!.startLine, 1);
    assert.strictEqual(ctx.runningFile!.endLine, 25);
    assert.ok(ctx.runningFile!.content.includes('m_line_25'));
    assert.strictEqual(ctx.mainFile?.path, utilPy, 'error file keeps its own window');
  });

  test('falls back to the first stack frame without a command line', () => {
    const ws = makeTempWorkspace();
    const mainPy = writeFile(ws, 'main.py', makeLines('m', 5));
    const tb = makeTraceback({
      filePath: mainPy,
      lineNumber: 4,
      stackFrames: [{ file: mainPy, line: 4, function: '<module>', codeLine: 'raise ValueError()' }],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.ok(ctx.runningFile);
    assert.strictEqual(ctx.runningFile!.path, mainPy);
    assert.strictEqual(ctx.runningFile!.endLine, 5);
  });

  test('running file is exempt from the total char budget', () => {
    const ws = makeTempWorkspace();
    const mainPy = writeFile(ws, 'main.py', makeLines('m', 1200));
    const utilPy = writeFile(ws, 'util.py', makeLines('u', 5));
    const tb = makeTraceback({
      commandLine: 'python main.py',
      filePath: utilPy,
      lineNumber: 3,
      stackFrames: [
        { file: mainPy, line: 3, function: '<module>', codeLine: 'util.compute()' },
        { file: utilPy, line: 3, function: 'compute', codeLine: 'raise ValueError()' },
      ],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.ok(ctx.runningFile);
    assert.ok(ctx.runningFile!.content.length > 7000, 'full content must exceed the old budget');
    assert.ok(ctx.runningFile!.content.includes('m_line_1200'));
    assert.strictEqual(ctx.mainFile, undefined, 'remaining budget is zero, no other files fit');
    assert.strictEqual(ctx.stackFiles.length, 0);
  });

  test('single-file script error: running file replaces the main slot without duplicates', () => {
    const ws = makeTempWorkspace();
    const mainPy = writeFile(ws, 'main.py', makeLines('m', 30));
    const tb = makeTraceback({
      commandLine: 'python main.py',
      filePath: mainPy,
      lineNumber: 20,
      stackFrames: [{ file: mainPy, line: 20, function: '<module>', codeLine: 'raise ValueError()' }],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.ok(ctx.runningFile);
    assert.strictEqual(ctx.runningFile!.path, mainPy);
    assert.strictEqual(ctx.runningFile!.content.split('\n').length, 30);
    assert.strictEqual(ctx.mainFile, undefined);
    assert.strictEqual(ctx.stackFiles.length, 0);
  });

  test('module invocation (-m) falls back to the first frame', () => {
    const ws = makeTempWorkspace();
    const cliPy = writeFile(ws, 'pkg/cli.py', makeLines('c', 10));
    const tb = makeTraceback({
      commandLine: 'python -m pkg.cli',
      filePath: cliPy,
      lineNumber: 7,
      stackFrames: [{ file: cliPy, line: 7, function: '<module>', codeLine: 'raise ValueError()' }],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.ok(ctx.runningFile);
    assert.strictEqual(ctx.runningFile!.path, cliPy);
  });

  test('cd-prefixed command resolves against the cd target and extends anchors', () => {
    const ws = makeTempWorkspace();
    const outside = makeTempWorkspace();
    const mainPy = writeFile(outside, 'main.py', makeLines('x', 8));
    const utilPy = writeFile(ws, 'util.py', 'raise ValueError()\n');
    const tb = makeTraceback({
      commandLine: `cd ${outside} && python main.py`,
      filePath: utilPy,
      lineNumber: 1,
      stackFrames: [
        { file: mainPy, line: 5, function: '<module>', codeLine: 'util.compute()' },
        { file: utilPy, line: 1, function: 'compute', codeLine: 'raise ValueError()' },
      ],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.ok(ctx.runningFile, 'running file outside the workspace must be captured');
    assert.strictEqual(ctx.runningFile!.path, mainPy);
    assert.ok(ctx.anchors.includes(outside), 'running file dir must become a temp anchor');
  });

  test('excludes a running file inside a dependency directory', () => {
    const ws = makeTempWorkspace();
    const dep = writeFile(ws, 'node_modules/cli/index.js', 'throw new Error()\n');
    const tb = makeTraceback({
      commandLine: `node ${dep}`,
      filePath: dep,
      lineNumber: 1,
      stackFrames: [{ file: dep, line: 1, function: '<anonymous>', codeLine: 'throw new Error()' }],
    });

    const ctx = new ContextBuilder().build(tb, [ws]);
    assert.strictEqual(ctx.runningFile, undefined);
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
