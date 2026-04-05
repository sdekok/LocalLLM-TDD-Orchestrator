import { ModelProfile, SamplingParams } from '../model-router.js';
import { ModelTuner, TunerResult } from './index.js';

export class Qwen35Tuner implements ModelTuner {
  getDefaultSampling(profile: ModelProfile): Partial<SamplingParams> {
    if (profile.enableThinking) {
      return {
        temperature: 0.6,
        top_p: 0.95,
        top_k: 20,
      };
    } else {
      return {
        temperature: 0.7,
        top_p: 0.8,
      };
    }
  }

  applyTweaks(profile: ModelProfile, systemPrompt: string, currentSampling: SamplingParams): TunerResult {
    const samplingParams = { ...currentSampling };

    // Qwen reasoning heavily degrades with greedy decoding
    if (profile.enableThinking) {
      if (samplingParams.temperature !== undefined && samplingParams.temperature < 0.6) {
        samplingParams.temperature = 0.6;
      }
    }

    return {
      systemPrompt,
      sampling: samplingParams,
    };
  }
}
