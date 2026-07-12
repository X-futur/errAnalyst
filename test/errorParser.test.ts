import * as assert from 'assert';
import { ErrorParser } from '../src/errorParser';

suite('ErrorParser', () => {
  const workspaceFolders = ['/home/user/project'];
  
  test('parses ZeroDivisionError with traceback', () => {
    const tb = `Traceback (most recent call last):
  File "/home/user/project/main.py", line 10, in calculate
    result = a / b
ZeroDivisionError: division by zero`;
    
    const result = ErrorParser.parse(tb, workspaceFolders);
    assert.ok(result, 'Should parse successfully');
    assert.strictEqual(result!.errorType, 'ZeroDivisionError');
    assert.strictEqual(result!.errorMessage, 'division by zero');
    assert.strictEqual(result!.filePath, '/home/user/project/main.py');
    assert.strictEqual(result!.lineNumber, 10);
    assert.strictEqual(result!.stackFrames.length, 1);
    assert.strictEqual(result!.stackFrames[0].codeLine, 'result = a / b');
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
    
    const result = ErrorParser.parse(tb, workspaceFolders);
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
    
    const result = ErrorParser.parse(tb, workspaceFolders);
    assert.ok(result);
    assert.strictEqual(result!.errorType, 'TypeError');
    assert.strictEqual(result!.errorMessage, "object of type 'int' has no len()");
  });
  
  test('parses ImportError', () => {
    const tb = `Traceback (most recent call last):
  File "main.py", line 1, in <module>
    import nonexistent_module
ModuleNotFoundError: No module named 'nonexistent_module'`;
    
    const result = ErrorParser.parse(tb, workspaceFolders);
    assert.ok(result);
    assert.strictEqual(result!.errorType, 'ModuleNotFoundError');
  });
  
  test('parses SyntaxError', () => {
    const tb = `  File "main.py", line 2
    print("hello"
         ^
SyntaxError: '(' was never closed`;
    
    const result = ErrorParser.parse(tb, workspaceFolders);
    assert.ok(result);
    assert.strictEqual(result!.errorType, 'SyntaxError');
  });
  
  test('returns null for non-error output', () => {
    const result = ErrorParser.parse('Hello, world!', workspaceFolders);
    assert.strictEqual(result, null);
  });
  
  test('extractTraceback finds correct block', () => {
    const buffer = `$ python main.py
Traceback (most recent call last):
  File "main.py", line 10, in <module>
    print(1/0)
ZeroDivisionError: division by zero
$ `;
    
    const tb = ErrorParser.extractTraceback(buffer);
    assert.ok(tb);
    assert.ok(tb!.includes('Traceback'));
    assert.strictEqual(tb!.includes('ZeroDivisionError'), true);
  });
  
  test('normalizeErrorKey works correctly', () => {
    const key = ErrorParser.normalizeErrorKey('ZeroDivisionError', 'main.py');
    assert.strictEqual(key, 'zerodivisionerror:main.py');
  });
});
