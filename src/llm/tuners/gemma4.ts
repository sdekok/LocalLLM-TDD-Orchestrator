import { ModelProfile, SamplingParams } from '../model-router.js';
import { ModelTuner, TunerResult } from './index.js';

export class Gemma4Tuner implements ModelTuner {
  getDefaultSampling(profile: ModelProfile): Partial<SamplingParams> {
    return {
      temperature: 1.0,
      top_p: 0.95,
      top_k: 64,
    };
  }

  applyTweaks(profile: ModelProfile, systemPrompt: string, currentSampling: SamplingParams): TunerResult {
    let finalSystemPrompt = systemPrompt;
    
    if (profile.enableThinking) {
      if (!finalSystemPrompt.startsWith('<|think|>')) {
        finalSystemPrompt = `<|think|>\n${finalSystemPrompt}`;
      }
    }

    return {
      systemPrompt: finalSystemPrompt,
      sampling: currentSampling,
    };
  }
}
