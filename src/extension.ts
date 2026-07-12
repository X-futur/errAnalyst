import * as vscode from 'vscode';
import { Config } from './config';
import { ErrorParser } from './errorParser';
import { ErrorMemory } from './errorMemory';
import { TerminalWatcher } from './terminalWatcher';
import { ErrorLinkProvider } from './errorLinkProvider';
import { ErrorHoverProvider } from './hoverProvider';
import { AnalysisWebview } from './analysisWebview';
import { FixProvider } from './fixProvider';
import { ErrorHistoryViewProvider } from './errorHistoryView';
import { createProvider, buildAnalysisPrompts, parseAiResponse } from './llmProvider';
import { ErrorContextBuilder } from './contextBuilder';
import type { ErrorAnalysisResult } from './config';

let terminalWatcher: TerminalWatcher;
let linkProvider: ErrorLinkProvider;
let hoverProvider: ErrorHoverProvider;
let analysisWebview: AnalysisWebview;
let fixProvider: FixProvider;
let errorMemory: ErrorMemory;
let errorHistoryViewProvider: ErrorHistoryViewProvider;
let lastError: ErrorAnalysisResult | null = null;

export function activate(context: vscode.ExtensionContext) {
  console.log('ErrAnalyst: extension activated');

  errorMemory = new ErrorMemory();
  errorMemory.init();

  errorHistoryViewProvider = new ErrorHistoryViewProvider(context.extensionUri, errorMemory);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ErrorHistoryViewProvider.viewType, errorHistoryViewProvider)
  );

  analysisWebview = new AnalysisWebview();
  fixProvider = new FixProvider();
  hoverProvider = new ErrorHoverProvider();

  linkProvider = new ErrorLinkProvider();
  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider(linkProvider)
  );

  linkProvider.onHoverDetected((result) => {
    hoverProvider.revealErrorLine(result);
    analysisWebview.show(result);
  });

  terminalWatcher = new TerminalWatcher(async (result) => {
    lastError = result;
    linkProvider.registerError(result);
    hoverProvider.showHover(result);
    analysisWebview.show(result);
    if (Config.getInstance().getAutoAnalyze()) {
      await autoAnalyze(result);
    }
    errorHistoryViewProvider.refresh();
  });
  terminalWatcher.activate();

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
      const result = ErrorParser.parse(tb, workspaceFolders);
      if (result) {
        lastError = result;
        analysisWebview.show(result);
        await autoAnalyze(result);
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

  context.subscriptions.push(
    vscode.commands.registerCommand('errAnalyst.showFixDiff', () => {
      fixProvider.showFixDiff().catch((e: any) => {
        console.error('ErrAnalyst: showFixDiff failed:', e);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('errAnalyst.applyFix', () => {
      fixProvider.applyFixDirectly();
    })
  );

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

async function autoAnalyze(result: ErrorAnalysisResult): Promise<void> {
  const config = Config.getInstance();
  const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);

  if (config.getEnableCache()) {
    const topFile = result.stackFrames.length > 0
      ? result.stackFrames[result.stackFrames.length - 1].file.split('/').pop() || ''
      : '';
    const errorKey = ErrorParser.normalizeErrorKey(result.errorType, topFile);
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
    vscode.window.showWarningMessage(
      'ErrAnalyst: No AI provider configured. Configure API key in settings.'
    );
    return;
  }

  const llm = createProvider(provider);
  if (!llm) return;

  const context = ErrorContextBuilder.buildPreciseContext(result, workspaceFolders);
  const prompts = buildAnalysisPrompts(result, result.category, context);
  const response = await llm.analyze({
    systemPrompt: prompts.systemPrompt,
    userPrompt: prompts.userPrompt,
    timeout: config.getAiTimeout()
  });

  if (!response.success) {
    vscode.window.showErrorMessage('ErrAnalyst: AI analysis failed - ' + response.error);
    return;
  }

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
