export interface CatalogModel {
  id: string;
  tier: 'fast' | 'balanced' | 'strong';
  recommended?: boolean;
  deprecated?: boolean;
  deprecatedAt?: string;
  migrateTo?: string;
  description?: string;
}

export interface CatalogProvider {
  name: string;
  baseUrl: string;
  models: CatalogModel[];
}

export type PresetModelStatus = 'valid' | 'deprecated' | 'unknown';

export const CATALOG_FILE: string;

export function loadCatalog(): {
  version: number;
  updatedAt: string;
  sources: Record<string, string>;
  providers: Record<string, { baseUrl: string; models: CatalogModel[] }>;
};

export function getPresetProviders(): Array<{ name: string; baseUrl: string }>;
export function getPresetModelList(providerName: string): CatalogModel[];
export function getActiveModels(providerName: string): CatalogModel[];
export function getRecommendedModel(providerName: string): string;
export function getModelStatus(providerName: string, model: string): PresetModelStatus;
export function isValidModel(providerName: string, model: string): boolean;
export function getDeprecationInfo(
  providerName: string,
  model: string
): { deprecatedAt: string; migrateTo: string } | null;
export function buildPresetRejectionMessage(providerName: string, model: string): string;
