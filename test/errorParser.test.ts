import * as assert from 'assert';
import { PythonTracebackParser } from '../src/parser/pythonTraceback';
import { isKeyboardInterruptError } from '../src/terminalWatcher';

suite('PythonTracebackParser', () => {
  const workspaceFolders = ['/home/user/project'];

  test('parses ZeroDivisionError with traceback', () => {
    const tb = `Traceback (most recent call last):
  File "/home/user/project/main.py", line 10, in calculate
    result = a / b
ZeroDivisionError: division by zero`;

    const result = PythonTracebackParser.parse(tb, workspaceFolders);
    assert.ok(result, 'Should parse successfully');
    assert.strictEqual(result!.errorType, 'ZeroDivisionError');
    assert.strictEqual(result!.errorMessage, 'division by zero');
    assert.strictEqual(result!.filePath, '/home/user/project/main.py');
    assert.strictEqual(result!.lineNumber, 10);
    assert.strictEqual(result!.stackFrames.length, 1);
    assert.strictEqual(result!.stackFrames[0].codeLine, 'result = a / b');
    assert.strictEqual(result!.chain.length, 0);
  });

  test('parses multi-frame traceback', () => {
    const tb = `Traceback (most recent call last):
  File "app.py", line 15, in main
    result = process_data(x, y)
  File "utils.py", line 42, in process_data
    return calculate(data)
  File "calc.py", line 8, in calculate
    return a / b
ZeroDivisionError: division by zero`;

    const result = PythonTracebackParser.parse(tb, workspaceFolders);
    assert.ok(result);
    assert.strictEqual(result!.stackFrames.length, 3);
    assert.strictEqual(result!.filePath, 'calc.py');
    assert.strictEqual(result!.lineNumber, 8);
  });

  test('parses TypeError with arguments', () => {
    const tb = `Traceback (most recent call last):
  File "script.py", line 5, in <module>
    print(len(42))
TypeError: object of type 'int' has no len()`;

    const result = PythonTracebackParser.parse(tb, workspaceFolders);
    assert.ok(result);
    assert.strictEqual(result!.errorType, 'TypeError');
    assert.strictEqual(result!.errorMessage, "object of type 'int' has no len()");
  });

  test('parses ImportError', () => {
    const tb = `Traceback (most recent call last):
  File "main.py", line 1, in <module>
    import nonexistent_module
ModuleNotFoundError: No module named 'nonexistent_module'`;

    const result = PythonTracebackParser.parse(tb, workspaceFolders);
    assert.ok(result);
    assert.strictEqual(result!.errorType, 'ModuleNotFoundError');
  });

  test('parses SyntaxError without traceback header', () => {
    const tb = `  File "main.py", line 2
    print("hello"
         ^
SyntaxError: '(' was never closed`;

    const result = PythonTracebackParser.parse(tb, workspaceFolders);
    assert.ok(result);
    assert.strictEqual(result!.errorType, 'SyntaxError');
  });

  test('returns null for non-error output', () => {
    const result = PythonTracebackParser.parse('Hello, world!', workspaceFolders);
    assert.strictEqual(result, null);
  });

  test('extractErrorBlock finds correct block', () => {
    const buffer = `$ python main.py
Traceback (most recent call last):
  File "main.py", line 10, in <module>
    print(1/0)
ZeroDivisionError: division by zero
$ `;

    const tb = PythonTracebackParser.extractErrorBlock(buffer);
    assert.ok(tb);
    assert.ok(tb!.includes('Traceback'));
    assert.strictEqual(tb!.includes('ZeroDivisionError'), true);
  });

  test('parses chained exceptions', () => {
    const tb = `Traceback (most recent call last):
  File "db.py", line 10, in query_db
    return cursor.fetchone()
sqlite3.OperationalError: no such table: users

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "service.py", line 25, in get_user
    result = query_db(user_id)
    ^^^^^^^^^^^^^^^^^^^^^^^^^^
RuntimeError: Database query failed`;

    const result = PythonTracebackParser.parse(tb, workspaceFolders);
    assert.ok(result);
    // Primary exception
    assert.strictEqual(result!.errorType, 'RuntimeError');
    assert.strictEqual(result!.filePath, 'service.py');
    // Chain
    assert.strictEqual(result!.chain.length, 1);
    assert.strictEqual(result!.chain[0].errorType, 'sqlite3.OperationalError');
    assert.strictEqual(result!.chain[0].relationship, 'cause');
    assert.strictEqual(result!.chain[0].filePath, 'db.py');
    assert.strictEqual(result!.chain[0].lineNumber, 10);
  });

  test('normalizeErrorKey works correctly', () => {
    const key = PythonTracebackParser.normalizeErrorKey('ZeroDivisionError', 'main.py');
    assert.strictEqual(key, 'zerodivisionerror:main.py');
  });
});

suite('ManualStopFilter', () => {
  test('ignores KeyboardInterrupt error type', () => {
    assert.strictEqual(
      isKeyboardInterruptError({
        errorType: 'KeyboardInterrupt',
        errorMessage: '',
        filePath: '',
        lineNumber: 0,
        stackFrames: [],
        fullTraceback: '',
        chain: [],
      }),
      true,
    );
  });

  test('ignores parser fallback where KeyboardInterrupt is the message', () => {
    assert.strictEqual(
      isKeyboardInterruptError({
        errorType: 'Error',
        errorMessage: 'KeyboardInterrupt',
        filePath: '',
        lineNumber: 0,
        stackFrames: [],
        fullTraceback: '',
        chain: [],
      }),
      true,
    );
  });

  test('keeps other errors', () => {
    assert.strictEqual(
      isKeyboardInterruptError({
        errorType: 'ZeroDivisionError',
        errorMessage: 'division by zero',
        filePath: '/p/main.py',
        lineNumber: 3,
        stackFrames: [],
        fullTraceback: '',
        chain: [],
      }),
      false,
    );
  });
});
