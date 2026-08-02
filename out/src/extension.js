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
const fs = __importStar(require("fs"));
const path = require("path");
const config_1 = require("./config");
const pythonTraceback_1 = require("./parser/pythonTraceback");
const categoryClassifier_1 = require("./diagnostics/categoryClassifier");
const contextBuilder_1 = require("./context/contextBuilder");
const errorMemory_1 = require("./storage/errorMemory");
const terminalWatcher_1 = require("./terminalWatcher");
const analysisWebview_1 = require("./ui/analysisWebview");
const hoverProvider_1 = require("./ui/hoverProvider");
const llmProvider_1 = require("./llmProvider");
const session_1 = require("./fix/session");
const decoration_1 = require("./fix/decoration");
const prompt_1 = require("./fix/prompt");
const session_2 = require("./chat/session");
const prompt_2 = require("./chat/prompt");
const configWizard_1 = require("./ui/configWizard");
const configManager_1 = require("./configManager");
let terminalWatcher;
let hoverProvider;
let analysisViewProvider;
let fixDecorationManager;
let fixSessionManager;
let errorMemory;
let categoryClassifier;
let contextBuilder;
let chatSessionManager;
let lastError = null;
let configWizard;
let configManager;
function loadCommandManifest(extensionPath) {
    try {
        return JSON.parse(fs.readFileSync(path.join(extensionPath, 'commands.json'), 'utf-8'));
    }
    catch (e) {
        console.error('ErrAnalyst: Failed to load commands.json', e);
        return [];
    }
}
function activate(context) {
    console.log("ErrAnalyst: extension activated, vscode version:", vscode.version);
    console.log("ErrAnalyst: shellIntegration =", !!vscode.window.terminals?.[0]?.shellIntegration);
    // Init Config with SecretStorage
    config_1.Config.getInstance().init(context.secrets);
    // ── Init modules ──
    errorMemory = new errorMemory_1.ErrorMemory();
    errorMemory.init();
    analysisViewProvider = new analysisWebview_1.AnalysisViewProvider(context.extensionUri, {
        onReanalyze: (error) => {
            fixSessionManager?.end();
            void autoAnalyze(error, error.category || 'UNKNOWN', { force: true });
        },
        onStartFix: () => {
            void runFixFlow();
        },
        onFixAction: (action, hunkId) => {
            handleFixAction(action, hunkId);
        },
        onChatSend: (content) => {
            void runChatTurn(content);
        },
        onChatAction: (action, fileId) => {
            handleChatAction(action, fileId);
        },
        onChatAddFiles: () => {
            void pickChatFiles();
        },
    });
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(analysisWebview_1.AnalysisViewProvider.viewType, analysisViewProvider));
    fixDecorationManager = new decoration_1.FixDecorationManager();
    fixSessionManager = new session_1.FixSessionManager({
        decorations: fixDecorationManager,
        onStateChanged: (snapshot) => {
            if (snapshot)
                analysisViewProvider.showFixSession(snapshot);
            else
                analysisViewProvider.clearFixState();
        },
    });
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, fixDecorationManager), vscode.commands.registerCommand('errAnalyst.acceptFixHunk', (id) => void fixSessionManager.accept(id)), vscode.commands.registerCommand('errAnalyst.rejectFixHunk', (id) => void fixSessionManager.reject(id)), vscode.workspace.onDidChangeTextDocument(() => {
        if (fixSessionManager?.active)
            void fixSessionManager.refresh();
    }));
    chatSessionManager = new session_2.ChatSessionManager((snapshot) => analysisViewProvider.showChat(snapshot));
    hoverProvider = new hoverProvider_1.ErrorHoverProvider();
    // Initialize category classifier from the bundled YAML rules
    categoryClassifier = new categoryClassifier_1.CategoryClassifier();
    const yamlPath = path.join(context.extensionPath, 'src', 'parser', 'error-categories.yaml');
    categoryClassifier.loadFromYaml(yamlPath);
    contextBuilder = new contextBuilder_1.ContextBuilder();
    // ── Terminal watcher ──
    terminalWatcher = new terminalWatcher_1.TerminalWatcher(async (result) => {
        fixSessionManager.end();
        lastError = result;
        // 1. Run category classifier
        const category = categoryClassifier.classify({
            errorType: result.errorType,
            errorMessage: result.errorMessage,
            filePath: result.filePath,
            lineNumber: result.lineNumber,
            stackFrames: result.stackFrames,
            fullTraceback: result.fullTraceback,
            chain: result.chain,
        });
        result.category = category;
        // 2. Show analysis panel immediately with parsed data
        analysisViewProvider.show(result);
        chatSessionManager.startForError([]);
        hoverProvider.showHover(result);
        // 3. Auto-analyze with AI
        if (config_1.Config.getInstance().getAutoAnalyze()) {
            await autoAnalyze(result, category);
        }
    });
    terminalWatcher.activate();
    // ── Config wizard ──
    configWizard = new configWizard_1.ConfigWizard();
    // ── Config manager (CLI-style commands) ──
    configManager = new configManager_1.ConfigManager(context.secrets);
    // Auto-open wizard if no valid provider is configured
    (async () => {
        const provider = await config_1.Config.getInstance().getActiveProvider();
        if (!provider) {
            configWizard.show();
        }
    })();
    // ── Commands (registered from commands.json) ──
    registerManifestCommands(context);
    // ── Status bar ──
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.text = '$(error) ErrAnalyst';
    statusItem.tooltip = 'ErrAnalyst - Error Analysis';
    statusItem.command = 'errAnalyst.focusPanel';
    statusItem.show();
    context.subscriptions.push(statusItem);
}
function deactivate() {
    terminalWatcher?.deactivate();
    hoverProvider?.clearHover();
    configManager?.dispose();
    fixSessionManager?.end();
    fixDecorationManager?.dispose();
}
function registerManifestCommands(context) {
    const manifest = loadCommandManifest(context.extensionPath);
    const handlers = {
        'errAnalyst.focusPanel': () => analysisViewProvider.focus(),
        'errAnalyst.analyzeLastError': async () => {
            const tb = terminalWatcher.getLastTraceback();
            if (!tb) {
                vscode.window.showWarningMessage('ErrAnalyst: No recent errors found');
                return;
            }
            const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
            const traceback = pythonTraceback_1.PythonTracebackParser.extractErrorBlock(tb);
            const parseResult = traceback ? pythonTraceback_1.PythonTracebackParser.parse(traceback, workspaceFolders) : null;
            if (parseResult) {
                const result = {
                    errorType: parseResult.errorType,
                    errorMessage: parseResult.errorMessage,
                    filePath: parseResult.filePath,
                    lineNumber: parseResult.lineNumber,
                    stackFrames: parseResult.stackFrames,
                    fullTraceback: parseResult.fullTraceback,
                    chain: parseResult.chain,
                    timestamp: Date.now(),
                };
                const category = categoryClassifier.classify(parseResult);
                result.category = category;
                lastError = result;
                fixSessionManager.end();
                analysisViewProvider.show(result);
                chatSessionManager.startForError([]);
                await autoAnalyze(result, category);
            }
        },
        'errAnalyst.clearCache': async () => {
            errorMemory.clear();
            vscode.window.showInformationMessage('ErrAnalyst: Cache cleared');
        },
        'errAnalyst.cacheShow': async () => {
            const entries = errorMemory.getAll();
            if (entries.length === 0) {
                vscode.window.showInformationMessage('ErrAnalyst: 本地分析缓存为空');
                return;
            }
            const items = entries.map(entry => ({
                label: entry.errorType,
                description: entry.errorMessage.slice(0, 80),
                detail: `${new Date(entry.lastSeen).toLocaleString('zh-CN')} · ${entry.count} 次`,
                entry,
            }));
            const selected = await vscode.window.showQuickPick(items, {
                matchOnDescription: true,
                placeHolder: '选择一条缓存分析',
            });
            if (!selected)
                return;
            fixSessionManager.end();
            const entry = selected.entry;
            const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
            const result = {
                errorType: entry.errorType,
                errorMessage: entry.errorMessage,
                filePath: entry.filePath || '',
                lineNumber: entry.lineNumber || 0,
                stackFrames: entry.stackFrames || [],
                fullTraceback: entry.fullTraceback || '',
                chain: entry.chain || [],
                category: entry.category,
                translation: entry.translation,
                keywords: entry.keywords || [],
                analysis: entry.analysis,
                fixSuggestion: entry.fixSuggestion,
                timestamp: entry.lastSeen,
            };
            lastError = result;
            const context = contextBuilder.build({
                errorType: result.errorType,
                errorMessage: result.errorMessage,
                filePath: result.filePath,
                lineNumber: result.lineNumber,
                stackFrames: result.stackFrames,
                fullTraceback: result.fullTraceback,
                chain: result.chain,
            }, workspaceFolders);
            analysisViewProvider.show(result, {
                translation: entry.translation,
                keywords: entry.keywords || [],
                analysis: entry.analysis,
                fixSuggestion: entry.fixSuggestion,
            }, { fromCache: true, cachedAt: entry.lastSeen });
            analysisViewProvider.showContext(result.fullTraceback, context);
            chatSessionManager.startForError(contextToAutoFiles(context));
        },
        'errAnalyst.setProvider': () => configManager.setProvider(),
        'errAnalyst.setActiveProvider': () => configManager.setActiveProvider(),
        'errAnalyst.showConfig': () => configManager.showConfig(),
        'errAnalyst.setModel': () => configManager.setModel(),
    };
    for (const def of manifest) {
        if (!def.vscodeId)
            continue;
        const handler = handlers[def.vscodeId];
        if (handler) {
            context.subscriptions.push(vscode.commands.registerCommand(def.vscodeId, handler));
        }
        else {
            console.warn('ErrAnalyst: missing handler for ' + def.vscodeId);
        }
    }
}
function handleFixAction(action, hunkId) {
    switch (action) {
        case 'acceptFixHunk':
            if (hunkId)
                void fixSessionManager.accept(hunkId);
            break;
        case 'rejectFixHunk':
            if (hunkId)
                void fixSessionManager.reject(hunkId);
            break;
        case 'acceptAllFix':
            void fixSessionManager.acceptAll();
            break;
        case 'rejectAllFix':
            void fixSessionManager.rejectAll();
            break;
        case 'undoAllFix':
            void fixSessionManager.undoAll();
            break;
        case 'endFix':
            fixSessionManager.end();
            break;
        case 'openFixHunk':
            if (hunkId)
                void fixSessionManager.openHunk(hunkId);
            break;
    }
}
function handleChatAction(action, fileId) {
    switch (action) {
        case 'newChatSession':
            void vscode.window.showWarningMessage('确定要清空当前对话吗？修复会话也会结束，对话上下文文件会保留。', { modal: true }, '新开会话').then(choice => {
                if (choice === '新开会话') {
                    fixSessionManager.end();
                    chatSessionManager.newSession();
                }
            });
            break;
        case 'generatePatch':
            void runChatFixFlow();
            break;
        case 'removeFile':
            if (fileId)
                chatSessionManager.removeFile(fileId);
            break;
        case 'restoreDefaults':
            chatSessionManager.restoreDefaults();
            break;
    }
}
async function pickChatFiles() {
    const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: '添加到对话上下文',
        filters: {
            '文本文件': ['py', 'js', 'ts', 'json', 'yaml', 'yml', 'toml', 'env', 'txt', 'md', 'cfg', 'ini', 'log', 'csv', 'sh'],
            '所有文件': ['*'],
        },
    });
    if (!uris || uris.length === 0)
        return;
    const results = await chatSessionManager.addUserFiles(uris.map(u => u.fsPath));
    const errors = results.filter(r => !r.ok);
    if (errors.length > 0) {
        vscode.window.showWarningMessage('ErrAnalyst: ' + errors.map(e => `${e.path}: ${e.error || '未知错误'}`).join('；'));
    }
}
async function runChatTurn(content) {
    const text = content.trim();
    if (!text || chatSessionManager.isBusy())
        return;
    if (!lastError)
        return;
    const config = config_1.Config.getInstance();
    if (!config.getEnableChat()) {
        vscode.window.showInformationMessage('ErrAnalyst: 错误分析对话已在设置中关闭');
        return;
    }
    const provider = await config.getActiveProvider();
    if (!provider) {
        chatSessionManager.setError('未配置可用的 AI Provider，请先完成配置');
        return;
    }
    const llm = (0, llmProvider_1.createProvider)(provider);
    if (!llm) {
        chatSessionManager.setError('AI Provider 初始化失败');
        return;
    }
    chatSessionManager.addUserMessage(text);
    chatSessionManager.setSending(true);
    chatSessionManager.setError(null);
    try {
        const traceback = parsedTracebackFromResult(lastError);
        const payload = chatSessionManager.buildContextPayload();
        const history = chatSessionManager.getLlmHistory(true);
        const messages = (0, prompt_2.buildChatMessages)({
            traceback,
            analysisText: analysisTextFromResult(lastError),
            contextPayload: payload.payload,
            history,
            question: text,
        });
        const response = await llm.chat({ messages, timeout: config.getAiTimeout() });
        if (response.success) {
            chatSessionManager.appendAssistantMessage(response.content);
        }
        else {
            chatSessionManager.setError('AI 请求失败: ' + (response.error || '未知错误'));
        }
    }
    catch (e) {
        chatSessionManager.setError(e instanceof Error ? e.message : String(e));
    }
    finally {
        chatSessionManager.setSending(false);
    }
}
async function runChatFixFlow() {
    const config = config_1.Config.getInstance();
    if (!config.getEnableChat()) {
        vscode.window.showInformationMessage('ErrAnalyst: 错误分析对话已在设置中关闭');
        return;
    }
    if (!config.getEnableOneClickFix()) {
        vscode.window.showInformationMessage('ErrAnalyst: 一键修复功能已在设置中关闭，对话补丁使用同一确认流程');
        return;
    }
    if (!lastError)
        return;
    const provider = await config.getActiveProvider();
    if (!provider) {
        chatSessionManager.setError('未配置可用的 AI Provider，请先完成配置');
        return;
    }
    const llm = (0, llmProvider_1.createProvider)(provider);
    if (!llm) {
        chatSessionManager.setError('AI Provider 初始化失败');
        return;
    }
    chatSessionManager.setGeneratingPatch(true);
    chatSessionManager.setError(null);
    try {
        const traceback = parsedTracebackFromResult(lastError);
        const payload = chatSessionManager.buildContextPayload();
        const history = chatSessionManager.getLlmHistory();
        const prompts = (0, prompt_1.buildChatFixPrompts)(traceback, analysisTextFromResult(lastError), payload.payload, history.filter(m => m.role !== 'notice').map(m => ({ role: m.role, content: m.content })));
        const response = await llm.analyze({
            systemPrompt: prompts.systemPrompt,
            userPrompt: prompts.userPrompt,
            timeout: config.getAiTimeout(),
        });
        if (!response.success) {
            chatSessionManager.setError('AI 请求失败: ' + (response.error || '未知错误'));
            return;
        }
        const allowedFiles = chatSessionManager.getAllowedFilePaths();
        const parsed = (0, prompt_1.parseFixResponseWithReason)(response.content, allowedFiles);
        if (parsed.hunks.length === 0) {
            chatSessionManager.appendAssistantMessage(parsed.reason || 'AI 未给出可应用的修改：根因可能不在当前代码中，或无法从现有上下文确定。');
            return;
        }
        const hunks = parsed.hunks.map((input, i) => ({
            id: `hunk-${Date.now()}-${i}`,
            file: input.file,
            reason: input.reason,
            oldLines: input.oldLines,
            newLines: input.newLines,
            status: 'pending',
        }));
        await fixSessionManager.start(lastError, hunks);
        chatSessionManager.addNotice(`已生成 ${hunks.length} 处修改，可在上方修复建议卡片逐处确认`);
    }
    catch (e) {
        chatSessionManager.setError(e instanceof Error ? e.message : String(e));
    }
    finally {
        chatSessionManager.setGeneratingPatch(false);
    }
}
function parsedTracebackFromResult(result) {
    return {
        errorType: result.errorType,
        errorMessage: result.errorMessage,
        filePath: result.filePath,
        lineNumber: result.lineNumber,
        stackFrames: result.stackFrames || [],
        fullTraceback: result.fullTraceback || '',
        chain: result.chain || [],
    };
}
function analysisTextFromResult(result) {
    return [
        result.translation ? '翻译：' + result.translation : '',
        result.analysis ? '分析：' + result.analysis : '',
        result.fixSuggestion ? '文字建议：' + result.fixSuggestion : '',
    ].filter(Boolean).join('\n\n');
}
function contextToAutoFiles(context) {
    const files = [
        context.mainFile,
        ...context.stackFiles,
        ...context.configFiles,
        ...context.siblingFiles,
    ].filter((f) => !!f);
    return files.map(f => ({
        path: f.path,
        startLine: f.startLine,
        endLine: f.endLine,
        content: f.content,
    }));
}
async function runFixFlow() {
    const config = config_1.Config.getInstance();
    if (!config.getEnableOneClickFix()) {
        vscode.window.showInformationMessage('ErrAnalyst: 一键修复功能已在设置中关闭');
        return;
    }
    if (!lastError)
        return;
    const provider = await config.getActiveProvider();
    if (!provider) {
        analysisViewProvider.showFixError('未配置可用的 AI Provider，请先完成配置');
        return;
    }
    const llm = (0, llmProvider_1.createProvider)(provider);
    if (!llm) {
        analysisViewProvider.showFixError('AI Provider 初始化失败');
        return;
    }
    analysisViewProvider.showFixGenerating();
    try {
        const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
        const parsedTraceback = {
            errorType: lastError.errorType,
            errorMessage: lastError.errorMessage,
            filePath: lastError.filePath,
            lineNumber: lastError.lineNumber,
            stackFrames: lastError.stackFrames || [],
            fullTraceback: lastError.fullTraceback || '',
            chain: lastError.chain || [],
        };
        const context = contextBuilder.build(parsedTraceback, workspaceFolders);
        const analysisText = [
            lastError.translation ? '翻译：' + lastError.translation : '',
            lastError.analysis ? '分析：' + lastError.analysis : '',
            lastError.fixSuggestion ? '文字建议：' + lastError.fixSuggestion : '',
        ].filter(Boolean).join('\n\n');
        const hunks = await generateFixHunks(llm, parsedTraceback, context, analysisText);
        await fixSessionManager.start(lastError, hunks);
        if (hunks.length === 0) {
            vscode.window.showInformationMessage('ErrAnalyst: AI 未生成可应用的修复补丁');
        }
    }
    catch (e) {
        analysisViewProvider.showFixError(e instanceof Error ? e.message : String(e));
        console.error('ErrAnalyst: fix generation failed', e);
    }
}
async function generateFixHunks(provider, traceback, context, analysisText) {
    const prompts = (0, prompt_1.buildFixPrompts)(traceback, context, analysisText);
    console.log('ErrAnalyst: fix userPrompt length =', prompts.userPrompt.length);
    const response = await provider.analyze({
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        timeout: config_1.Config.getInstance().getAiTimeout(),
    });
    if (!response.success) {
        throw new Error(response.error || 'AI 请求失败');
    }
    const allowedFiles = collectAllowedFiles(context, traceback);
    return (0, prompt_1.parseFixResponse)(response.content, allowedFiles).map((input, i) => ({
        id: `hunk-${Date.now()}-${i}`,
        file: input.file,
        reason: input.reason,
        oldLines: input.oldLines,
        newLines: input.newLines,
        status: 'pending',
    }));
}
function collectAllowedFiles(context, traceback) {
    const files = new Set();
    if (context.mainFile)
        files.add(context.mainFile.path);
    for (const f of [...context.stackFiles, ...context.configFiles, ...context.siblingFiles]) {
        files.add(f.path);
    }
    if (traceback.filePath)
        files.add(traceback.filePath);
    return [...files];
}
// 自动分析主流程
// 获取上下文 -> 构建 Prompt -> 请求 LLM -> 解析响应 -> 刷新 UI 并写入缓存
async function autoAnalyze(result, category, options) {
    const config = config_1.Config.getInstance();
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    const force = options?.force || false;
    if (force) {
        analysisViewProvider.show(result);
    }
    const parsedTraceback = {
        errorType: result.errorType,
        errorMessage: result.errorMessage,
        filePath: result.filePath,
        lineNumber: result.lineNumber,
        stackFrames: result.stackFrames || [],
        fullTraceback: result.fullTraceback || '',
        chain: result.chain || [],
    };
    const context = contextBuilder.build(parsedTraceback, workspaceFolders);
    analysisViewProvider.showContext(result.fullTraceback, context);
    chatSessionManager.updateAutoFiles(contextToAutoFiles(context));
    // ── Build AI context ──
    const provider = await config.getActiveProvider();
    console.log('ErrAnalyst: fetching active provider...');
    if (!provider) {
        analysisViewProvider.showAiError('未配置 AI Provider');
        vscode.window.showWarningMessage('ErrAnalyst: No AI provider configured. Configure API key in settings.');
        return;
    }
    const llm = (0, llmProvider_1.createProvider)(provider);
    if (!llm) {
        analysisViewProvider.showAiError('AI Provider 初始化失败');
        return;
    }
    const prompts = (0, llmProvider_1.buildAnalysisPrompts)(parsedTraceback, category, context);
    // ── Debug: log full prompt ──
    console.log('\n' + '='.repeat(80));
    console.log('═══ 构建上下文概要 ═══');
    console.log('  mainFile:', context.mainFile?.path || '(none)');
    console.log('  stackFiles:', context.stackFiles.length);
    console.log('  configFiles:', context.configFiles.length);
    console.log('  siblingFiles:', context.siblingFiles.length);
    for (const f of [context.mainFile, ...context.stackFiles, ...context.configFiles, ...context.siblingFiles].filter(Boolean)) {
        console.log(`    [${f.source}] ${f.path}:${f.startLine}-${f.endLine} (${f.content.length} chars)`);
    }
    console.log('\n═══ 报错结构化数据 ═══');
    console.log(JSON.stringify({
        errorType: parsedTraceback.errorType,
        errorMessage: parsedTraceback.errorMessage,
        filePath: parsedTraceback.filePath,
        lineNumber: parsedTraceback.lineNumber,
        chainCount: parsedTraceback.chain.length,
        stackFrameCount: parsedTraceback.stackFrames.length,
        stackFrames: parsedTraceback.stackFrames.map(f => ({ file: f.file, line: f.line, func: f.function, code: f.codeLine })),
        chain: parsedTraceback.chain.map(e => ({
            errorType: e.errorType,
            filePath: e.filePath,
            lineNumber: e.lineNumber,
            relationship: e.relationship,
            frames: e.stackFrames.map(f => ({ file: f.file, line: f.line, func: f.function })),
        })),
    }, null, 2));
    console.log('\n═══ systemPrompt (发送给 LLM) ═══');
    console.log(prompts.systemPrompt);
    console.log('\n═══ userPrompt (发送给 LLM) ═══');
    console.log('userPrompt length:', prompts.userPrompt.length);
    console.log(prompts.userPrompt);
    console.log('='.repeat(80));
    // ── Call AI ──
    const response = await llm.analyze({
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        timeout: config.getAiTimeout(),
    });
    if (!response.success) {
        analysisViewProvider.showAiError('AI 分析失败: ' + response.error);
        vscode.window.showErrorMessage('ErrAnalyst: AI analysis failed - ' + response.error);
        return;
    }
    // ── Parse AI response ──
    const parsed = (0, llmProvider_1.parseAiResponse)(response.content);
    if (!parsed) {
        console.log('=== ErrAnalyst: Failed to parse LLM response ===');
        console.log('Raw content:', response.content.slice(0, 500));
        analysisViewProvider.showAiError('AI 响应解析失败');
        vscode.window.showErrorMessage('ErrAnalyst: Failed to parse AI response');
        return;
    }
    console.log('=== ErrAnalyst 解析结果 ===');
    console.log('analysis:', parsed.analysis?.slice(0, 300));
    console.log('fixSuggestion:', parsed.fixSuggestion?.slice(0, 200));
    console.log('keywords count:', parsed.keywords?.length || 0);
    console.log('=== End ===');
    // ── Apply results ──
    result.errorType = parsed.errorType || result.errorType;
    result.errorMessage = parsed.errorMessage || result.errorMessage;
    result.translation = parsed.translation;
    result.keywords = parsed.keywords;
    result.analysis = parsed.analysis;
    result.fixSuggestion = parsed.fixSuggestion;
    // If AI returned a category (fallback case), use it
    if (parsed.category && result.category === 'UNKNOWN') {
        result.category = parsed.category;
    }
    errorMemory.cacheResult(result);
    // ── Update UI ──
    analysisViewProvider.show(result, {
        translation: parsed.translation,
        keywords: parsed.keywords,
        analysis: parsed.analysis,
        fixSuggestion: parsed.fixSuggestion,
    });
    analysisViewProvider.showContext(result.fullTraceback, context);
    hoverProvider.showHover(result, {
        translation: parsed.translation,
        keywords: parsed.keywords,
        analysis: parsed.analysis,
        fixSuggestion: parsed.fixSuggestion,
    });
}
//# sourceMappingURL=extension.js.map