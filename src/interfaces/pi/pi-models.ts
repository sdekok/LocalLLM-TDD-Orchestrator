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

/** Read Pi's ~/.pi/agent/llama-cpp-cache.json and return cached model IDs for a given baseUrl. */
export function readPiCachedModels(baseUrl: string, homeDir = os.homedir()): string[] {
  const cachePath = path.join(homeDir, '.pi', 'agent', 'llama-cpp-cache.json');
  if (!fs.existsSync(cachePath)) return [];
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as PiLlamaCppCache;
    const entry = Object.values(cache).find(e => e.baseUrl === baseUrl);
    return entry?.models.map(m => m.id) ?? [];
  } catch {
    return [];
  }
}
