"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const errorParser_1 = require("../src/errorParser");
suite('ErrorParser', () => {
    const workspaceFolders = ['/home/user/project'];
    test('parses ZeroDivisionError with traceback', () => {
        const tb = `Traceback (most recent call last):
  File "/home/user/project/main.py", line 10, in calculate
    result = a / b
ZeroDivisionError: division by zero`;
        const result = errorParser_1.ErrorParser.parse(tb, workspaceFolders);
        assert.ok(result, 'Should parse successfully');
        assert.strictEqual(result.errorType, 'ZeroDivisionError');
        assert.strictEqual(result.errorMessage, 'division by zero');
        assert.strictEqual(result.filePath, '/home/user/project/main.py');
        assert.strictEqual(result.lineNumber, 10);
        assert.strictEqual(result.stackFrames.length, 1);
        assert.strictEqual(result.stackFrames[0].codeLine, 'result = a / b');
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
        const result = errorParser_1.ErrorParser.parse(tb, workspaceFolders);
        assert.ok(result);
        assert.strictEqual(result.stackFrames.length, 3);
        assert.strictEqual(result.filePath, 'calc.py');
        assert.strictEqual(result.lineNumber, 8);
    });
    test('parses TypeError with arguments', () => {
        const tb = `Traceback (most recent call last):
  File "script.py", line 5, in <module>
    print(len(42))
TypeError: object of type 'int' has no len()`;
        const result = errorParser_1.ErrorParser.parse(tb, workspaceFolders);
        assert.ok(result);
        assert.strictEqual(result.errorType, 'TypeError');
        assert.strictEqual(result.errorMessage, "object of type 'int' has no len()");
    });
    test('parses ImportError', () => {
        const tb = `Traceback (most recent call last):
  File "main.py", line 1, in <module>
    import nonexistent_module
ModuleNotFoundError: No module named 'nonexistent_module'`;
        const result = errorParser_1.ErrorParser.parse(tb, workspaceFolders);
        assert.ok(result);
        assert.strictEqual(result.errorType, 'ModuleNotFoundError');
    });
    test('parses SyntaxError', () => {
        const tb = `  File "main.py", line 2
    print("hello"
         ^
SyntaxError: '(' was never closed`;
        const result = errorParser_1.ErrorParser.parse(tb, workspaceFolders);
        assert.ok(result);
        assert.strictEqual(result.errorType, 'SyntaxError');
    });
    test('returns null for non-error output', () => {
        const result = errorParser_1.ErrorParser.parse('Hello, world!', workspaceFolders);
        assert.strictEqual(result, null);
    });
    test('extractTraceback finds correct block', () => {
        const buffer = `$ python main.py
Traceback (most recent call last):
  File "main.py", line 10, in <module>
    print(1/0)
ZeroDivisionError: division by zero
$ `;
        const tb = errorParser_1.ErrorParser.extractErrorBlock(buffer);
        assert.ok(tb);
        assert.ok(tb.includes('Traceback'));
        assert.strictEqual(tb.includes('ZeroDivisionError'), true);
    });
    test('normalizeErrorKey works correctly', () => {
        const key = errorParser_1.ErrorParser.normalizeErrorKey('ZeroDivisionError', 'main.py');
        assert.strictEqual(key, 'zerodivisionerror:main.py');
    });
    test('identify_compilation_error', () => {
        const output = `src/app.ts:12:3 - error TS2345: Type 'string' is not assignable to type 'number'.

 12   const x: number = "hello";
       ~~~~~~~~~

Found 1 error.`;
        const id = errorParser_1.ErrorParser.identify(output);
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
        const id = errorParser_1.ErrorParser.identify(output);
        assert.strictEqual(id.category, 'DEPENDENCY_ERROR');
        assert.ok(id.actionPlan.includes('依赖'));
    });
    test('identify_system_error', () => {
        const output = `zsh: command not found: python
Did you mean: python3?`;
        const id = errorParser_1.ErrorParser.identify(output);
        assert.strictEqual(id.category, 'SYSTEM_ERROR');
        assert.ok(id.actionPlan.includes('环境'));
    });
    test('identify_runtime_error', () => {
        const output = `/Users/user/project/app.ts:15
  console.log(x);
              ^
ReferenceError: x is not defined
    at Object.<anonymous> (/Users/user/project/app.ts:15:13)`;
        const id = errorParser_1.ErrorParser.identify(output);
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
        const id = errorParser_1.ErrorParser.identify(output);
        assert.strictEqual(id.hasExitCode, true);
        assert.ok(id.category !== 'UNKNOWN');
    });
    test('identify_no_error', () => {
        const output = `Hello, world!
The quick brown fox jumps over the lazy dog.`;
        const id = errorParser_1.ErrorParser.identify(output);
        assert.strictEqual(id.category, 'UNKNOWN');
        assert.strictEqual(id.hasExitCode, false);
    });
});
//# sourceMappingURL=errorParser.test.js.map