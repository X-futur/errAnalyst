import * as assert from 'assert';
import { parseFixResponse } from '../src/fix/prompt';
import { diffLines, findLineRange } from '../src/fix/validator';
import { buildAnalysisPrompts, sanitizeKeywords } from '../src/llmProvider/openaiCompatible';
import { buildFilePreview, buildFinalLines } from '../src/fix/preview';
import type { FixHunk, FixHunkStatus } from '../src/fix/types';

function mkHunk(id: string, oldLines: string[], newLines: string[], status: FixHunkStatus = 'pending'): FixHunk {
  return { id, file: '/p/main.py', reason: `reason-${id}`, oldLines, newLines, status };
}

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

suite('FixPreview', () => {
  test('pending replacement shows red old above green new with running line numbers', () => {
    const file = buildFilePreview(['a', 'b', 'c'], [mkHunk('h1', ['b'], ['B'])], '/p/main.py');
    const kinds = file.blocks.flatMap(b => b.lines.map(l => [l.kind, l.text, l.lineNo] as const));
    assert.deepStrictEqual(kinds, [
      ['context', 'a', 1],
      ['removed', 'b', 2],
      ['added', 'B', 3],
      ['context', 'c', 4],
    ]);
  });

  test('accepted replacement keeps green new and drops red old', () => {
    const file = buildFilePreview(['a', 'b', 'c'], [mkHunk('h1', ['b'], ['B'], 'accepted')], '/p/main.py');
    const kinds = file.blocks.flatMap(b => b.lines.map(l => [l.kind, l.text] as const));
    assert.deepStrictEqual(kinds, [
      ['context', 'a'],
      ['added', 'B'],
      ['context', 'c'],
    ]);
  });

  test('rejected replacement restores plain text', () => {
    const file = buildFilePreview(['a', 'b', 'c'], [mkHunk('h1', ['b'], ['B'], 'rejected')], '/p/main.py');
    const kinds = file.blocks.flatMap(b => b.lines.map(l => [l.kind, l.text] as const));
    assert.deepStrictEqual(kinds, [
      ['context', 'a'],
      ['context', 'b'],
      ['context', 'c'],
    ]);
  });

  test('insertion keeps the anchor as context and adds green lines', () => {
    const file = buildFilePreview(['x'], [mkHunk('h1', ['x'], ['x', 'y', 'z'])], '/p/main.py');
    const kinds = file.blocks.flatMap(b => b.lines.map(l => [l.kind, l.text, l.lineNo] as const));
    assert.deepStrictEqual(kinds, [
      ['context', 'x', 1],
      ['added', 'y', 2],
      ['added', 'z', 3],
    ]);
  });

  test('deletion marks all old lines red', () => {
    const file = buildFilePreview(['a', 'b', 'c'], [mkHunk('h1', ['b'], [])], '/p/main.py');
    const kinds = file.blocks.flatMap(b => b.lines.map(l => [l.kind, l.text] as const));
    assert.deepStrictEqual(kinds, [
      ['context', 'a'],
      ['removed', 'b'],
      ['context', 'c'],
    ]);
  });

  test('line numbers update when a hunk above is confirmed (sync)', () => {
    const tailNo = (status: FixHunkStatus) => {
      const file = buildFilePreview(['x', 'tail'], [mkHunk('h1', ['x'], ['Y'], status)], '/p/main.py');
      return file.blocks.flatMap(b => b.lines).find(l => l.text === 'tail')!.lineNo;
    };
    assert.strictEqual(tailNo('pending'), 3);  // removed x + added Y + tail
    assert.strictEqual(tailNo('accepted'), 2); // added Y + tail
    assert.strictEqual(tailNo('rejected'), 2); // context x + tail
  });

  test('buildFinalLines applies only accepted hunks in document order', () => {
    const orig = ['a', 'b', 'c', 'd'];
    const hunks = [
      mkHunk('h1', ['b'], ['B'], 'accepted'),
      mkHunk('h2', ['c'], ['C'], 'pending'),
      mkHunk('h3', ['d'], ['D'], 'rejected'),
    ];
    assert.deepStrictEqual(buildFinalLines(orig, hunks), ['a', 'B', 'c', 'd']);
  });

  test('buildFinalLines handles insertion and deletion', () => {
    const orig = ['x', 'y', 'z'];
    const hunks = [
      mkHunk('ins', ['x'], ['x', 'x1', 'x2'], 'accepted'),
      mkHunk('del', ['z'], [], 'accepted'),
    ];
    assert.deepStrictEqual(buildFinalLines(orig, hunks), ['x', 'x1', 'x2', 'y']);
  });

  test('overlapping hunks are skipped defensively', () => {
    const orig = ['a', 'b', 'c'];
    const hunks = [
      mkHunk('h1', ['a', 'b'], ['A', 'B'], 'accepted'),
      mkHunk('h2', ['b', 'c'], ['X'], 'accepted'),
    ];
    const preview = buildFilePreview(orig, hunks, '/p/main.py');
    const hunkIds = preview.blocks.map(b => b.hunkId).filter(Boolean);
    assert.deepStrictEqual(hunkIds, ['h1']);
    assert.deepStrictEqual(buildFinalLines(orig, hunks), ['A', 'B', 'c']);
  });

  test('multi-file preview keeps files separate', () => {
    const fileA = buildFilePreview(['a'], [mkHunk('h1', ['a'], ['A'])], '/p/a.py');
    const fileB = buildFilePreview(['b'], [mkHunk('h2', ['b'], ['B'])], '/p/b.py');
    assert.strictEqual(fileA.file, '/p/a.py');
    assert.strictEqual(fileB.file, '/p/b.py');
    assert.strictEqual(fileA.blocks[0].lines.length, 2);
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

  test('uses dictionary translation over LLM', () => {
    const result = sanitizeKeywords(
      [{ cn: '错误响应', en: 'ResponseError' }],
      'ResponseError: request failed',
    );
    assert.deepStrictEqual(result, [{ cn: '响应错误', en: 'ResponseError' }]);
  });

  test('fills missing cn from the dictionary', () => {
    const result = sanitizeKeywords(
      [{ cn: '', en: 'OptionalError' }],
      'OptionalError: expected value',
    );
    assert.deepStrictEqual(result, [{ cn: '可选值错误', en: 'OptionalError' }]);
  });

  test('drops terms whose cn equals en', () => {
    const result = sanitizeKeywords(
      [{ cn: 'sqlite3', en: 'sqlite3' }],
      'sqlite3.OperationalError: no such table',
    );
    assert.deepStrictEqual(result, []);
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
    assert.ok(prompts.systemPrompt.includes('ResponseError → 响应错误'));
    assert.ok(prompts.systemPrompt.includes('OptionalError → 可选值错误'));
    assert.ok(prompts.userPrompt.includes('Translatable technical concepts MUST be translated into Chinese'));
    assert.ok(prompts.userPrompt.includes('Core error terms for this error, 0-3 items'));
    assert.ok(prompts.userPrompt.includes('Exclude generic English words/phrases'));
  });
});
