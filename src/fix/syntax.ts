import Prism from 'prismjs';

// Prism components register languages on the shared Prism instance.
// They must be loaded before Prism.tokenize is called for those languages.
require('prismjs/components/prism-clike');
require('prismjs/components/prism-javascript');
require('prismjs/components/prism-typescript');
require('prismjs/components/prism-json');
require('prismjs/components/prism-yaml');
require('prismjs/components/prism-bash');
require('prismjs/components/prism-markup');
require('prismjs/components/prism-markdown');
require('prismjs/components/prism-python');

/**
 * Syntax highlighting for the fix preview tab.
 *
 * The preview renders one line per div, so Prism is asked to tokenize the
 * whole file (keeping cross-line constructs like triple-quoted strings
 * intact) and the resulting structured token stream is split at newline
 * boundaries. Every line is a self-contained HTML fragment.
 *
 * Colors follow VS Code's default Python highlighting (Dark+ / Light+),
 * resolved from the bundled MagicPython grammar + theme rules, so switching
 * between the preview tab and the editor looks natural.
 */

export type SyntaxLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'yaml'
  | 'bash'
  | 'markdown';

type TokClass =
  | 'kw' // keywords / storage types (def, class, import) — blue
  | 'ctrl' // control flow keywords (if, for, return) — purple
  | 'string'
  | 'comment'
  | 'number'
  | 'fn' // function names, builtins, decorators, magic methods — yellow
  | 'type' // class names, types, exception types — teal
  | 'var' // parameters, properties, self (parameter position) — light blue
  | 'const'; // True / False / None / null / booleans — blue

/** Map a file path to the syntax language used for highlighting. */
export function languageForFile(file: string): SyntaxLanguage | null {
  const name = file.toLowerCase();
  if (name.endsWith('.py') || name.endsWith('.pyi')) return 'python';
  if (name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs') || name.endsWith('.jsx')) {
    return 'javascript';
  }
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return 'typescript';
  if (name.endsWith('.json') || name.endsWith('.jsonc')) return 'json';
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'yaml';
  if (name.endsWith('.sh') || name.endsWith('.bash') || name.endsWith('.zsh') || name.endsWith('.command')) {
    return 'bash';
  }
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
  return null;
}

/** Highlight `text` and return one HTML fragment per line (line count preserved). */
export function highlightLines(text: string, lang: SyntaxLanguage): string[] {
  try {
    const grammar = Prism.languages[lang];
    if (!grammar) return plainLines(text);
    const tokens = Prism.tokenize(text, grammar);
    return serializeTokens(tokens, lang);
  } catch {
    return plainLines(text);
  }
}

function plainLines(text: string): string[] {
  return text.split('\n').map(line => escHtml(line));
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ── scope alignment: Prism token types + word lists → VS Code default theme ──

/** Python keywords that VS Code renders purple (keyword.control.*). */
const PY_CONTROL = new Set([
  'if', 'elif', 'else', 'for', 'while', 'return', 'yield', 'break', 'continue',
  'raise', 'try', 'except', 'finally', 'with', 'pass', 'assert', 'global',
  'nonlocal', 'del', 'await', 'in', 'import', 'from', 'as',
]);

/** Python keywords that VS Code renders blue (storage.type.*). */
const PY_STORAGE = new Set(['def', 'class', 'async', 'lambda']);

/** Python logical/identity operators that VS Code renders blue (keyword.operator.logical). */
const PY_LOGICAL = new Set(['and', 'or', 'not', 'is']);

/** Builtin functions rendered yellow (support.function.builtin) by MagicPython. */
const PY_FUNC_BUILTINS = new Set([
  'print', 'len', 'range', 'input', 'open', 'repr', 'format', 'bin', 'oct',
  'hex', 'ord', 'chr', 'super', 'property', 'classmethod', 'staticmethod',
  'vars', 'globals', 'locals', 'hasattr', 'getattr', 'setattr', 'delattr',
  'callable', 'hash', 'iter', 'next', 'any', 'all', 'enumerate', 'zip', 'map',
  'filter', 'sorted', 'reversed', 'min', 'max', 'sum', 'abs', 'round',
  'isinstance', 'issubclass', 'divmod', 'pow', 'id', 'dir', 'compile', 'exec',
  'eval', '__import__', 'bool', 'bytes', 'bytearray', 'frozenset', 'help',
  'memoryview', 'object',
]);

/** Builtin types rendered teal (support.type) by MagicPython. */
const PY_TYPE_BUILTINS = new Set([
  'int', 'float', 'str', 'list', 'dict', 'set', 'tuple', 'type', 'bytes',
  'bytearray', 'bool', 'object', 'complex', 'slice', 'frozenset',
]);

const JS_CONTROL = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'return',
  'break', 'continue', 'throw', 'try', 'catch', 'finally', 'async', 'await',
  'yield',
]);

const BASH_CONTROL = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'function', 'select', 'return', 'break', 'continue',
]);

