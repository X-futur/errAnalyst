import type { ParsedTraceback } from './parser';
import type { ErrorRecognitionTier } from './config';

// ── 流式触发常量 ──
export const STREAM_GRACE_MS = 1200;
export const STREAM_HARD_CAP_MS = 5000;
export const STRUCTURED_COOLDOWN_MS = 10000;
export const LOG_LINE_COOLDOWN_MS = 60000;
export const UPGRADE_WINDOW_MS = 10000;

/** 分档冷却时长：结构化 10 秒、日志档 60 秒。 */
export function getCooldownMs(tier: ErrorRecognitionTier): number {
  return tier === 'log-line' ? LOG_LINE_COOLDOWN_MS : STRUCTURED_COOLDOWN_MS;
}

const LOG_LEVEL_RE =
  /^(?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\s+|\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]\s+)?\[?(?:ERROR|CRITICAL|FATAL)\b\]?/;

/** 判断一个数据块命中哪个流式触发档位；未命中返回 null。 */
export function detectStreamTier(chunk: string): ErrorRecognitionTier | null {
  for (const raw of chunk.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Python Traceback 头部或具体错误类型行
    if (
      line.startsWith('Traceback') ||
      /^[A-Za-z0-9_.]+(?:Error|Exception|Warning|StopIteration)\s*:/.test(line)
    ) {
      return 'structured';
    }
    // ERROR/CRITICAL/FATAL 级日志行
    if (LOG_LEVEL_RE.test(line)) {
      return 'log-line';
    }
  }
  return null;
}

const GENERIC_ERROR_TYPES = new Set(['Error', 'Exception', 'Warning']);

/**
 * 流式结构化档的门槛：有栈帧即可；无栈帧时必须能解析出具体 Python
 * 错误类型（排除通用的 Error/Exception/Warning），避免被框架日志带偏。
 */
export function isStreamStructuredEligible(parseResult: ParsedTraceback): boolean {
  if (parseResult.stackFrames.length > 0) return true;
  return !GENERIC_ERROR_TYPES.has(parseResult.errorType);
}

const LOG_LINE_EXTRACT_RE =
  /^(?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\s+|\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]\s+)?\[?(ERROR|CRITICAL|FATAL)\b\]?\s*(?::\s*)?(.*)$/;

/**
 * 从缓冲尾部提取最近一条 ERROR/CRITICAL/FATAL 日志行，返回日志档结果。
 * 纯日志行没有栈帧与文件定位，errorType 固定为 RuntimeLog。
 */
export function extractLogError(buffer: string): {
  errorType: string;
  errorMessage: string;
  line: string;
} | null {
  const lines = buffer.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = line.match(LOG_LINE_EXTRACT_RE);
    if (!m) continue;
    let message = (m[2] || '').trim();
    // 去掉 logger 名（如 root:、uvicorn.error:），保留实际错误内容
    message = message.replace(/^[A-Za-z0-9_.\-]+\s*:\s*/, '').trim();
    if (!message) continue;
    return { errorType: 'RuntimeLog', errorMessage: message, line };
  }
  return null;
}

/** 归一化日志内容（剥离时间戳）用于冷却去重。 */
export function normalizeLogMessage(message: string): string {
  return message
    .replace(/\[\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}:\d{2}(?:\.\d+)?\]/g, '')
    .replace(/\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
