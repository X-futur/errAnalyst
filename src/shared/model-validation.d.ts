export type CustomModelStatus = 'official' | 'unofficial' | 'unverified';

export const DEFAULT_TIMEOUT: number;

export function fetchModelList(
  baseUrl: string,
  apiKey: string,
  timeoutMs?: number
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }>;

export function testChatConnection(
  baseUrl: string,
  model: string,
  apiKey: string,
  timeoutMs?: number
): Promise<{ ok: boolean; error?: string }>;

export function validateCustomModel(
  baseUrl: string,
  model: string,
  apiKey: string,
  timeoutMs?: number
): Promise<
  | { ok: true; status: CustomModelStatus }
  | { ok: false; status: CustomModelStatus; error: string }
>;

export function modelStatusLabel(status: string): string;