function tokenClass(lang: SyntaxLanguage, token: Prism.Token): TokClass | null {
  const type = token.type;
  const text = typeof token.content === 'string' ? token.content.trim() : '';

  if (lang === 'python') {
    if (type === 'keyword') {
      if (PY_CONTROL.has(text)) return 'ctrl';
      if (PY_STORAGE.has(text)) return 'kw';
      if (PY_LOGICAL.has(text)) return 'kw';
      if (PY_FUNC_BUILTINS.has(text)) return 'fn'; // Prism marks print etc. as keyword
      return 'kw';
    }
    if (type === 'builtin') {
      if (PY_TYPE_BUILTINS.has(text)) return 'type';
      return 'fn';
    }
    if (type === 'boolean') return 'const';
    if (type === 'function') return 'fn';
    if (type === 'class-name') return 'type';
    if (type === 'decorator') return 'fn';
    if (type === 'string' || type === 'triple-quoted-string' || type === 'string-interpolation') return 'string';
    if (type === 'comment') return 'comment';
    if (type === 'number') return 'number';
    if (type === 'variable' || type === 'parameter' || type === 'parameter-2') return 'var';
    if (type === 'operator' || type === 'punctuation') return null;
    return null;
  }

  if (lang === 'javascript' || lang === 'typescript') {
    if (type === 'keyword') return JS_CONTROL.has(text) ? 'ctrl' : 'kw';
    if (type === 'boolean' || type === 'constant') return 'const';
    if (type === 'function') return 'fn';
    if (type === 'class-name') return 'type';
    if (type === 'string' || type === 'template-string' || type === 'regex') return 'string';
    if (type === 'comment') return 'comment';
    if (type === 'number') return 'number';
    if (type === 'property' || type === 'parameter' || type === 'variable') return 'var';
    if (type === 'operator' || type === 'punctuation') return null;
    return null;
  }

  if (lang === 'bash') {
    if (type === 'keyword') return BASH_CONTROL.has(text) ? 'ctrl' : 'kw';
    if (type === 'boolean') return 'const';
    if (type === 'function') return 'fn';
    if (type === 'string' || type === 'regex') return 'string';
    if (type === 'comment') return 'comment';
    if (type === 'number') return 'number';
    if (type === 'variable' || type === 'parameter') return 'var';
    if (type === 'operator' || type === 'punctuation') return null;
    return null;
  }

  if (lang === 'json') {
    if (type === 'property') return 'var';
    if (type === 'string') return 'string';
    if (type === 'number') return 'number';
    if (type === 'boolean' || type === 'constant') return 'const';
    if (type === 'operator' || type === 'punctuation') return null;
    return null;
  }

  if (lang === 'yaml') {
    if (type === 'key') return 'var';
    if (type === 'string' || type === 'plain') return 'string';
    if (type === 'comment') return 'comment';
    if (type === 'number') return 'number';
    if (type === 'boolean' || type === 'constant') return 'const';
    if (type === 'important') return 'fn';
    if (type === 'operator' || type === 'punctuation') return null;
    return null;
  }

  // markdown: minimal but recognizable coloring for a raw code view.
  if (type === 'heading') return 'kw';
  if (type === 'code') return 'string';
  if (type === 'url') return 'var';
  if (type === 'bold' || type === 'italic') return 'fn';
  return null;
}

// ── serialize the structured token stream into per-line HTML ──

interface LineBuffer {
  parts: string[];
  /** Classes of spans currently open (re-opened after every newline). */
  open: string[];
}

function serializeTokens(tokens: Array<string | Prism.Token>, lang: SyntaxLanguage): string[] {
  const lines: string[] = [];
  const buf: LineBuffer = { parts: [], open: [] };
  walk(tokens, lang, buf, lines);
  // Flush the last line (the source text never ends with a newline here).
  lines.push(buf.parts.join(''));
  return lines;
}

function walk(
  tokens: Array<string | Prism.Token>,
  lang: SyntaxLanguage,
  buf: LineBuffer,
  lines: string[],
): void {
  for (const token of tokens) {
    if (typeof token === 'string') {
      appendText(buf, lines, token);
      continue;
    }
    const cls = tokenClass(lang, token);
    if (cls) {
      buf.parts.push(`<span class="tok-${cls}">`);
      buf.open.push(cls);
    }
    walk(toArray(token.content), lang, buf, lines);
    if (cls) {
      buf.parts.push('</span>');
      buf.open.pop();
    }
  }
}

function toArray(content: string | Prism.Token | Array<string | Prism.Token>): Array<string | Prism.Token> {
  return Array.isArray(content) ? content : [content];
}

function appendText(buf: LineBuffer, lines: string[], text: string): void {
  const segments = text.split('\n');
  for (let i = 0; i < segments.length; i++) {
    buf.parts.push(escHtml(segments[i]));
    if (i < segments.length - 1) {
      for (let j = buf.open.length - 1; j >= 0; j--) buf.parts.push('</span>');
      lines.push(buf.parts.join(''));
      buf.parts = [];
      for (const cls of buf.open) buf.parts.push(`<span class="tok-${cls}">`);
    }
  }
}
