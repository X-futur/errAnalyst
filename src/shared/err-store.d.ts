export const ERR_DIR: string;
export const CACHE_FILE: string;

export function ensureDir(): void;
export function readCache(): any[];
export function writeCache(entries: any[]): void;
export function clearCache(): void;
