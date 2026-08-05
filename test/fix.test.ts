import * as assert from 'assert';
import { parseFixResponse } from '../src/fix/prompt';
import { diffLines, findLineRange, findLineRangeAt } from '../src/fix/validator';
import { buildAnalysisPrompts, sanitizeKeywords } from '../src/llmProvider/openaiCompatible';

suite('FixPrompt', () => {
  test('parses valid structured fix response', () => {
    const content = JSON.stringify({
      changes: [
        {
          file: '/p/main.py',
          reason: 'add none check',
          oldLines: ['result = query_db(user_id)'],
          newLines: [
            'result = query_db(user_id)',
            'if result is None:',
            '    result = {}',
          ],
        },
      ],
    });
    const hunks = parseFixResponse(content, ['/p/main.py', '/p/util.py']);
    assert.strictEqual(hunks.length, 1);
    assert.strictEqual(hunks[0].file, '/p/main.py');
    assert.strictEqual(hunks[0].newLines.length, 3);
  });

  test('skips files outside the allowed context', () => {
    const content = JSON.stringify({
      changes: [
        { file: '/p/other.py', reason: 'x', oldLines: ['a'], newLines: ['b'] },
        { file: '/p/main.py', reason: 'y', oldLines: ['a'], newLines: ['b'] },
      ],
    });
    const hunks = parseFixResponse(content, ['/p/main.py']);
    assert.strictEqual(hunks.length, 1);
    assert.strictEqual(hunks[0].file, '/p/main.py');
  });

  test('accepts relative path suffix match', () => {
    const content = JSON.stringify({
      changes: [{ file: 'main.py', reason: 'x', oldLines: ['a'], newLines: ['b'] }],
    });
    const hunks = parseFixResponse(content, ['/p/main.py']);
    assert.strictEqual(hunks.length, 1);
    assert.strictEqual(hunks[0].file, '/p/main.py');
  });

  test('caps at MAX_FIX_HUNKS', () => {
    const changes = Array.from({ length: 25 }, (_, i) => ({
      file: '/p/main.py',
      reason: `r${i}`,
      oldLines: [`line${i}`],
      newLines: [`new${i}`],
    }));
    const hunks = parseFixResponse(JSON.stringify({ changes }), ['/p/main.py']);
    assert.strictEqual(hunks.length, 20);
  });

  test('deduplicates identical hunks', () => {
    const content = JSON.stringify({
      changes: [
        { file: '/p/main.py', reason: 'a', oldLines: ['x'], newLines: ['y'] },
        { file: '/p/main.py', reason: 'b', oldLines: ['x'], newLines: ['y'] },
      ],
    });
    const hunks = parseFixResponse(content, ['/p/main.py']);
    assert.strictEqual(hunks.length, 1);
  });

  test('returns empty for malformed json', () => {
    assert.deepStrictEqual(parseFixResponse('not json', ['/p/main.py']), []);
  });

  test('keeps deletion hunks with empty newLines', () => {
    const content = JSON.stringify({
      changes: [{ file: '/p/main.py', reason: 'delete', oldLines: ['dead code'], newLines: [] }],
    });
    const hunks = parseFixResponse(content, ['/p/main.py']);
    assert.strictEqual(hunks.length, 1);
    assert.deepStrictEqual(hunks[0].newLines, []);
  });

  test('skips hunks without oldLines anchor', () => {
    const content = JSON.stringify({
      changes: [{ file: '/p/main.py', reason: 'bad', oldLines: [], newLines: ['x'] }],
    });
    assert.deepStrictEqual(parseFixResponse(content, ['/p/main.py']), []);
  });
});

