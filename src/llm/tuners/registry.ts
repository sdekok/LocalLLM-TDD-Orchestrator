import { ModelTuner } from './index.js';
import { GenericTuner } from './generic.js';
import { Gemma4Tuner } from './gemma4.js';
import { Qwen35Tuner } from './qwen35.js';

const genericTuner = new GenericTuner();

export const tuners: Record<string, ModelTuner> = {
  'generic': genericTuner,
  'llama': genericTuner,
  'deepseek': genericTuner,
  'claude': genericTuner,
  'gemma4': new Gemma4Tuner(),
  'qwen35': new Qwen35Tuner(),
};

/** Get the tuner for a family, or the generic fallback. */
export function getTuner(modelFamily?: string): ModelTuner {
  if (!modelFamily) return genericTuner;
  return tuners[modelFamily] || genericTuner;
}
