import * as memoryStore from '../shared/memory-store';

export type PreferenceCategory = 'fix' | 'fixSuggestion' | 'analysis';
export type PreferenceSource = 'implicit' | 'explicit';
export type PreferenceStatus = 'active' | 'candidate';

export interface UserPreference {
  id: string;
  category: PreferenceCategory;
  statement: string;
  source: PreferenceSource;
  status: PreferenceStatus;
  confidence: number;
  createdAt: number;
  lastUsedAt: number;
  hitCount: number;
}

export interface UserMemoryData {
  format: string;
  preferences: UserPreference[];
  errorStats: Record<string, number>;
}

export const MEMORY_FORMAT = 'memory-v1';
export const MAX_INJECTED_PREFERENCES = 30;
export const TOP_ERROR_STATS = 5;
export const PROMOTE_THRESHOLD = 2;
export const CANDIDATE_CONFIDENCE = 0.5;
export const IMPLICIT_CONFIDENCE_BASE = 0.6;
export const IMPLICIT_CONFIDENCE_MAX = 0.9;
export const EXPLICIT_CONFIDENCE = 1;

export const CATEGORY_LABELS: Record<PreferenceCategory, string> = {
  fix: '修复偏好',
  fixSuggestion: '修复建议偏好',
  analysis: '错误分析偏好',
};

export const SOURCE_LABELS: Record<PreferenceSource, string> = {
  implicit: '行为推断',
  explicit: '用户声明',
};

export const CATEGORY_OPTIONS: Array<{ value: PreferenceCategory; label: string }> = [
  { value: 'fix', label: CATEGORY_LABELS.fix },
  { value: 'fixSuggestion', label: CATEGORY_LABELS.fixSuggestion },
  { value: 'analysis', label: CATEGORY_LABELS.analysis },
];

function emptyData(): UserMemoryData {
  return { format: MEMORY_FORMAT, preferences: [], errorStats: {} };
}

/**
 * Long-term user memory: semantic preferences (fix / fixSuggestion / analysis)
 * plus behavioral error-type statistics, persisted to ~/.errAnalyst/memory.json.
 * Episodic data is deliberately NOT stored — accepted/rejected hunks are only
 * distilled into preference statements here.
 */
export class UserMemory {
  private data: UserMemoryData = emptyData();
  private initialized = false;
  private idCounter = 0;

  constructor(private readonly file?: string) {}

  init(): void {
    if (this.initialized) return;
    const raw = memoryStore.readMemory(this.file);
    if (raw) {
      if (raw.format !== MEMORY_FORMAT) {
        console.log('ErrAnalyst: 长期记忆格式已升级，已重置记忆档案');
        this.data = emptyData();
        this.persist();
      } else {
        this.data = {
          format: MEMORY_FORMAT,
          preferences: Array.isArray(raw.preferences) ? raw.preferences as UserPreference[] : [],
          errorStats: raw.errorStats && typeof raw.errorStats === 'object' ? raw.errorStats : {},
        };
      }
    } else {
      this.data = emptyData();
    }
    this.initialized = true;
  }

