import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface PiModelsJson {
  providers?: Record<string, {
    baseUrl?: string;
    api?: string;
  }>;
}

interface PiLlamaCppCacheEntry {
  baseUrl: string;
  models: Array<{ id: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }>;
}

interface PiLlamaCppCache {
  [providerKey: string]: PiLlamaCppCacheEntry;
}

export interface PiLlamaCppProvider {
  name: string;
  baseUrl: string;
}

/** Read Pi's ~/.pi/agent/models.json and return all llamacpp providers. */
export function readPiLlamaCppProviders(homeDir = os.homedir()): PiLlamaCppProvider[] {
  const piModelsPath = path.join(homeDir, '.pi', 'agent', 'models.json');
  if (!fs.existsSync(piModelsPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(piModelsPath, 'utf-8')) as PiModelsJson;
    return Object.entries(raw.providers ?? {})
      .filter(([, p]) => p.api === 'llamacpp' && p.baseUrl)
      .map(([name, p]) => ({ name, baseUrl: p.baseUrl! }));
  } catch {
    return [];
  }
}

export interface PiCachedModelInfo {
  id: string;
  reasoning: boolean;
}

function loadCacheEntry(baseUrl: string, homeDir: string): PiLlamaCppCacheEntry | undefined {
  const cachePath = path.join(homeDir, '.pi', 'agent', 'llama-cpp-cache.json');
  if (!fs.existsSync(cachePath)) return undefined;
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as PiLlamaCppCache;
    return Object.values(cache).find(e => e.baseUrl === baseUrl);
  } catch {
    return undefined;
  }
}

/** Read Pi's ~/.pi/agent/llama-cpp-cache.json and return cached model IDs for a given baseUrl. */
export function readPiCachedModels(baseUrl: string, homeDir = os.homedir()): string[] {
  return loadCacheEntry(baseUrl, homeDir)?.models.map(m => m.id) ?? [];
}

/**
 * Return a map of model ID → PiCachedModelInfo (including reasoning flag)
 * for all models cached under the given baseUrl.
 */
export function readPiCachedModelInfo(baseUrl: string, homeDir = os.homedir()): Map<string, PiCachedModelInfo> {
  const entry = loadCacheEntry(baseUrl, homeDir);
  const map = new Map<string, PiCachedModelInfo>();
  for (const m of entry?.models ?? []) {
    map.set(m.id, { id: m.id, reasoning: m.reasoning ?? false });
  }
  return map;
}
