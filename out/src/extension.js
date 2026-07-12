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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const config_1 = require("./config");
const errorParser_1 = require("./errorParser");
const errorMemory_1 = require("./errorMemory");
const terminalWatcher_1 = require("./terminalWatcher");
const errorLinkProvider_1 = require("./errorLinkProvider");
const hoverProvider_1 = require("./hoverProvider");
const analysisWebview_1 = require("./analysisWebview");
const fixProvider_1 = require("./fixProvider");
const errorHistoryView_1 = require("./errorHistoryView");
const llmProvider_1 = require("./llmProvider");
const contextBuilder_1 = require("./contextBuilder");
let terminalWatcher;
let linkProvider;
let hoverProvider;
let analysisWebview;
let fixProvider;
let errorMemory;
let errorHistoryViewProvider;
let lastError = null;
function activate(context) {
    console.log('ErrAnalyst: extension activated');
    errorMemory = new errorMemory_1.ErrorMemory();
    errorMemory.init();
    errorHistoryViewProvider = new errorHistoryView_1.ErrorHistoryViewProvider(context.extensionUri, errorMemory);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(errorHistoryView_1.ErrorHistoryViewProvider.viewType, errorHistoryViewProvider));
    analysisWebview = new analysisWebview_1.AnalysisWebview();
    fixProvider = new fixProvider_1.FixProvider();
    hoverProvider = new hoverProvider_1.ErrorHoverProvider();
    linkProvider = new errorLinkProvider_1.ErrorLinkProvider();
    context.subscriptions.push(vscode.window.registerTerminalLinkProvider(linkProvider));
    linkProvider.onHoverDetected((result) => {
        hoverProvider.revealErrorLine(result);
        analysisWebview.show(result);
    });
    terminalWatcher = new terminalWatcher_1.TerminalWatcher(async (result) => {
        lastError = result;
        linkProvider.registerError(result);
        hoverProvider.showHover(result);
        analysisWebview.show(result);
        if (config_1.Config.getInstance().getAutoAnalyze()) {
            await autoAnalyze(result);
        }
        errorHistoryViewProvider.refresh();
    });
    terminalWatcher.activate();
    context.subscriptions.push(vscode.commands.registerCommand('errAnalyst.focusPanel', () => {
        analysisWebview.focus();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('errAnalyst.analyzeLastError', async () => {
        const tb = terminalWatcher.getLastTraceback();
        if (!tb) {
            vscode.window.showWarningMessage('ErrAnalyst: No recent errors found');
            return;
        }
        const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
        const result = errorParser_1.ErrorParser.parse(tb, workspaceFolders);
        if (result) {
            lastError = result;
            analysisWebview.show(result);
            await autoAnalyze(result);
            errorHistoryViewProvider.refresh();
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('errAnalyst.clearCache', async () => {
        errorMemory.clear();
        vscode.window.showInformationMessage('ErrAnalyst: Cache cleared');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('errAnalyst.showFixDiff', () => {
        fixProvider.showFixDiff().catch((e) => {
            console.error('ErrAnalyst: showFixDiff failed:', e);
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('errAnalyst.applyFix', () => {
        fixProvider.applyFixDirectly();
    }));
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.text = '$(error) ErrAnalyst';
    statusItem.tooltip = 'ErrAnalyst - Error Analysis';
    statusItem.command = 'errAnalyst.focusPanel';
    statusItem.show();
    context.subscriptions.push(statusItem);
}
function deactivate() {
    terminalWatcher?.deactivate();
    analysisWebview?.close();
    hoverProvider?.clearHover();
}
async function autoAnalyze(result) {
    const config = config_1.Config.getInstance();
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    if (config.getEnableCache()) {
        const topFile = result.stackFrames.length > 0
            ? result.stackFrames[result.stackFrames.length - 1].file.split('/').pop() || ''
            : '';
        const errorKey = errorParser_1.ErrorParser.normalizeErrorKey(result.errorType, topFile);
        const cached = errorMemory.findCached(errorKey);
        if (cached) {
            result.translation = cached.translation;
            result.keywords = cached.keywords;
            result.analysis = cached.analysis;
            result.fixSuggestion = cached.fixSuggestion;
            result.fixCode = cached.fixCode;
            analysisWebview.show(result, cached);
            hoverProvider.showHover(result, cached);
            fixProvider.prepareFix(result, cached.fixCode);
            return;
        }
    }
    const provider = config.getActiveProvider();
    if (!provider) {
        vscode.window.showWarningMessage('ErrAnalyst: No AI provider configured. Configure API key in settings.');
        return;
    }
    const llm = (0, llmProvider_1.createProvider)(provider);
    if (!llm)
        return;
    const context = contextBuilder_1.ErrorContextBuilder.buildPreciseContext(result, workspaceFolders);
    const prompts = (0, llmProvider_1.buildAnalysisPrompts)(result, result.category, context);
    const response = await llm.analyze({
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        timeout: config.getAiTimeout()
    });
    if (!response.success) {
        vscode.window.showErrorMessage('ErrAnalyst: AI analysis failed - ' + response.error);
        return;
    }
    const parsed = (0, llmProvider_1.parseAiResponse)(response.content);
    if (!parsed) {
        console.log('=== ErrAnalyst: Failed to parse LLM response ===');
        console.log('Raw content:', response.content.slice(0, 500));
        vscode.window.showErrorMessage('ErrAnalyst: Failed to parse AI response');
        return;
    }
    console.log('=== ErrAnalyst 解析结果 ===');
    console.log('analysis:', parsed.analysis?.slice(0, 300));
    console.log('fixSuggestion:', parsed.fixSuggestion?.slice(0, 200));
    console.log('fixCode length:', parsed.fixCode?.length || 0);
    console.log('actions count:', parsed.actions?.length || 0);
    console.log('keywords count:', parsed.keywords?.length || 0);
    console.log('=== End ===');
    result.errorType = parsed.errorType || result.errorType;
    result.errorMessage = parsed.errorMessage || result.errorMessage;
    result.translation = parsed.translation;
    result.keywords = parsed.keywords;
    result.analysis = parsed.analysis;
    result.fixSuggestion = parsed.fixSuggestion;
    result.fixCode = parsed.fixCode;
    result.fixFile = parsed.fixFile;
    result.fixImports = parsed.fixImports;
    result.fixLine = parsed.fixLine;
    const actions = parsed.actions;
    fixProvider.prepareFix(result, parsed.fixCode);
    if (actions && actions.length > 0) {
        fixProvider.prepareActions(actions);
    }
    analysisWebview.show(result, {
        translation: parsed.translation,
        keywords: parsed.keywords,
        analysis: parsed.analysis,
        fixSuggestion: parsed.fixSuggestion,
        fixCode: parsed.fixCode
    });
    // Pass terminal output and project file context to webview
    analysisWebview.showContext(result.fullTraceback, context);
    if (actions && actions.length > 0) {
        analysisWebview.showActions(actions);
    }
    hoverProvider.showHover(result, {
        translation: parsed.translation,
        keywords: parsed.keywords,
        analysis: parsed.analysis,
        fixSuggestion: parsed.fixSuggestion
    });
    errorHistoryViewProvider.refresh();
    if (config.getEnableCache()) {
        result.fixCode = parsed.fixCode;
        result.fixFile = parsed.fixFile;
        result.fixImports = parsed.fixImports;
        result.fixLine = parsed.fixLine;
        errorMemory.cacheResult(result);
    }
}
//# sourceMappingURL=extension.js.map