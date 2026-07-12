"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorMemory = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const CACHE_FILE = path.join(os.homedir(), '.errAnalyst', 'cache.json');
const MAX_CACHE_SIZE = 200;
const SIMILARITY_THRESHOLD = 0.6;
class ErrorMemory {
    constructor() {
        this.cache = new Map();
        this.initialized = false;
    }
    async init() {
        if (this.initialized)
            return;
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
        }
        catch (e) {
            console.error('ErrAnalyst: Failed to load cache', e);
        }
    }
    /**
     * Find a cached solution for the given error.
     */
    findCached(errorKey) {
        // Exact match
        if (this.cache.has(errorKey)) {
            const entry = this.cache.get(errorKey);
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
    cacheResult(result) {
        if (!result.translation)
            return;
        const topFile = result.stackFrames.length > 0
            ? path.basename(result.stackFrames[result.stackFrames.length - 1].file)
            : '';
        const errorKey = `${result.errorType.toLowerCase().replace(/[^a-z0-9]/g, '')}:${topFile}`;
        const entry = {
            errorKey,
            errorType: result.errorType,
            errorMessage: result.errorMessage,
            translation: result.translation || '',
            keywords: (result.keywords || []).map(k => ({ cn: k.cn, en: k.en })),
            analysis: result.analysis || '',
            fixSuggestion: result.fixSuggestion || '',
            fixCode: result.fixCode || '',
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
    getAll() {
        return Array.from(this.cache.values())
            .sort((a, b) => b.lastSeen - a.lastSeen);
    }
    clear() {
        this.cache.clear();
        this.persist();
    }
    persist() {
        try {
            // Trim to max size
            const entries = Array.from(this.cache.values())
                .sort((a, b) => b.lastSeen - a.lastSeen)
                .slice(0, MAX_CACHE_SIZE);
            fs.writeFileSync(CACHE_FILE, JSON.stringify(entries, null, 2), 'utf-8');
        }
        catch (e) {
            console.error('ErrAnalyst: Failed to persist cache', e);
        }
    }
    similar(a, b) {
        if (a === b)
            return 1;
        const shorter = a.length < b.length ? a : b;
        const longer = a.length < b.length ? b : a;
        if (longer.length === 0)
            return 1;
        const editDist = this.levenshtein(shorter, longer);
        return 1 - editDist / longer.length;
    }
    levenshtein(a, b) {
        const matrix = [];
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
                }
                else {
                    matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
                }
            }
        }
        return matrix[b.length][a.length];
    }
}
exports.ErrorMemory = ErrorMemory;
//# sourceMappingURL=errorMemory.js.map