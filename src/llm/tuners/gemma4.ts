import { ModelProfile, SamplingParams } from '../model-router.js';
import { ModelTuner, TunerResult } from './index.js';

/**
 * Gemma 4 model tuner.
 *
 * NOTE: Google recommends stripping thought channel blocks from multi-turn
 * chat history ("only keep the final visible answer"). This cannot be enforced
 * at the tuner level — it requires session-level message filtering in the Pi SDK.
 * If thinking quality degrades in long sessions, implement message history
 * filtering in createSubAgentSession before passing to the SDK.
 */
export class Gemma4Tuner implements ModelTuner {
  getDefaultSampling(profile: ModelProfile): Partial<SamplingParams> {
    return {};
  }

  applyTweaks(profile: ModelProfile, systemPrompt: string, currentSampling: SamplingParams): TunerResult {
    let finalSystemPrompt = systemPrompt;
    const sampling = { ...currentSampling };

    if (profile.enableThinking) {
      if (!finalSystemPrompt.startsWith('<|think|>')) {
        finalSystemPrompt = `<|think|>\n${finalSystemPrompt}`;
      }
    }

    // Vendor recommendation: top_k should be 64 for Gemma 4
    if (!sampling.top_k || sampling.top_k < 64) {
      sampling.top_k = 64;
    }

    return {
      systemPrompt: finalSystemPrompt,
      sampling,
    };
  }
}
