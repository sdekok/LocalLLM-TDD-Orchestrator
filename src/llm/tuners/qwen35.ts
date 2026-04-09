import { ModelProfile, SamplingParams } from '../model-router.js';
import { ModelTuner, TunerResult } from './index.js';

export class Qwen35Tuner implements ModelTuner {
  getDefaultSampling(profile: ModelProfile): Partial<SamplingParams> {
    return {};
  }

  applyTweaks(profile: ModelProfile, systemPrompt: string, currentSampling: SamplingParams): TunerResult {
    const sampling = { ...currentSampling };

    // Vendor recommendation: top_k should be 20 for Qwen 3.5
    if (!sampling.top_k || sampling.top_k > 20) {
      sampling.top_k = 20;
    }

    return {
      systemPrompt,
      sampling,
    };
  }
}
