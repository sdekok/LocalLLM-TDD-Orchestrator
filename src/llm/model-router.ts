import * as fs from 'fs';
import * as path from 'path';

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

export interface ModelProfile {
  name: string;
  ggufFilename: string;         // For local llama.cpp models
  modelId?: string;              // For cloud providers (e.g., 'google/gemma-3-27b-it')
  provider: ModelProvider;       // 'local' for llama.cpp, 'openrouter' for cloud
  baseURL?: string;              // Override per-model (e.g., 'https://openrouter.ai/api/v1')
  apiKey?: string;               // API key for cloud providers (or use env var)
  apiKeyEnvVar?: string;         // Environment variable name for API key
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
export type TaskType = 'plan' | 'implement' | 'review' | 'research' | 'design' | 'design_review' | 'analyze' | 'document';

export interface ModelRouterConfig {
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
        } catch {
          // Malformed — try next
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
      } catch {
        // Malformed
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

export class ModelRouter {
  private config: ModelRouterConfig;

  constructor(config?: ModelRouterConfig | null) {
    if (config) {
      this.config = config;
    } else {
      const loaded = loadConfig();
      if (!loaded) {
        throw new Error(
          'No model configuration found. Run `npx tsx scripts/setup-wizard.ts` to create one, ' +
          'or copy models.config.example.json to models.config.json and edit it.'
        );
      }
      this.config = loaded;
    }
  }

  selectModel(taskType: TaskType): ModelProfile {
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
   * Get the API key for a cloud model, checking the profile and env vars.
   */
  getApiKey(profile: ModelProfile): string | undefined {
    if (profile.apiKey) return profile.apiKey;
    if (profile.apiKeyEnvVar) return process.env[profile.apiKeyEnvVar];
    // Default env vars per provider
    if (profile.provider === 'openrouter') return process.env['OPENROUTER_API_KEY'];
    if (profile.provider === 'openai') return process.env['OPENAI_API_KEY'];
    return undefined;
  }

  /**
   * Get the base URL for a model's provider.
   */
  getBaseURL(profile: ModelProfile): string {
    if (profile.baseURL) return profile.baseURL;
    if (profile.provider === 'openrouter') return 'https://openrouter.ai/api/v1';
    if (profile.provider === 'openai') return 'https://api.openai.com/v1';
    return process.env['LLAMA_CPP_URL'] || 'http://localhost:8080/v1';
  }

  getSamplingParams(taskType: TaskType): SamplingParams {
    const profile = this.selectModel(taskType);
    return profile.samplingParams || { temperature: 0.2 };
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
