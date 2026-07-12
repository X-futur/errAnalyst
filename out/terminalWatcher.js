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
exports.TerminalWatcher = void 0;
const vscode = __importStar(require("vscode"));
const errorParser_1 = require("./errorParser");
class TerminalWatcher {
    constructor(onErrorDetected) {
        this.disposables = [];
        this.lastErrorKey = '';
        this.lastErrorTime = 0;
        this.lastTraceback = '';
        this.DEBOUNCE_MS = 3000;
        this.MAX_BUFFER_SIZE = 100 * 1024;
        this.onErrorDetected = onErrorDetected;
    }
    activate() {
        this.disposables.push(vscode.window.onDidStartTerminalShellExecution(async (event) => {
            const execution = event.execution;
            let buffer = '';
            try {
                for await (const data of execution.read()) {
                    buffer += data;
                    if (buffer.length > this.MAX_BUFFER_SIZE) {
                        buffer = buffer.slice(-this.MAX_BUFFER_SIZE);
                    }
                    if (data.includes('Traceback') || data.includes('Error') || data.includes('Exception')) {
                        this.checkForError(buffer);
                    }
                }
            }
            catch (e) {
                // Stream ended or error reading
            }
        }));
    }
    deactivate() {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
    checkForError(buffer) {
        const traceback = errorParser_1.ErrorParser.extractErrorBlock(buffer);
        if (!traceback)
            return;
        const errorKey = traceback.slice(0, 200);
        const now = Date.now();
        if (errorKey === this.lastErrorKey && now - this.lastErrorTime < this.DEBOUNCE_MS) {
            return;
        }
        const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
        const result = errorParser_1.ErrorParser.parse(traceback, workspaceFolders);
        if (!result)
            return;
        this.lastErrorKey = errorKey;
        this.lastErrorTime = now;
        this.lastTraceback = traceback;
        this.onErrorDetected(result);
    }
    getLastTraceback() {
        return this.lastTraceback;
    }
}
exports.TerminalWatcher = TerminalWatcher;
//# sourceMappingURL=terminalWatcher.js.map