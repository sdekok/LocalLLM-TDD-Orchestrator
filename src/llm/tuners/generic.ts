import { ModelProfile, SamplingParams } from '../model-router.js';
import { ModelTuner, TunerResult } from './index.js';

export class GenericTuner implements ModelTuner {
  getDefaultSampling(profile: ModelProfile): Partial<SamplingParams> {
    return {};
  }

  applyTweaks(profile: ModelProfile, systemPrompt: string, currentSampling: SamplingParams): TunerResult {
    // Generic tuner makes no mutations
    return {
      systemPrompt,
      sampling: currentSampling,
    };
  }
}
