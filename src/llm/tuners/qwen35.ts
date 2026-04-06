import { ModelProfile, SamplingParams } from '../model-router.js';
import { ModelTuner, TunerResult } from './index.js';

export class Qwen35Tuner implements ModelTuner {
  getDefaultSampling(profile: ModelProfile): Partial<SamplingParams> {
    return {};
  }

  applyTweaks(profile: ModelProfile, systemPrompt: string, currentSampling: SamplingParams): TunerResult {
    // Qwen reasoning heavily degrades with greedy decoding, 
    // but the user wants to handle this server-side now.
    
    return {
      systemPrompt,
      sampling: currentSampling,
    };
  }
}
