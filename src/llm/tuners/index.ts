import { ModelProfile, SamplingParams } from '../model-router.js';

export interface TunerResult {
  systemPrompt: string;
  sampling?: SamplingParams;
}

export interface ModelTuner {
  /** Provide tuning defaults optionally merged over user provided params */
  getDefaultSampling(profile: ModelProfile): Partial<SamplingParams>;
  
  /** Apply specific mutations string-level (like injecting <|think|>) and enforce required sampling floors */
  applyTweaks(profile: ModelProfile, systemPrompt: string, currentSampling: SamplingParams): TunerResult;
}

// Registry will be populated in tuners/registry.ts to avoid circular deps,
// or we can just import them here. Let's export a generic registry map here.
