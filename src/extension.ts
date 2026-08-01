import * as vscode from 'vscode';
import * as fs from 'fs';
import path = require('path');
import { Config } from './config';
import { PythonTracebackParser } from './parser/pythonTraceback';
import { CategoryClassifier } from './diagnostics/categoryClassifier';
import { ContextBuilder } from './context/contextBuilder';
import { ErrorMemory } from './storage/errorMemory';
import { TerminalWatcher } from './terminalWatcher';
import { AnalysisViewProvider } from './ui/analysisWebview';
import { ErrorHoverProvider } from './ui/hoverProvider';
import { createProvider, buildAnalysisPrompts, parseAiResponse } from './llmProvider';
import type { ErrorAnalysisResult } from './config';
import { ConfigWizard } from './ui/configWizard';
import { ConfigManager } from './configManager';

let terminalWatcher: TerminalWatcher;
let hoverProvider: ErrorHoverProvider;
let analysisViewProvider: AnalysisViewProvider;
let errorMemory: ErrorMemory;
let categoryClassifier: CategoryClassifier;
let contextBuilder: ContextBuilder;
let lastError: ErrorAnalysisResult | null = null;
let configWizard: ConfigWizard;
let configManager: ConfigManager;

interface CommandDefinition {
  vscodeId: string | null;
  title: string;
  cli: string | null;
  description: string;
  availability: string;
}

function loadCommandManifest(extensionPath: string): CommandDefinition[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(extensionPath, 'commands.json'), 'utf-8'));
  } catch (e) {
    console.error('ErrAnalyst: Failed to load commands.json', e);
    return [];
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log("ErrAnalyst: extension activated, vscode version:", vscode.version);
  console.log("ErrAnalyst: shellIntegration =", !!(vscode.window as any).terminals?.[0]?.shellIntegration);

  // Init Config with SecretStorage
  Config.getInstance().init(context.secrets);

  // ── Init modules ──

  errorMemory = new ErrorMemory();
  errorMemory.init();

  analysisViewProvider = new AnalysisViewProvider(context.extensionUri, (error) => {
    void autoAnalyze(error, error.category || 'UNKNOWN', { force: true });
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AnalysisViewProvider.viewType, analysisViewProvider)
  );

  hoverProvider = new ErrorHoverProvider();

  // Initialize category classifier from the bundled YAML rules
  categoryClassifier = new CategoryClassifier();
  const yamlPath = path.join(context.extensionPath, 'src', 'parser', 'error-categories.yaml');
  categoryClassifier.loadFromYaml(yamlPath);

  contextBuilder = new ContextBuilder();

  // ── Terminal watcher ──

  terminalWatcher = new TerminalWatcher(async (result) => {
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
    hoverProvider.showHover(result);

    // 3. Auto-analyze with AI
    if (Config.getInstance().getAutoAnalyze()) {
      await autoAnalyze(result, category);
    }
  });
  terminalWatcher.activate();

  // ── Config wizard ──
  configWizard = new ConfigWizard();
  // ── Config manager (CLI-style commands) ──
  configManager = new ConfigManager(context.secrets);

  // Auto-open wizard if no valid provider is configured
  (async () => {
    const provider = await Config.getInstance().getActiveProvider();
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

export function deactivate() {
  terminalWatcher?.deactivate();
  hoverProvider?.clearHover();
  configManager?.dispose();
}

function registerManifestCommands(context: vscode.ExtensionContext): void {
  const manifest = loadCommandManifest(context.extensionPath);
  const handlers: Record<string, (...args: any[]) => any> = {
    'errAnalyst.focusPanel': () => analysisViewProvider.focus(),
    'errAnalyst.analyzeLastError': async () => {
      const tb = terminalWatcher.getLastTraceback();
      if (!tb) {
        vscode.window.showWarningMessage('ErrAnalyst: No recent errors found');
        return;
      }
      const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
      const traceback = PythonTracebackParser.extractErrorBlock(tb);
      const parseResult = traceback ? PythonTracebackParser.parse(traceback, workspaceFolders) : null;
      if (parseResult) {
        const result: ErrorAnalysisResult = {
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
        analysisViewProvider.show(result);
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
      if (!selected) return;

      const entry = selected.entry;
      const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
      const result: ErrorAnalysisResult = {
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
    },
    'errAnalyst.setProvider': () => configManager.setProvider(),
    'errAnalyst.setActiveProvider': () => configManager.setActiveProvider(),
    'errAnalyst.showConfig': () => configManager.showConfig(),
    'errAnalyst.setModel': () => configManager.setModel(),
  };

  for (const def of manifest) {
    if (!def.vscodeId) continue;
    const handler = handlers[def.vscodeId];
    if (handler) {
      context.subscriptions.push(vscode.commands.registerCommand(def.vscodeId, handler));
    } else {
      console.warn('ErrAnalyst: missing handler for ' + def.vscodeId);
    }
  }
}

// 自动分析主流程
// 获取上下文 -> 构建 Prompt -> 请求 LLM -> 解析响应 -> 刷新 UI 并写入缓存
async function autoAnalyze(
  result: ErrorAnalysisResult,
  category: string,
  options?: { force?: boolean }
): Promise<void> {
  const config = Config.getInstance();
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
    stackFrames: result.stackFrames,
    fullTraceback: result.fullTraceback,
    chain: result.chain,
  };

  const context = contextBuilder.build(parsedTraceback, workspaceFolders);
  analysisViewProvider.showContext(result.fullTraceback, context);

  // ── Check cache ──
  if (!force) {
    const cached = errorMemory.findCachedFor(result);
    if (cached) {
      result.translation = cached.translation || '';
      result.keywords = cached.keywords || [];
      result.analysis = cached.analysis || '';
      result.fixSuggestion = cached.fixSuggestion || '';
      if (cached.category) result.category = cached.category;

      const aiData = {
        translation: cached.translation,
        keywords: cached.keywords,
        analysis: cached.analysis,
        fixSuggestion: cached.fixSuggestion,
      };
      analysisViewProvider.show(result, aiData, { fromCache: true, cachedAt: cached.lastSeen });
      hoverProvider.showHover(result, aiData);
      return;
    }
  }

  // ── Build AI context ──
  const provider = await config.getActiveProvider();
  console.log('ErrAnalyst: fetching active provider...');
  if (!provider) {
    analysisViewProvider.showAiError('未配置 AI Provider');
    vscode.window.showWarningMessage(
      'ErrAnalyst: No AI provider configured. Configure API key in settings.'
    );
    return;
  }

  const llm = createProvider(provider);
  if (!llm) {
    analysisViewProvider.showAiError('AI Provider 初始化失败');
    return;
  }

  const prompts = buildAnalysisPrompts(
    parsedTraceback,
    category as any,
    context,
  );

  // ── Debug: log full prompt ──
  console.log('\n' + '='.repeat(80));
  console.log('═══ 构建上下文概要 ═══');
  console.log('  mainFile:', context.mainFile?.path || '(none)');
  console.log('  stackFiles:', context.stackFiles.length);
  console.log('  configFiles:', context.configFiles.length);
  console.log('  siblingFiles:', context.siblingFiles.length);
  for (const f of [context.mainFile, ...context.stackFiles, ...context.configFiles, ...context.siblingFiles].filter(Boolean)) {
    console.log(`    [${f!.source}] ${f!.path}:${f!.startLine}-${f!.endLine} (${f!.content.length} chars)`);
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
  const parsed = parseAiResponse(response.content);
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
