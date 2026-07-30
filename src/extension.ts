import * as vscode from 'vscode';
import path = require('path');
import { Config } from './config';
import { PythonTracebackParser } from './parser/pythonTraceback';
import { CategoryClassifier } from './diagnostics/categoryClassifier';
import { ContextBuilder } from './context/contextBuilder';
import { ErrorMemory } from './storage/errorMemory';
import { TerminalWatcher } from './terminalWatcher';
import { AnalysisWebview } from './ui/analysisWebview';
import { ErrorHoverProvider } from './ui/hoverProvider';
import { ErrorHistoryViewProvider } from './ui/errorHistoryView';
import { createProvider, buildAnalysisPrompts, parseAiResponse } from './llmProvider';
import type { ErrorAnalysisResult } from './config';
import { ConfigWizard } from './ui/configWizard';

let terminalWatcher: TerminalWatcher;
let hoverProvider: ErrorHoverProvider;
let analysisWebview: AnalysisWebview;
let errorMemory: ErrorMemory;
let categoryClassifier: CategoryClassifier;
let contextBuilder: ContextBuilder;
let errorHistoryViewProvider: ErrorHistoryViewProvider;
let lastError: ErrorAnalysisResult | null = null;
let configWizard: ConfigWizard;

export function activate(context: vscode.ExtensionContext) {
  console.log("ErrAnalyst: extension activated, vscode version:", vscode.version);
  console.log("ErrAnalyst: shellIntegration =", !!(vscode.window as any).terminals?.[0]?.shellIntegration);

  // Init Config with SecretStorage
  Config.getInstance().init(context.secrets);

  // ── Init modules ──

  errorMemory = new ErrorMemory();
  errorMemory.init();

  errorHistoryViewProvider = new ErrorHistoryViewProvider(context.extensionUri, errorMemory);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ErrorHistoryViewProvider.viewType, errorHistoryViewProvider)
  );

  analysisWebview = new AnalysisWebview();
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
    analysisWebview.show(result);
    hoverProvider.showHover(result);

    // 3. Auto-analyze with AI
    if (Config.getInstance().getAutoAnalyze()) {
      await autoAnalyze(result, category);
    }

    errorHistoryViewProvider.refresh();
  });
  terminalWatcher.activate();

  // ── Config wizard ──
  configWizard = new ConfigWizard();
  context.subscriptions.push(
    vscode.commands.registerCommand('errAnalyst.showConfig', async () => {
      const config = Config.getInstance();
      const existingConfig = {
        activeProvider: vscode.workspace.getConfiguration('errAnalyst').get<string>('activeProvider', '') || null,
        providers: config.getProviders(),
        autoAnalyze: config.getAutoAnalyze(),
        enableCache: config.getEnableCache(),
      };
      // Fetch existing API key from secrets (masked)
      let existingApiKey = '';
      if (existingConfig.activeProvider) {
        existingApiKey = await context.secrets.get(`errAnalyst:apiKey:${existingConfig.activeProvider}`) || '';
      }
      configWizard.show({ ...existingConfig, apiKey: existingApiKey });
    })
  );

  // Auto-open wizard if no valid provider is configured
  (async () => {
    const provider = await Config.getInstance().getActiveProvider();
    if (!provider) {
      configWizard.show();
    }
  })();

  // ── Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('errAnalyst.focusPanel', () => {
      analysisWebview.focus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('errAnalyst.analyzeLastError', async () => {
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
        analysisWebview.show(result);
        await autoAnalyze(result, category);
        errorHistoryViewProvider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('errAnalyst.clearCache', async () => {
      errorMemory.clear();
      vscode.window.showInformationMessage('ErrAnalyst: Cache cleared');
    })
  );

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
  analysisWebview?.close();
  hoverProvider?.clearHover();
}

// 自动分析主流程
// 获取上下文 -> 构建 Prompt -> 请求 LLM -> 解析响应 -> 刷新 UI 并写入缓存
async function autoAnalyze(result: ErrorAnalysisResult, category: string): Promise<void> {
  const config = Config.getInstance();
  const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);

  // ── Check cache ──
  // [缓存已禁用]

  // ── Build AI context ──
  const provider = await config.getActiveProvider();
  console.log('ErrAnalyst: fetching active provider...');
  if (!provider) {
    vscode.window.showWarningMessage(
      'ErrAnalyst: No AI provider configured. Configure API key in settings.'
    );
    return;
  }

  const llm = createProvider(provider);
  if (!llm) return;

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
    vscode.window.showErrorMessage('ErrAnalyst: AI analysis failed - ' + response.error);
    return;
  }

  // ── Parse AI response ──
  const parsed = parseAiResponse(response.content);
  if (!parsed) {
    console.log('=== ErrAnalyst: Failed to parse LLM response ===');
    console.log('Raw content:', response.content.slice(0, 500));
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

  // ── Update UI ──
  analysisWebview.show(result, {
    translation: parsed.translation,
    keywords: parsed.keywords,
    analysis: parsed.analysis,
    fixSuggestion: parsed.fixSuggestion,
  });
  analysisWebview.showContext(result.fullTraceback, context);

  hoverProvider.showHover(result, {
    translation: parsed.translation,
    keywords: parsed.keywords,
    analysis: parsed.analysis,
    fixSuggestion: parsed.fixSuggestion,
  });

  errorHistoryViewProvider.refresh();

  // ── Cache result ──
  // [缓存已禁用]
}
