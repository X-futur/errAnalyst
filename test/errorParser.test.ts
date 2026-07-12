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
    
    const tb = ErrorParser.extractErrorBlock(buffer);
    assert.ok(tb);
    assert.ok(tb!.includes('Traceback'));
    assert.strictEqual(tb!.includes('ZeroDivisionError'), true);
  });
  
  test('normalizeErrorKey works correctly', () => {
    const key = ErrorParser.normalizeErrorKey('ZeroDivisionError', 'main.py');
    assert.strictEqual(key, 'zerodivisionerror:main.py');
  });
  
  test('identify_compilation_error', () => {
    const output = `src/app.ts:12:3 - error TS2345: Type 'string' is not assignable to type 'number'.

 12   const x: number = "hello";
       ~~~~~~~~~

Found 1 error.`;
    const id = ErrorParser.identify(output);
    assert.strictEqual(id.category, 'COMPILATION_ERROR');
    assert.ok(id.actionPlan.includes('TypeScript'));
    assert.ok(typeof id.suggestion === 'string');
  });
  
  test('identify_dependency_error', () => {
    const output = `npm ERR! code ERESOLVE
npm ERR! ERESOLVE unable to resolve dependency tree
npm ERR!
npm ERR! While resolving: my-project@1.0.0
npm ERR! Found: react@18.0.0
npm ERR! Could not resolve dependency:
npm ERR! peer react@"^17.0.0" from react-dom@17.0.0`;
    const id = ErrorParser.identify(output);
    assert.strictEqual(id.category, 'DEPENDENCY_ERROR');
    assert.ok(id.actionPlan.includes('依赖'));
  });
  
  test('identify_system_error', () => {
    const output = `zsh: command not found: python
Did you mean: python3?`;
    const id = ErrorParser.identify(output);
    assert.strictEqual(id.category, 'SYSTEM_ERROR');
    assert.ok(id.actionPlan.includes('环境'));
  });
  
  test('identify_runtime_error', () => {
    const output = `/Users/user/project/app.ts:15
  console.log(x);
              ^
ReferenceError: x is not defined
    at Object.<anonymous> (/Users/user/project/app.ts:15:13)`;
    const id = ErrorParser.identify(output);
    assert.strictEqual(id.category, 'RUNTIME_ERROR');
    assert.ok(id.actionPlan.includes('变量'));
  });
  
  test('identify_exit_code', () => {
    const output = `$ node app.js
something happened
Error: something went wrong
    at main (app.js:10)
    at Object.<anonymous> (app.js:15)
Process exited with code 1`;
    const id = ErrorParser.identify(output);
    assert.strictEqual(id.hasExitCode, true);
    assert.ok(id.category !== 'UNKNOWN');
  });
  
  test('identify_no_error', () => {
    const output = `Hello, world!
The quick brown fox jumps over the lazy dog.`;
    const id = ErrorParser.identify(output);
    assert.strictEqual(id.category, 'UNKNOWN');
    assert.strictEqual(id.hasExitCode, false);
  });
});
