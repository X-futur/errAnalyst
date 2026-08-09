import * as assert from 'assert';
import { highlightLines, languageForFile } from '../src/fix/syntax';

suite('SyntaxHighlight', () => {
  test('maps file extensions to languages', () => {
    assert.strictEqual(languageForFile('/p/main.py'), 'python');
    assert.strictEqual(languageForFile('/p/a.PYI'), 'python');
    assert.strictEqual(languageForFile('/p/app.js'), 'javascript');
    assert.strictEqual(languageForFile('/p/app.jsx'), 'javascript');
    assert.strictEqual(languageForFile('/p/app.ts'), 'typescript');
    assert.strictEqual(languageForFile('/p/app.tsx'), 'typescript');
    assert.strictEqual(languageForFile('/p/package.json'), 'json');
    assert.strictEqual(languageForFile('/p/settings.jsonc'), 'json');
    assert.strictEqual(languageForFile('/p/config.yaml'), 'yaml');
    assert.strictEqual(languageForFile('/p/config.yml'), 'yaml');
    assert.strictEqual(languageForFile('/p/deploy.sh'), 'bash');
    assert.strictEqual(languageForFile('/p/readme.md'), 'markdown');
    assert.strictEqual(languageForFile('/p/readme.markdown'), 'markdown');
    assert.strictEqual(languageForFile('/p/requirements.txt'), null);
    assert.strictEqual(languageForFile('/p/Makefile'), null);
  });

  test('preserves one output line per input line', () => {
    const code = ['def a():', '    return 1', '', 'def b():', '    return 2'].join('\n');
    assert.strictEqual(highlightLines(code, 'python').length, 5);
    assert.strictEqual(highlightLines('', 'python').length, 1);
    assert.strictEqual(highlightLines('a\nb', 'python').length, 2);
  });

  test('keeps cross-line triple-quoted strings wrapped on every line', () => {
    const code = 's = """multi\nline string"""';
    const lines = highlightLines(code, 'python');
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[0].includes('tok-string'));
    assert.ok(lines[1].includes('tok-string'));
  });

  test('aligns python tokens with VS Code default theme classes', () => {
    const code = [
      'def process(data):',
      '    if data is None:',
      '        raise ValueError("bad")',
      '    print(data)',
      '    return True',
      'class MyService:',
      '    pass',
      '    # comment',
      '    x = 42 + 3.14',
      '    from mod import thing',
      '    async def inner():',
      '        await x',
    ].join('\n');
    const lines = highlightLines(code, 'python');
    assert.ok(lines[0].includes('class="tok-kw"') && lines[0].includes('def'));
    assert.ok(lines[1].includes('class="tok-ctrl"') && lines[1].includes('if'));
    assert.ok(lines[1].includes('class="tok-kw"') && lines[1].includes('is'));
    assert.ok(lines[1].includes('class="tok-const"') && lines[1].includes('None'));
    assert.ok(lines[2].includes('class="tok-ctrl"') && lines[2].includes('raise'));
    assert.ok(lines[2].includes('class="tok-string"') && lines[2].includes('bad'));
    assert.ok(lines[3].includes('class="tok-builtin"') && lines[3].includes('print'));
    assert.ok(lines[4].includes('class="tok-const"') && lines[4].includes('True'));
    assert.ok(lines[5].includes('class="tok-kw"') && lines[5].includes('class'));
    assert.ok(lines[5].includes('class="tok-type"') && lines[5].includes('MyService'));
    assert.ok(lines[7].includes('class="tok-comment"'));
    assert.ok(lines[8].includes('class="tok-number"'));
    assert.ok(lines[9].includes('class="tok-ctrl"') && lines[9].includes('from'));
    assert.ok(lines[10].includes('class="tok-kw"') && lines[10].includes('async'));
    assert.ok(lines[10].includes('class="tok-fn"') && lines[10].includes('inner'));
    assert.ok(lines[11].includes('class="tok-ctrl"') && lines[11].includes('await'));
  });

  test('leaves operators as plain text', () => {
    const [line] = highlightLines('total = 1 + 2', 'python');
    assert.ok(!line.includes('class="tok-operator"'));
    assert.ok(line.includes('total'));
  });

  test('escapes html in plain text and tokens', () => {
    const [line] = highlightLines('a < b && c > d', 'python');
    assert.ok(line.includes('&lt;'));
    assert.ok(line.includes('&gt;'));
    assert.ok(line.includes('&amp;&amp;'));
  });

  test('applies control keyword classes for javascript and bash', () => {
    const js = highlightLines('if (x) { return y; } else { const z = true; }', 'javascript').join('');
    assert.ok(js.includes('class="tok-ctrl"'));
    assert.ok(js.includes('class="tok-kw"'));
    assert.ok(js.includes('class="tok-const"'));

    const bash = highlightLines('if [ -f x ]; then echo ok; fi', 'bash').join('');
    assert.ok(bash.includes('class="tok-ctrl"'));
  });

  test('colors json properties and booleans', () => {
    const json = highlightLines('{ "enabled": true, "count": 3 }', 'json').join('');
    assert.ok(json.includes('class="tok-var"'));
    assert.ok(json.includes('class="tok-const"'));
    assert.ok(json.includes('class="tok-number"'));
  });

  test('highlights imported function calls', () => {
    const code = [
      'result = query_db(user_id)',
      'path = os.path.join("a", "b")',
      'logging.error("failed")',
      'obj.method()',
    ].join('\n');
    const lines = highlightLines(code, 'python');
    assert.ok(lines[0].includes('class="tok-fn"') && lines[0].includes('query_db'));
    assert.ok(lines[1].includes('class="tok-fn"') && lines[1].includes('join'));
    assert.ok(lines[2].includes('class="tok-fn"') && lines[2].includes('error'));
    assert.ok(lines[3].includes('class="tok-fn"') && lines[3].includes('method'));
  });

  test('colors exception names and class instantiations as types', () => {
    const code = [
      'raise ValueError("bad") from None',
      'except (TypeError, KeyError) as exc:',
      'svc = MyService("demo")',
    ].join('\n');
    const lines = highlightLines(code, 'python');
    assert.ok(lines[0].includes('class="tok-type"') && lines[0].includes('ValueError'));
    assert.ok(lines[1].includes('class="tok-type"') && lines[1].includes('TypeError'));
    assert.ok(lines[1].includes('class="tok-type"') && lines[1].includes('KeyError'));
    assert.ok(lines[2].includes('class="tok-type"') && lines[2].includes('MyService'));
  });

  test('does not highlight calls inside strings or comments', () => {
    const code = [
      's = "query_db(x) not a call"',
      '# comment with foo(1) inside',
    ].join('\n');
    const lines = highlightLines(code, 'python');
    // The string line must not contain a tok-fn span around query_db.
    assert.ok(!/tok-fn[^>]*>.*query_db/.test(lines[0]));
    assert.ok(!lines[1].includes('tok-fn'));
    assert.ok(lines[0].includes('tok-string'));
    assert.ok(lines[1].includes('tok-comment'));
  });
});
