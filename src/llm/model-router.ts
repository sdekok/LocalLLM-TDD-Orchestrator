import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger.js';
import { getTuner } from './tuners/registry.js';

export interface SamplingParams {
  temperature?: number;
  top_k?: number;
  top_p?: number;
  min_p?: number;
  repeat_penalty?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

export type ModelProvider = 'local' | 'openrouter' | 'openai' | 'custom';
export type ModelFamily = 'gemma4' | 'qwen35' | 'llama' | 'deepseek' | 'claude' | 'generic';

export interface ModelProfile {
  name: string;
  ggufFilename: string;         // For local llama.cpp models
  modelId?: string;              // For cloud providers (e.g., 'google/gemma-3-27b-it')
  provider: ModelProvider;       // 'local' for llama.cpp, 'openrouter' for cloud
  baseURL?: string;              // Override per-model (e.g., 'https://openrouter.ai/api/v1')
  // apiKey intentionally removed — store secrets only in environment variables.
  // Use apiKeyEnvVar to name the env var, e.g. 'OPENROUTER_API_KEY'.
  apiKeyEnvVar?: string;         // Environment variable name for API key
  modelFamily?: ModelFamily;     // Model family for auto-tuning defaults and prompt handling
  enableThinking?: boolean;      // Whether to attempt to activate reasoning/thinking mode
  contextWindow: number;
  maxOutputTokens: number;
  architecture: 'dense' | 'moe' | 'unknown';
  parameterCount?: string;
  speed: 'fast' | 'medium' | 'slow';
  samplingParams?: SamplingParams;
}

/**
 * Core task types plus optional roles.
 * - plan: Task breakdown and architecture
 * - implement: TDD code generation
 * - review: Adversarial code review
 * - research: Web search and documentation lookup
 * - design: UI/UX prototyping and component specification
 * - design_review: Design system consistency and deduplication checking
 * - analyze: Algorithmic code analysis (dependency graphs, patterns)
 * - document: LLM-powered architecture documentation
 */
export type TaskType = 'plan' | 'project-plan' | 'implement' | 'review' | 'research' | 'design' | 'design_review' | 'analyze' | 'document';

export interface ModelRouterConfig {
  llamaCppUrl?: string;
  models: Record<string, ModelProfile>;
  routing: Partial<Record<TaskType, string>>;  // Partial — design roles are optional
}

const CONFIG_FILENAMES = ['models.config.json', 'models.config.local.json'];
const EXAMPLE_FILENAME = 'models.config.example.json';

/**
 * Load model config from a JSON file.
 * Search order: models.config.local.json (user override) → models.config.json → example fallback.
 */
export function loadConfig(projectDir?: string): ModelRouterConfig | null {
  const searchDirs = [
    projectDir,
    process.env.TDD_WORKFLOW_CONFIG_DIR,
    path.dirname(new URL(import.meta.url).pathname), // Same dir as this file
    process.cwd(),
  ].filter(Boolean) as string[];

  // Try config files in priority order
  for (const dir of searchDirs) {
    for (const filename of CONFIG_FILENAMES) {
      const configPath = path.join(dir, filename);
      if (fs.existsSync(configPath)) {
        try {
          const raw = fs.readFileSync(configPath, 'utf-8');
          return JSON.parse(raw) as ModelRouterConfig;
        } catch (err) {
          getLogger().warn(`Failed to parse ${configPath}: ${(err as Error).message}. Trying next config file.`);
        }
      }
    }
  }

  // Try the example config as last resort
  for (const dir of searchDirs) {
    const examplePath = path.join(dir, EXAMPLE_FILENAME);
    if (fs.existsSync(examplePath)) {
      try {
        const raw = fs.readFileSync(examplePath, 'utf-8');
        return JSON.parse(raw) as ModelRouterConfig;
      } catch (err) {
        getLogger().warn(`Failed to parse ${examplePath}: ${(err as Error).message}.`);
      }
    }
  }

  return null;
}

/**
 * Discover available models from a running llama.cpp server in Router Mode.
 */
export async function discoverModels(baseURL: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseURL}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];

    const data = (await response.json()) as { data?: { id: string }[] };
    return (data.data || []).map((m) => m.id);
  } catch {
    return [];
  }
}

/**
 * Fallback profile used when no models.config.json is present.
 * In this mode the Pi SDK chooses the active model; the router acts as a no-op.
 */
