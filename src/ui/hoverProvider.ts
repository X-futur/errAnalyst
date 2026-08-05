import * as vscode from 'vscode';
import { ErrorAnalysisResult } from '../config';
import { resolveCoreTerm } from '../errorTerms';

/**
 * Registers a temporary HoverProvider on the error file line
 * to show analysis when the user hovers in the editor.
 */
export class ErrorHoverProvider {
  private currentDisposable: vscode.Disposable | null = null;

  /**
   * Show hover analysis for a specific error on a specific file line.
   */
  showHover(error: ErrorAnalysisResult, aiData?: {
    translation: string;
    keywords: Array<{ cn: string; en: string }>;
    analysis: string;
    fixSuggestion: string;
  }): void {
    this.clearHover();

    if (!error.filePath) return;

    const markdown = this.buildMarkdown(error, aiData);

    const filePattern = error.filePath.includes('/')
      ? `**/${error.filePath.split('/').pop()}`
      : error.filePath;

    this.currentDisposable = vscode.languages.registerHoverProvider(
      { scheme: 'file', pattern: filePattern },
      {
        provideHover(document, position) {
          if (position.line !== error.lineNumber - 1) return null;
          return new vscode.Hover(markdown);
        }
      }
    );
  }

  /**
   * Clear the current hover provider.
   */
  clearHover(): void {
    if (this.currentDisposable) {
      this.currentDisposable.dispose();
      this.currentDisposable = null;
    }
  }

  private buildMarkdown(
    error: ErrorAnalysisResult,
    aiData?: { translation: string; keywords: Array<{ cn: string; en: string }>; analysis: string; fixSuggestion: string }
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    // Error type header
    md.appendMarkdown(`## ⚠ ${error.errorType}\n\n`);

    // Error message
    md.appendMarkdown(`**错误信息:** \`${error.errorMessage}\`\n\n`);

    // Code line
    const lastFrame = error.stackFrames[error.stackFrames.length - 1];
    if (lastFrame?.codeLine) {
      md.appendMarkdown(`**出错代码:** \`${lastFrame.codeLine}\`\n\n`);
    }

    md.appendMarkdown(`---\n\n`);

    if (aiData) {
      // Translation with highlighted keywords
      let translationHtml = aiData.translation;
      translationHtml = translationHtml.replace(
        /\{\{(.+?)\}\}/g,
        '<span style="background-color: #ffd70033; color: #e6b800; font-weight: bold; border-bottom: 2px solid #e6b800;">$1</span>'
      );

      md.appendMarkdown(`**中文翻译:**\n\n`);
      md.appendMarkdown(`${translationHtml}\n\n`);

      // Keywords mapping
      if (aiData.keywords.length > 0) {
        md.appendMarkdown(`**关键词对应:**\n\n`);
        for (const kw of aiData.keywords) {
          const cn = resolveCoreTerm(kw.en, kw.cn);
          if (!cn) continue;
          md.appendMarkdown(`- \`${kw.en}\` ↔ **${cn}**\n`);
        }
        md.appendMarkdown(`\n`);
      }

      md.appendMarkdown(`---\n\n`);

      // Analysis
      md.appendMarkdown(`**错误分析:**\n\n${aiData.analysis}\n\n`);

      // Fix suggestion
      md.appendMarkdown(`**修复建议:**\n\n${aiData.fixSuggestion}\n\n`);
    } else {
      md.appendMarkdown(`*正在调用 AI 分析...*\n\n`);
    }

    // Link to full analysis panel
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`[📋 查看完整分析](command:errAnalyst.focusPanel)`);

    return md;
  }

  /**
   * Trigger the hover to show by revealing the error line.
   */
  async revealErrorLine(error: ErrorAnalysisResult): Promise<void> {
    if (!error.filePath) return;
    try {
      const doc = await vscode.workspace.openTextDocument(error.filePath);
      const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true });
      const lineIdx = Math.max(0, error.lineNumber - 1);
      const range = doc.lineAt(lineIdx).range;
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch { /* silent fail */ }
  }
}
