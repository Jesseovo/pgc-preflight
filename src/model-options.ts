export type ThinkingEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface InferenceOptions { effort?: ThinkingEffort; maxOutputTokens?: number }

// Capabilities advertised by the configured providers' /models and docs.
// Unknown compatible APIs keep their defaults, without guessed controls.
export function modelCapabilities(p: { baseUrl: string; model: string; protocol?: string }) {
  let host = ''; try { host = new URL(p.baseUrl).hostname.toLowerCase(); } catch {}
  const model = String(p.model || '').trim().toLowerCase();
  const protocol = String(p.protocol || '').trim().toLowerCase();
  if (protocol === 'anthropic' && model === 'claude-opus-5-5') return { kind: 'adaptive', efforts: ['low','medium','high','xhigh','max'], maxOutput: 64000 } as const;
  if (host === 'api.deepseek.com' && /^deepseek-(flash|v4-flash(?:-vision-exp)?)$/.test(model)) return { kind: 'deepseek', efforts: ['low','high','max'], maxOutput: 393216 } as const;
  return { kind: 'default', efforts: [], maxOutput: 24000 } as const;
}

export function inferenceOptions(p: InferenceOptions & { baseUrl: string; model: string; protocol?: string }, purpose = 'create', requested?: number) {
  const capability = modelCapabilities(p);
  const budgets: Record<string, number> = { review: 24000, review_verify: 24000, expand: 16000, brief: 24000, preview: 16000, assets: 64000, game: 32768, tags: 8000, vocab: 12000, test: 4096 };
  const automatic = purpose === 'game' && capability.kind === 'deepseek' ? 'high' : 'low';
  const effort = p.effort && p.effort !== 'auto' ? p.effort : automatic;
  // An explicit stage budget is authoritative. When a caller omits it, use
  // the purpose default so each workflow still gets a safe, known ceiling.
  const budget = requested ?? budgets[purpose] ?? 2200;
  return { effort, maxTokens: Math.min(budget, p.maxOutputTokens || capability.maxOutput, capability.maxOutput), capability };
}
