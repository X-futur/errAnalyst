export const ERR_DIR: string;
export const MEMORY_FILE: string;

export interface MemoryStoreData {
  format: string;
  preferences: unknown[];
  errorStats: Record<string, number>;
}

export function ensureDir(): void;
export function readMemory(file?: string): MemoryStoreData | null;
export function writeMemory(data: MemoryStoreData, file?: string): void;
export function clearMemory(file?: string): void;
