import * as path from 'path';

const SENSITIVE_KEY_RE =
  /(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|passwd|password|pwd|credential)/i;
const SUFFIX_KEY_RE = /(?:^|_|-)(?:key|token|secret|password|pwd|credential)$/i;

/** True for keys that look like secrets (api keys, tokens, passwords...). */
export function isSensitiveKey(key: string): boolean {
  const k = key.trim().replace(/^['"]|['"]$/g, '');
  return SENSITIVE_KEY_RE.test(k) || SUFFIX_KEY_RE.test(k);
}

/** True for files whose whole content is treated as configuration. */
export function isConfigLikePath(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (/^\.env(\..+)?$/.test(base)) return true;
  const ext = path.extname(base);
  return [
    '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  ].includes(ext);
}

/**
 * Replace sensitive values in config text with a configured/empty marker so
 * secrets never reach the LLM, while keeping non-secret values (URLs, hosts...).
 */
export function sanitizeConfigText(content: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return sanitizeJson(content);
  if (ext === '.yaml' || ext === '.yml') return sanitizeYaml(content);
  return sanitizeKeyValue(content);
}

function sanitizeKeyValue(content: string): string {
  return content.split('\n').map((line) => {
    const body = line.trimStart();
    const stripped = body.startsWith('export ') ? body.slice(7) : body;
    const eq = stripped.indexOf('=');
    if (eq <= 0) return line;
    const key = stripped.slice(0, eq).trim();
    if (!isSensitiveKey(key)) return line;
    const rawValue = stripped.slice(eq + 1);
    const hasValue =
      rawValue.trim().length > 0 &&
      rawValue.trim() !== '""' &&
      rawValue.trim() !== "''";
    const marker = hasValue ? '(已配置)' : '(为空)';
    const prefix = line.slice(0, line.length - body.length);
    const head = body.startsWith('export ') ? 'export ' : '';
    return prefix + head + key + '=' + marker;
  }).join('\n');
}

function sanitizeJson(content: string): string {
  return content.replace(
    /"([^"]+)":\s*("(?:[^"\\]|\\.)*"|[^,\s}\]]+)/g,
    (match, key: string, value: string) => {
      if (!isSensitiveKey(key)) return match;
      const hasValue = value !== '""' && value !== 'null' && value.trim() !== '';
      return `"${key}": ${hasValue ? '"(已配置)"' : '"(为空)"'}`;
    },
  );
}

function sanitizeYaml(content: string): string {
  return content.split('\n').map((line) => {
    const m = line.match(/^(\s*)([^#][^:]*):\s*(.*)$/);
    if (!m) return line;
    const key = m[2].trim();
    if (!isSensitiveKey(key)) return line;
    const hasValue =
      m[3].trim().length > 0 &&
      m[3].trim() !== '""' &&
      m[3].trim() !== "''";
    return `${m[1]}${m[2].replace(/\s+$/, '')}: ${hasValue ? '(已配置)' : '(为空)'}`;
  }).join('\n');
}