suite('FixValidator', () => {
  test('finds exact line range', () => {
    const range = findLineRange(['a', 'b', 'c', 'd'], ['b', 'c']);
    assert.deepStrictEqual(range, { startLine: 1, endLine: 2 });
  });

  test('normalizes CR line endings', () => {
    assert.deepStrictEqual(findLineRange(['a\r', 'b\r'], ['a', 'b']), { startLine: 0, endLine: 1 });
  });

  test('returns null when target missing', () => {
    assert.strictEqual(findLineRange(['a', 'c'], ['b']), null);
  });

  test('matches target only at exact start line', () => {
    assert.deepStrictEqual(findLineRangeAt(['a', 'b', 'a', 'b'], ['a', 'b'], 0), { startLine: 0, endLine: 1 });
    assert.deepStrictEqual(findLineRangeAt(['a', 'b', 'a', 'b'], ['a', 'b'], 1), null);
  });

  test('diffs additions', () => {
    const diff = diffLines(['x'], ['x', 'y']);
    assert.deepStrictEqual(diff.removed, []);
    assert.deepStrictEqual(diff.added, [1]);
  });

  test('diffs deletions', () => {
    const diff = diffLines(['x', 'y'], ['x']);
    assert.deepStrictEqual(diff.removed, [1]);
    assert.deepStrictEqual(diff.added, []);
  });

  test('diffs replacement lines', () => {
    const diff = diffLines(['a', 'old'], ['a', 'new']);
    assert.deepStrictEqual(diff.removed, [1]);
    assert.deepStrictEqual(diff.added, [1]);
  });
});

suite('FixPromptDefense', () => {
  test('analysis prompt is non-empty even with malformed traceback fields', () => {
    const prompts = buildAnalysisPrompts(
      {
        errorType: '',
        errorMessage: '',
        filePath: '',
        lineNumber: 0,
        stackFrames: undefined,
        fullTraceback: undefined,
        chain: undefined,
      } as any,
      'UNKNOWN' as any,
    );
    assert.ok(prompts.userPrompt.length > 0);
    assert.ok(prompts.userPrompt.includes('## Original Traceback'));
  });
});

suite('CoreTermSanitizer', () => {
  test('caps at 3 keywords', () => {
    const keywords = [
      { cn: '一', en: 'one' },
      { cn: '二', en: 'two' },
      { cn: '三', en: 'three' },
      { cn: '四', en: 'four' },
    ];
    assert.strictEqual(sanitizeKeywords(keywords, 'one two three four').length, 3);
  });

  test('drops empty cn or en', () => {
    const keywords = [
      { cn: '', en: 'one' },
      { cn: '二', en: '' },
      { cn: '三', en: 'three' },
    ];
    assert.deepStrictEqual(sanitizeKeywords(keywords, 'three'), [{ cn: '三', en: 'three' }]);
  });

  test('dedupes case-insensitively', () => {
    const keywords = [
      { cn: '一', en: 'OptionalError' },
      { cn: '二', en: 'optionalerror' },
    ];
    assert.strictEqual(sanitizeKeywords(keywords, 'OptionalError').length, 1);
  });

  test('drops terms missing from the traceback', () => {
    const keywords = [
      { cn: '向量嵌入', en: 'embedding' },
      { cn: '状态码', en: 'status code' },
    ];
    const result = sanitizeKeywords(keywords, 'embedding dimension mismatch');
    assert.deepStrictEqual(result, [{ cn: '向量嵌入', en: 'embedding' }]);
  });

  test('returns empty for non-array input', () => {
    assert.deepStrictEqual(sanitizeKeywords(undefined, 'traceback'), []);
    assert.deepStrictEqual(sanitizeKeywords({} as any, 'traceback'), []);
  });
});

suite('TranslationPrompt', () => {
  test('requires natural Chinese translation and core-term keywords', () => {
    const prompts = buildAnalysisPrompts(
      {
        errorType: 'OptionalError',
        errorMessage: 'expected value but got none',
        filePath: '/p/main.py',
        lineNumber: 3,
        stackFrames: [],
        fullTraceback: 'OptionalError: expected value but got none',
        chain: [],
      },
      'UNKNOWN' as any,
    );
    assert.ok(prompts.systemPrompt.includes('必须译成中文'));
    assert.ok(prompts.systemPrompt.includes('最多 3 个'));
    assert.ok(prompts.userPrompt.includes('Translatable technical concepts MUST be translated into Chinese'));
    assert.ok(prompts.userPrompt.includes('Core error terms for this error, 0-3 items'));
    assert.ok(prompts.userPrompt.includes('Exclude generic English words/phrases'));
  });
});
