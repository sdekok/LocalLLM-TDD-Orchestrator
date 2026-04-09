#!/usr/bin/env node
/**
 * TDD Workflow — Model Setup Wizard
 *
 * Discovers available models from llama.cpp and walks you through
 * configuring them for each agent role (planner, implementer, reviewer, researcher).
 *
 * Usage:
 *   npx tsx scripts/setup-wizard.ts
 *   npx tsx scripts/setup-wizard.ts --url http://localhost:8080/v1
 *   npx tsx scripts/setup-wizard.ts --output ./models.config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

interface ModelInfo {
  id: string;
  // llama.cpp may include more fields depending on version
  object?: string;
  owned_by?: string;
}

interface SamplingParams {
  temperature?: number;
  top_k?: number;
  top_p?: number;
  min_p?: number;
  repeat_penalty?: number;
}

interface ModelProfile {
  name: string;
  ggufFilename: string;
  contextWindow: number;
  maxOutputTokens: number;
  architecture: 'dense' | 'moe' | 'unknown';
  parameterCount?: string;
  speed: 'fast' | 'medium' | 'slow';
  samplingParams: SamplingParams;
}

interface ModelConfig {
  models: Record<string, ModelProfile>;
  routing: Record<string, string>;
}

const TASK_TYPES = ['plan', 'implement', 'review', 'research'] as const;
const TASK_DESCRIPTIONS: Record<string, string> = {
  plan: 'Planning & task breakdown (benefits from strong reasoning)',
  implement: 'Code implementation (high volume, benefits from speed)',
  review: 'Code review (benefits from careful analysis)',
  research: 'Research & documentation lookups (benefits from broad knowledge)',
};

// ─── Readline helpers ──────────────────────────────────────────────

function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function askWithDefault(rl: readline.Interface, question: string, defaultVal: string): Promise<string> {
  return ask(rl, `${question} [${defaultVal}]: `).then((a) => a || defaultVal);
}

function askNumber(rl: readline.Interface, question: string, defaultVal: number): Promise<number> {
  return askWithDefault(rl, question, String(defaultVal)).then((a) => {
    const n = parseFloat(a);
    return isNaN(n) ? defaultVal : n;
  });
}

// ─── Model Discovery ───────────────────────────────────────────────

async function discoverModels(baseURL: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseURL}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      console.error(`Failed to reach llama.cpp at ${baseURL}: ${response.status}`);
      return [];
    }
    const data = (await response.json()) as { data?: ModelInfo[] };
    return (data.data || []).map((m) => m.id);
  } catch (err) {
    console.error(`Could not connect to llama.cpp at ${baseURL}: ${err}`);
    return [];
  }
}

// ─── Heuristic model name analysis ─────────────────────────────────

function guessArchitecture(name: string): 'moe' | 'dense' | 'unknown' {
  const lower = name.toLowerCase();
  // MoE indicators: explicit "moe", active param markers like "a4b", "a3b", etc.
  if (lower.match(/\bmoe\b/) || lower.match(/a\d+b/)) return 'moe';
  // Dense indicators: no active param marker
  return 'dense';
}

function guessSpeed(architecture: string): 'fast' | 'medium' | 'slow' {
  return architecture === 'moe' ? 'fast' : 'slow';
}

function guessParamCount(name: string): string {
  const match = name.match(/(\d+\.?\d*)[bB]/);
  return match ? `${match[1]}b` : 'unknown';
}

function makeModelKey(name: string): string {
  return name
    .replace(/\.gguf$/i, '')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .substring(0, 30);
}

// ─── Main Wizard ───────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let baseURL = 'http://localhost:8080/v1';
  let outputPath = path.join(process.cwd(), 'models.config.json');

  // Parse CLI args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) baseURL = args[++i]!;
    if (args[i] === '--output' && args[i + 1]) outputPath = args[++i]!;
  }

  const rl = createInterface();

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║    TDD Agentic Workflow — Model Setup Wizard         ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Step 1: Discover models
  baseURL = await askWithDefault(rl, 'llama.cpp API URL', baseURL);

  console.log(`\nConnecting to ${baseURL}...`);
  const discovered = await discoverModels(baseURL);

  let availableModels: string[] = [];
  if (discovered.length > 0) {
    console.log(`\n✅ Found ${discovered.length} model(s):\n`);
    discovered.forEach((m, i) => {
      const arch = guessArchitecture(m);
      const params = guessParamCount(m);
      console.log(`  ${i + 1}. ${m}  (${arch}, ~${params})`);
    });
    availableModels = discovered;
  } else {
    console.log('\n⚠️  No models discovered. You can enter GGUF filenames manually.');
  }

  // Step 2: Configure each model
  console.log('\n─── Model Configuration ───────────────────────────────\n');

  const numModels = await askNumber(rl, 'How many models do you want to configure?', availableModels.length || 2);
  const config: ModelConfig = { models: {}, routing: {} };

  for (let i = 0; i < numModels; i++) {
    console.log(`\n── Model ${i + 1} of ${numModels} ──`);

    let ggufFilename: string;
    if (availableModels[i]) {
      ggufFilename = await askWithDefault(rl, 'GGUF filename', availableModels[i]!);
    } else {
      ggufFilename = await ask(rl, 'GGUF filename: ');
    }

    const defaultArch = guessArchitecture(ggufFilename);
    const defaultKey = makeModelKey(ggufFilename);
    const defaultName = ggufFilename.replace(/\.gguf$/i, '').replace(/[-_]/g, ' ');
    const defaultParams = guessParamCount(ggufFilename);
    const defaultSpeed = guessSpeed(defaultArch);

    const key = await askWithDefault(rl, 'Config key', defaultKey);
    const name = await askWithDefault(rl, 'Display name', defaultName);
    const architecture = await askWithDefault(rl, 'Architecture (dense/moe)', defaultArch);
    const parameterCount = await askWithDefault(rl, 'Parameter count', defaultParams);
    const speed = await askWithDefault(rl, 'Speed (fast/medium/slow)', defaultSpeed);
    const contextWindow = await askNumber(rl, 'Context window (tokens)', 200000);
    const maxOutputTokens = await askNumber(rl, 'Max output tokens', 16384);

    console.log('\n  Sampling parameters:');
    const temperature = await askNumber(rl, '  Temperature', architecture === 'dense' ? 0.1 : 0.2);
    const top_k = await askNumber(rl, '  Top K', 40);
    const top_p = await askNumber(rl, '  Top P', 0.95);
    const min_p = await askNumber(rl, '  Min P', 0.05);
    const repeat_penalty = await askNumber(rl, '  Repeat penalty', 1.1);

    config.models[key] = {
      name,
      ggufFilename,
      contextWindow,
      maxOutputTokens,
      architecture: architecture as 'dense' | 'moe' | 'unknown',
      parameterCount,
      speed: speed as 'fast' | 'medium' | 'slow',
      samplingParams: { temperature, top_k, top_p, min_p, repeat_penalty },
    };
  }

  // Step 3: Route models to tasks
  console.log('\n─── Agent Role Mapping ────────────────────────────────\n');
  const modelKeys = Object.keys(config.models);
  console.log('Available models:', modelKeys.join(', '));

  for (const taskType of TASK_TYPES) {
    console.log(`\n${TASK_DESCRIPTIONS[taskType]}`);

    // Suggest a default based on architecture
    let suggestedDefault = modelKeys[0]!;
    if (taskType === 'implement') {
      // Prefer fast/MoE models for implementation
      suggestedDefault = modelKeys.find((k) => config.models[k]?.speed === 'fast') || suggestedDefault;
    } else {
      // Prefer slow/dense models for planning, review, research
      suggestedDefault = modelKeys.find((k) => config.models[k]?.speed === 'slow') || suggestedDefault;
    }

    const choice = await askWithDefault(rl, `  Model for '${taskType}'`, suggestedDefault);
    if (!modelKeys.includes(choice)) {
      console.log(`  ⚠️  '${choice}' not in configured models. Using anyway.`);
    }
    config.routing[taskType] = choice;
  }

  // Step 4: Write config
  console.log('\n─── Saving Configuration ─────────────────────────────\n');
  outputPath = await askWithDefault(rl, 'Output path', outputPath);

  const resolvedOutput = path.resolve(outputPath);
  const cwd = process.cwd();
  const isOutsideCwd =
    resolvedOutput !== cwd &&
    !resolvedOutput.startsWith(cwd + path.sep);

  if (isOutsideCwd) {
    const confirm = await ask(
      rl,
      `\n⚠️  Output path is outside the current directory:\n   ${resolvedOutput}\nWrite here? (y/N): `
    );
    if (confirm.toLowerCase() !== 'y') {
      console.log('\nAborted. No file written.');
      rl.close();
      return;
    }
  }

  fs.writeFileSync(resolvedOutput, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`\n✅ Configuration written to: ${resolvedOutput}`);
  console.log(`\nYou can edit this file manually at any time. To re-run this wizard:`);
  console.log(`  npx tsx scripts/setup-wizard.ts\n`);

  // Step 5: Show summary
  console.log('─── Summary ──────────────────────────────────────────\n');
  for (const [taskType, modelKey] of Object.entries(config.routing)) {
    const model = config.models[modelKey];
    console.log(`  ${taskType.padEnd(12)} → ${model?.name || modelKey} (${model?.architecture || '?'}, ${model?.speed || '?'})`);
  }
  console.log('');

  rl.close();
}

main().catch((err) => {
  console.error('Wizard failed:', err);
  process.exit(1);
});