const PASSTHROUGH_PROFILE: ModelProfile = {
  name: 'Pi Default (passthrough)',
  ggufFilename: '',
  provider: 'local',
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  architecture: 'unknown',
  speed: 'medium',
  modelFamily: 'generic',
  enableThinking: false,
};

export class ModelRouter {
  private config: ModelRouterConfig;
  /** True when operating without a models.config.json — defers model selection to Pi. */
  readonly isPassthrough: boolean;

  constructor(config?: ModelRouterConfig | null) {
    if (config) {
      this.config = config;
      this.isPassthrough = false;
    } else {
      const loaded = loadConfig();
      if (!loaded) {
        getLogger().warn(
          'No models.config.json found — model routing is disabled. ' +
          "Pi's currently active model will be used for all sub-agents. " +
          'Run `npx tsx scripts/setup-wizard.ts` to enable model routing.'
        );
        this.config = { models: {}, routing: {} };
        this.isPassthrough = true;
      } else {
        this.config = loaded;
        this.isPassthrough = false;
      }
    }
  }

  selectModel(taskType: TaskType): ModelProfile {
    // Passthrough mode: no config available, defer to Pi's default model
    if (this.isPassthrough) {
      return PASSTHROUGH_PROFILE;
    }

    const modelKey = this.config.routing[taskType];
    if (!modelKey) {
      // For optional roles (design, design_review), fall back to the plan model
      const fallback = this.config.routing['plan'];
      if (fallback && this.config.models[fallback]) {
        return this.config.models[fallback]!;
      }
      throw new Error(`No routing defined for task type '${taskType}' and no fallback available`);
    }
    const profile = this.config.models[modelKey];
    if (!profile) {
      throw new Error(
        `Model '${modelKey}' (for ${taskType}) not found in config. Available: ${Object.keys(this.config.models).join(', ')}`
      );
    }
    return profile;
  }

  /**
   * Get the effective model identifier for API calls.
   * For local models: ggufFilename. For cloud: modelId.
   */
  getModelIdentifier(profile: ModelProfile): string {
    if (profile.provider !== 'local' && profile.modelId) {
      return profile.modelId;
    }
    return profile.ggufFilename;
  }

  /**
   * Get the API key for a model.
   *
   * Lookup order:
   * 1. The env var named by `apiKeyEnvVar` (throws if set but variable is unset)
   * 2. Well-known provider defaults (OPENROUTER_API_KEY, OPENAI_API_KEY)
   * 3. undefined for local providers
   *
   * Throws for non-local providers that have no key configured at all, so
   * callers get an actionable error instead of a confusing 401.
   */
  getApiKey(profile: ModelProfile): string | undefined {
    if (profile.apiKeyEnvVar) {
      const key = process.env[profile.apiKeyEnvVar];
      if (!key) {
        throw new Error(
          `Environment variable "${profile.apiKeyEnvVar}" is not set (required for ${profile.name}). ` +
          `Set this variable to your API key.`
        );
      }
      return key;
    }
    // Default env vars per provider
    if (profile.provider === 'openrouter') return process.env['OPENROUTER_API_KEY'];
    if (profile.provider === 'openai') return process.env['OPENAI_API_KEY'];
    if (profile.provider === 'local') return undefined;
    throw new Error(
      `No apiKeyEnvVar configured for "${profile.name}" (provider: ${profile.provider}). ` +
      `Add apiKeyEnvVar to this model profile.`
    );
  }

  /**
   * Get the base URL for a model's provider.
   */
  getBaseURL(profile: ModelProfile): string {
    if (profile.baseURL) return profile.baseURL;
    if (profile.provider === 'openrouter') return 'https://openrouter.ai/api/v1';
    if (profile.provider === 'openai') return 'https://api.openai.com/v1';
    return process.env['LLAMA_CPP_URL'] || this.config.llamaCppUrl || 'http://localhost:8080/v1';
  }

  getSamplingParams(taskType: TaskType): SamplingParams {
    const profile = this.selectModel(taskType);
    return profile.samplingParams || {};
  }

  listModels(): ModelProfile[] {
    return Object.values(this.config.models);
  }

  listModelKeys(): string[] {
    return Object.keys(this.config.models);
  }

  getModelByKey(key: string): ModelProfile | undefined {
    return this.config.models[key];
  }

  getConfig(): ModelRouterConfig {
    return this.config;
  }
}

/**
 * Save a model config to disk.
 */
export function saveConfig(config: ModelRouterConfig, targetDir: string): string {
  const configPath = path.join(targetDir, 'models.config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return configPath;
}
