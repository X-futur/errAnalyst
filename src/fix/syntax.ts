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
  | 'fn' // function definition names, decorators — function color
  | 'builtin' // builtin function calls (print, len) — builtin color
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
    return serializeTokens(tokens, lang, text);
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
      if (PY_FUNC_BUILTINS.has(text)) return 'builtin'; // Prism marks print etc. as keyword
      return 'kw';
    }
    if (type === 'builtin') {
      if (PY_TYPE_BUILTINS.has(text)) return 'type';
      return 'builtin';
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

interface FlatSeg {
  text: string;
  /** Open span classes at this segment (re-opened after every newline). */
  stack: string[];
  /** Absolute offset of `text` inside the source passed to highlightLines. */
  start: number;
}

function serializeTokens(tokens: Array<string | Prism.Token>, lang: SyntaxLanguage, rawText: string): string[] {
  const segs = flatten(tokens, lang);
  markFunctionCalls(segs, lang, rawText);
  return renderLines(segs);
}

function flatten(tokens: Array<string | Prism.Token>, lang: SyntaxLanguage): FlatSeg[] {
  const out: FlatSeg[] = [];
  const stack: string[] = [];
  let offset = 0;
  const walk = (toks: Array<string | Prism.Token>): void => {
    for (const token of toks) {
      if (typeof token === 'string') {
        out.push({ text: token, stack: [...stack], start: offset });
        offset += token.length;
        continue;
      }
      const cls = tokenClass(lang, token);
      if (cls) stack.push(cls);
      walk(toArray(token.content));
      if (cls) stack.pop();
    }
  };
  walk(tokens);
  return out;
}

function toArray(content: string | Prism.Token | Array<string | Prism.Token>): Array<string | Prism.Token> {
  return Array.isArray(content) ? content : [content];
}

const TRAILING_IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * VS Code's Python grammar (MagicPython) colors function calls — including
 * imported functions like `query_db(...)` or `os.path.join(...)` — while
 * Prism leaves call sites as plain text. This pass scans plain code regions
 * (never strings/comments) and marks identifiers directly followed by `(` as
 * function calls; exception-like names keep the teal type color.
 */
function markFunctionCalls(segs: FlatSeg[], lang: SyntaxLanguage, rawText: string): void {
  if (lang !== 'python' && lang !== 'javascript' && lang !== 'typescript') return;
  for (const seg of segs) {
    if (seg.stack.length > 0) continue; // inside string / comment / other token
    const m = TRAILING_IDENT_RE.exec(seg.text);
    if (!m) continue;
    const ident = m[0];
    // Exception-like names are teal even without a call (raise / except).
    if (lang === 'python' && PY_EXCEPTION_RE.test(ident)) {
      seg.stack = ['type'];
      continue;
    }
    const followedByParen = /^\s*\(/.test(rawText.slice(seg.start + seg.text.length));
    if (!followedByParen) continue;
    if (lang === 'python' && /^[A-Z]/.test(ident)) {
      seg.stack = ['type']; // PascalCase callables are class instantiations in the editor
    } else {
      seg.stack = ['fn'];
    }
  }
}

/** Exception/error-like names MagicPython renders as support.type (teal). */
const PY_EXCEPTION_RE = /(?:Error|Exception|Warning|Interrupt|Exit|Iteration)$/;

function renderLines(segs: FlatSeg[]): string[] {
  const lines: string[] = [];
  let parts: string[] = [];
  let openStack: string[] = [];

  const flushLine = (): void => {
    for (let j = openStack.length - 1; j >= 0; j--) parts.push('</span>');
    lines.push(parts.join(''));
    parts = [];
    for (const cls of openStack) parts.push(`<span class="tok-${cls}">`);
  };

  for (const seg of segs) {
    let common = 0;
    while (
      common < openStack.length
      && common < seg.stack.length
      && openStack[common] === seg.stack[common]
    ) common++;
    for (let j = openStack.length - 1; j >= common; j--) parts.push('</span>');
    for (let j = common; j < seg.stack.length; j++) parts.push(`<span class="tok-${seg.stack[j]}">`);
    openStack = [...seg.stack];

    const textSegments = seg.text.split('\n');
    for (let k = 0; k < textSegments.length; k++) {
      parts.push(escHtml(textSegments[k]));
      if (k < textSegments.length - 1) flushLine();
    }
  }
  flushLine();
  return lines;
}