  getAll(): UserPreference[] {
    return [...this.data.preferences].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return b.lastUsedAt - a.lastUsedAt;
    });
  }

  /** Active preferences for the given categories, newest-use first, capped. */
  getInjectionPreferences(categories: PreferenceCategory[]): UserPreference[] {
    const now = Date.now();
    const picked = this.data.preferences
      .filter(p => p.status === 'active' && categories.includes(p.category))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, MAX_INJECTED_PREFERENCES);
    let touched = false;
    for (const p of picked) {
      if (now - p.lastUsedAt > 60_000) {
        p.lastUsedAt = now;
        touched = true;
      }
    }
    if (touched) this.persist();
    return picked;
  }

  getErrorStatsTop(n = TOP_ERROR_STATS): Array<{ errorType: string; count: number }> {
    return Object.entries(this.data.errorStats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([errorType, count]) => ({ errorType, count }));
  }

  /**
   * Compose the "## 用户记忆" block for a prompt. Returns null when there is
   * nothing to inject. Touches lastUsedAt on injected preferences.
   */
  buildMemoryBlock(
    categories: PreferenceCategory[],
    options: { includeStats?: boolean } = {},
  ): string | null {
    const prefs = this.getInjectionPreferences(categories);
    const stats = options.includeStats !== false ? this.getErrorStatsTop() : [];
    const lines: string[] = [];
    for (const p of prefs) {
      let tag = `[${CATEGORY_LABELS[p.category]}·${SOURCE_LABELS[p.source]}`;
      if (p.source === 'implicit') {
        tag += `·置信 ${p.confidence.toFixed(1)}·仅供参考`;
      }
      tag += ']';
      lines.push('- ' + tag + ' ' + p.statement);
    }
    if (stats.length > 0) {
      lines.push('- 常犯错误：' + stats.map(s => `${s.errorType}（${s.count} 次）`).join('、'));
    }
    if (lines.length === 0) return null;
    return '## 用户记忆\n' + lines.join('\n');
  }

  recordErrorStat(errorType: string): void {
    if (!errorType) return;
    this.data.errorStats[errorType] = (this.data.errorStats[errorType] || 0) + 1;
    this.persist();
  }

  /**
   * Implicit learning from accepted hunks: the same normalized reason observed
   * twice is promoted to an active preference; a single observation stays a
   * candidate until confirmed in `memory config`. Rejections never reach here.
   */
  recordAcceptedReasons(reasons: string[]): void {
    const groups = new Map<string, string>();
    for (const reason of reasons) {
      const normalized = normalizeReason(reason);
      if (!normalized) continue;
      if (!groups.has(normalized)) groups.set(normalized, reason.trim());
    }
    let changed = false;
    const now = Date.now();
    for (const [normalized, original] of groups) {
      const existing = this.data.preferences.find(
        p => p.source === 'implicit' && normalizeReason(p.statement) === normalized,
      );
      if (existing) {
        existing.hitCount += 1;
        existing.lastUsedAt = now;
        if (existing.status === 'candidate' && existing.hitCount >= PROMOTE_THRESHOLD) {
          existing.status = 'active';
          existing.confidence = IMPLICIT_CONFIDENCE_BASE;
        } else {
          existing.confidence = Math.min(IMPLICIT_CONFIDENCE_MAX, existing.confidence + 0.05);
        }
        changed = true;
      } else {
        this.data.preferences.push({
          id: this.makeId(),
          category: 'fix',
          statement: original,
          source: 'implicit',
          status: 'candidate',
          confidence: CANDIDATE_CONFIDENCE,
          createdAt: now,
          lastUsedAt: now,
          hitCount: 1,
        });
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  confirmCandidate(id: string): boolean {
    const pref = this.data.preferences.find(p => p.id === id);
    if (!pref || pref.status !== 'candidate') return false;
    pref.status = 'active';
    pref.confidence = Math.max(IMPLICIT_CONFIDENCE_BASE, pref.confidence);
    pref.lastUsedAt = Date.now();
    this.persist();
    return true;
  }

  addExplicit(category: PreferenceCategory, statement: string): UserPreference | null {
    const text = statement.trim();
    if (!text) return null;
    const pref: UserPreference = {
      id: this.makeId(),
      category,
      statement: text,
      source: 'explicit',
      status: 'active',
      confidence: EXPLICIT_CONFIDENCE,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      hitCount: 0,
    };
    this.data.preferences.push(pref);
    this.persist();
    return pref;
  }

  updateEntry(
    id: string,
    patch: { category?: PreferenceCategory; statement?: string },
  ): boolean {
    const pref = this.data.preferences.find(p => p.id === id);
    if (!pref) return false;
    if (patch.category && CATEGORY_LABELS[patch.category]) pref.category = patch.category;
    if (patch.statement && patch.statement.trim()) pref.statement = patch.statement.trim();
    this.persist();
    return true;
  }

  deleteEntry(id: string): boolean {
    const before = this.data.preferences.length;
    this.data.preferences = this.data.preferences.filter(p => p.id !== id);
    if (this.data.preferences.length === before) return false;
    this.persist();
    return true;
  }

  clearAll(): void {
    this.data = emptyData();
    this.persist();
  }

  getStats(): { active: number; candidate: number; errorTypes: number } {
    return {
      active: this.data.preferences.filter(p => p.status === 'active').length,
      candidate: this.data.preferences.filter(p => p.status === 'candidate').length,
      errorTypes: Object.keys(this.data.errorStats).length,
    };
  }

  private makeId(): string {
    return `mem-${Date.now()}-${this.idCounter++}`;
  }

  private persist(): void {
    try {
      memoryStore.writeMemory(this.data, this.file);
    } catch (e) {
      console.error('ErrAnalyst: Failed to persist user memory', e);
    }
  }
}

const STOPWORD_PREFIXES = [
  '添加', '增加', '加上', '需要', '确保', '保证', '进行',
  '改为', '改成', '对', '为', '在', '把', '将', '用', '使用',
];

const PUNCTUATION_RE = /[\uFF01-\uFF5E\u3001-\u303F！？。，、；：""''（）【】《》〈〉…—·`~!@#$%^&*()_+\-=[\]{}|;:'",.<>/?\\]/g;
const WHITESPACE_RE = /[\s\u3000]/g;

/** Trailing guard words treated as the same concept when normalizing reasons. */
const GUARD_SUFFIXES = ['保护', '防护', '检查', '校验', '判断', '判空'];

/**
 * Normalize a fix reason for identity comparison: lowercase, strip whitespace
 * and full/half-width punctuation, and strip common leading verbs ("添加",
 * "需要", ...) so that "添加 None 保护" and "需要添加None检查" collapse to the
 * same normalized form. Leading intent verbs ("删除" etc.) are preserved so
 * opposite intents never merge.
 */
export function normalizeReason(text: string): string {
  let s = text
    .toLowerCase()
    .replace(WHITESPACE_RE, '')
    .replace(PUNCTUATION_RE, '');
  let changed = true;
  while (changed && s.length > 0) {
    changed = false;
    for (const word of STOPWORD_PREFIXES) {
      if (s.startsWith(word)) {
        s = s.slice(word.length);
        changed = true;
      }
    }
  }
  for (const suffix of GUARD_SUFFIXES) {
    if (s.endsWith(suffix)) {
      s = s.slice(0, s.length - suffix.length) + '防护';
      break;
    }
  }
  return s;
}
