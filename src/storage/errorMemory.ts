import * as path from 'path';
import { ErrorAnalysisResult } from '../config';
import type { ChainEntry, StackFrame } from '../parser';
import * as errStore from '../shared/err-store';

export interface CacheEntry {
  format: string;
  errorKey: string;
  errorType: string;
  errorMessage: string;
  translation: string;
  keywords: Array<{ cn: string; en: string }>;
  analysis: string;
  fixSuggestion: string;
  fullTraceback: string;
  stackFrames: StackFrame[];
  chain: ChainEntry[];
  filePath?: string;
  lineNumber?: number;
  category?: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
}

const MAX_CACHE_SIZE = 200;
const CACHE_FORMAT = 'core-terms-v1';

export class ErrorMemory {
  private cache: Map<string, CacheEntry> = new Map();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const entries = errStore.readCache();
      if (entries.length > 0 && entries.some(e => e.format !== CACHE_FORMAT)) {
        errStore.clearCache();
        console.log('ErrAnalyst: 缓存格式已升级，已清空旧缓存');
        this.initialized = true;
        return;
      }
      for (const entry of entries) {
        entry.translation = entry.translation || '';
        entry.keywords = entry.keywords || [];
        entry.analysis = entry.analysis || '';
        entry.fixSuggestion = entry.fixSuggestion || '';
        entry.fullTraceback = entry.fullTraceback || '';
        entry.stackFrames = entry.stackFrames || [];
        entry.chain = entry.chain || [];
        this.cache.set(entry.errorKey, entry);
      }
      this.initialized = true;
    } catch (e) {
      console.error('ErrAnalyst: Failed to load cache', e);
    }
  }

  /**
   * Cache a new error analysis.
   */
  cacheResult(result: ErrorAnalysisResult): void {
    if (!result.translation) return;

    const errorKey = buildErrorKey(result.errorType, result.stackFrames);

    const entry: CacheEntry = {
      format: CACHE_FORMAT,
      errorKey,
      errorType: result.errorType,
      errorMessage: result.errorMessage,
      translation: result.translation || '',
      keywords: (result.keywords || []).map(k => ({ cn: k.cn, en: k.en })),
      analysis: result.analysis || '',
      fixSuggestion: result.fixSuggestion || '',
      fullTraceback: result.fullTraceback || '',
      stackFrames: result.stackFrames || [],
      chain: result.chain || [],
      filePath: result.filePath,
      lineNumber: result.lineNumber,
      category: result.category,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      count: 1
    };

    this.cache.set(errorKey, entry);
    this.persist();
  }

  /**
   * 冷却期内同一报错再次出现时累计次数，不覆盖既有分析内容。
   * 仅当该错误已有缓存条目时生效。
   */
  recordOccurrence(result: ErrorAnalysisResult): void {
    const errorKey = buildErrorKey(result.errorType, result.stackFrames);
    const existing = this.cache.get(errorKey);
    if (!existing) return;
    existing.count += 1;
    existing.lastSeen = Date.now();
    this.persist();
  }

  /**
   * Get all cached entries (most recent first).
   */
  getAll(): CacheEntry[] {
    return Array.from(this.cache.values())
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  clear(): void {
    this.cache.clear();
    this.persist();
  }

  private persist(): void {
    try {
      const entries = Array.from(this.cache.values())
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .slice(0, MAX_CACHE_SIZE);
      errStore.writeCache(entries);
    } catch (e) {
      console.error('ErrAnalyst: Failed to persist cache', e);
    }
  }

}

export function buildErrorKey(errorType: string, stackFrames: StackFrame[]): string {
  const topFile = stackFrames.length > 0
    ? path.basename(stackFrames[stackFrames.length - 1].file)
    : '';
  return `${errorType.toLowerCase().replace(/[^a-z0-9]/g, '')}:${topFile}`;
}
