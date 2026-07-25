import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ErrorAnalysisResult } from '../config';

interface CacheEntry {
  errorKey: string;
  errorType: string;
  errorMessage: string;
  translation: string;
  keywords: Array<{ cn: string; en: string }>;
  analysis: string;
  fixSuggestion: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
}

const CACHE_FILE = path.join(os.homedir(), '.errAnalyst', 'cache.json');
const MAX_CACHE_SIZE = 200;
const SIMILARITY_THRESHOLD = 0.6;

export class ErrorMemory {
  private cache: Map<string, CacheEntry> = new Map();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(CACHE_FILE)) {
        const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        for (const entry of data) {
          this.cache.set(entry.errorKey, entry);
        }
      }
      this.initialized = true;
    } catch (e) {
      console.error('ErrAnalyst: Failed to load cache', e);
    }
  }

  /**
   * Find a cached solution for the given error.
   */
  findCached(errorKey: string): CacheEntry | null {
    // Exact match
    if (this.cache.has(errorKey)) {
      const entry = this.cache.get(errorKey)!;
      entry.lastSeen = Date.now();
      entry.count++;
      this.persist();
      return entry;
    }

    // Fuzzy match by error type prefix
    const errorTypeBase = errorKey.split(':')[0];
    for (const [key, entry] of this.cache.entries()) {
      if (key.startsWith(errorTypeBase) && this.similar(errorKey, key) > SIMILARITY_THRESHOLD) {
        entry.lastSeen = Date.now();
        entry.count++;
        this.persist();
        return entry;
      }
    }

    return null;
  }

  /**
   * Cache a new error analysis.
   */
  cacheResult(result: ErrorAnalysisResult): void {
    if (!result.translation) return;

    const topFile = result.stackFrames.length > 0
      ? path.basename(result.stackFrames[result.stackFrames.length - 1].file)
      : '';
    const errorKey = `${result.errorType.toLowerCase().replace(/[^a-z0-9]/g, '')}:${topFile}`;

    const entry: CacheEntry = {
      errorKey,
      errorType: result.errorType,
      errorMessage: result.errorMessage,
      translation: result.translation || '',
      keywords: (result.keywords || []).map(k => ({ cn: k.cn, en: k.en })),
      analysis: result.analysis || '',
      fixSuggestion: result.fixSuggestion || '',
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      count: 1
    };

    this.cache.set(errorKey, entry);
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
      fs.writeFileSync(CACHE_FILE, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (e) {
      console.error('ErrAnalyst: Failed to persist cache', e);
    }
  }

  private similar(a: string, b: string): number {
    if (a === b) return 1;
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    if (longer.length === 0) return 1;
    const editDist = this.levenshtein(shorter, longer);
    return 1 - editDist / longer.length;
  }

  private levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }
}
