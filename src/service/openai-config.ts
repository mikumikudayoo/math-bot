/**
 * OpenAI provider configuration. Values come from the same `.env.ai.<mode>` file
 * as every other AI-service setting; only OPENAI_API_KEY may additionally be
 * inherited from the process environment. Diagnostics never include secret values.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Tier = 'light' | 'advanced' | 'max';
export const EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface ModelSpec {
  /** USD per 1M tokens, standard tier. Reasoning tokens are billed as output tokens. */
  input: number; cachedInput: number; output: number;
  efforts: ReasoningEffort[];
}

/**
 * Verified 2026-11-16 against https://developers.openai.com/api/docs/pricing and the
 * model pages /api/docs/models/gpt-6-luna and /api/docs/models/gpt-6.1-sol.
 * Prices change: override with OPENAI_PRICING_JSON rather than editing silently.
 */
export const PRICING_SOURCE = 'developers.openai.com/api/docs/pricing (verified 2026-11-16)';
export const DEFAULT_MODELS: Record<string, ModelSpec> = {
  'gpt-6-luna': {input: 0.10, cachedInput: 0.01, output: 0.50, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max']},
  'gpt-6.1-sol': {input: 2.00, cachedInput: 0.10, output: 10.00, efforts: ['low', 'medium', 'high', 'xhigh', 'max']},
};
/** Above this many input tokens OpenAI bills 2x input/cache and 1.5x output for the whole request. */
export const LONG_CONTEXT_TOKENS = 272_000;

export interface OpenAIConfig {
  apiKey: string;
  lightModel: string; advancedModel: string;
  /** All LLM inference (including Discord lookups) uses the light model; no other provider is ever used. */
  exclusive: boolean;
  efforts: Record<Tier, ReasoningEffort>;
  maxOutputTokens: Record<Tier, number>;
  routing: boolean;
  fallback: 'none' | 'external';
  timeoutMs: number;
  maxRetries: number;
  maxInputChars: number;
  concurrency: number;
  userHourly: number; userAdvancedDaily: number; userMaxDaily: number;
  dailyBudgetUsd: number; totalBudgetUsd: number;
  forceTier?: 'light' | 'advanced';
  forceEffort?: ReasoningEffort;
  models: Record<string, ModelSpec>;
}

export class ConfigError extends Error {}

/** Shape check only; the value itself never appears in an error. */
export function validApiKey(key: string) {
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(key);
}

export function parseOpenAIConfig(env: Record<string, string | undefined>, inherited: Record<string, string | undefined> = {}): OpenAIConfig | undefined {
  const provider = (env.AI_PROVIDER ?? 'legacy').trim();
  if (!['legacy', 'openai'].includes(provider)) throw new ConfigError('AI_PROVIDER must be "legacy" or "openai".');
  if (provider !== 'openai') return undefined;

  const apiKey = (env.OPENAI_API_KEY || inherited.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new ConfigError('AI_PROVIDER=openai requires OPENAI_API_KEY.');
  if (!validApiKey(apiKey)) throw new ConfigError('OPENAI_API_KEY is malformed (expected an sk-... API key).');

  const number = (key: string, fallback: number, min: number, max: number, integer = true) => {
    const raw = env[key];
    const n = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) throw new ConfigError(`Invalid ${key} (expected ${min}..${max}).`);
    return n;
  };
  const bool = (key: string, fallback: boolean) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    if (raw !== 'true' && raw !== 'false') throw new ConfigError(`Invalid ${key} (expected true or false).`);
    return raw === 'true';
  };

  const models: Record<string, ModelSpec> = {...DEFAULT_MODELS};
  if (env.OPENAI_PRICING_JSON) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.OPENAI_PRICING_JSON); } catch { throw new ConfigError('OPENAI_PRICING_JSON is not valid JSON.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError('OPENAI_PRICING_JSON must be an object keyed by model id.');
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as Partial<ModelSpec>;
      const price = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 10_000;
      if (!v || !price(v.input) || !price(v.cachedInput) || !price(v.output)) throw new ConfigError(`OPENAI_PRICING_JSON entry ${id} needs numeric input, cachedInput and output.`);
      const efforts = v.efforts ?? models[id]?.efforts;
      if (!Array.isArray(efforts) || !efforts.length || efforts.some(e => !EFFORTS.includes(e))) throw new ConfigError(`OPENAI_PRICING_JSON entry ${id} needs a valid efforts list.`);
      models[id] = {input: v.input!, cachedInput: v.cachedInput!, output: v.output!, efforts};
    }
  }

  const modelId = (key: string, fallback: string) => {
    const id = (env[key] ?? fallback).trim();
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(id)) throw new ConfigError(`Invalid ${key}.`);
    // Fail closed: never run a model whose cost cannot be estimated.
    // The value is not echoed, in case a secret was pasted into the wrong variable.
    if (!models[id]) throw new ConfigError(`${key} names a model with no pricing entry; add it to OPENAI_PRICING_JSON.`);
    return id;
  };
  const exclusive = bool('OPENAI_EXCLUSIVE', false);
  const lightModel = modelId('OPENAI_LIGHT_MODEL', 'gpt-6-luna');
  // Exclusive mode: every tier uses the light model. A conflicting explicit setting is a
  // startup error rather than something silently overridden.
  if (exclusive && env.OPENAI_ADVANCED_MODEL?.trim() && env.OPENAI_ADVANCED_MODEL.trim() !== lightModel)
    throw new ConfigError('OPENAI_EXCLUSIVE=true requires OPENAI_ADVANCED_MODEL to be empty or equal to OPENAI_LIGHT_MODEL.');
  const advancedModel = exclusive ? lightModel : modelId('OPENAI_ADVANCED_MODEL', 'gpt-6.1-sol');

  const effort = (key: string, fallback: ReasoningEffort, model: string) => {
    const value = (env[key] ?? fallback).trim() as ReasoningEffort;
    if (!EFFORTS.includes(value)) throw new ConfigError(`Invalid ${key}.`);
    if (!models[model]!.efforts.includes(value)) throw new ConfigError(`${key}=${value} is not supported by ${model} (supported: ${models[model]!.efforts.join(', ')}).`);
    return value;
  };

  const fallback = (env.OPENAI_FALLBACK ?? 'none').trim();
  if (fallback !== 'none' && fallback !== 'external') throw new ConfigError('OPENAI_FALLBACK must be "none" or "external".');
  if (exclusive && fallback !== 'none') throw new ConfigError('OPENAI_EXCLUSIVE=true requires OPENAI_FALLBACK=none.');

  const forceTier = (env.OPENAI_FORCE_TIER ?? '').trim();
  if (forceTier && forceTier !== 'light' && forceTier !== 'advanced') throw new ConfigError('OPENAI_FORCE_TIER must be empty, "light" or "advanced".');
  const forceEffort = (env.OPENAI_FORCE_EFFORT ?? '').trim() as ReasoningEffort | '';
  if (forceEffort && !EFFORTS.includes(forceEffort)) throw new ConfigError('Invalid OPENAI_FORCE_EFFORT.');
  if (forceEffort) {
    const forced = forceTier === 'light' ? [lightModel] : forceTier === 'advanced' ? [advancedModel] : [lightModel, advancedModel];
    for (const model of forced) if (!models[model]!.efforts.includes(forceEffort)) throw new ConfigError(`OPENAI_FORCE_EFFORT=${forceEffort} is not supported by ${model}.`);
  }

  const dailyBudgetUsd = number('OPENAI_DAILY_BUDGET_USD', 1, 0, 1000, false);
  const totalBudgetUsd = number('OPENAI_TOTAL_BUDGET_USD', 40, 0, 100_000, false);

  return {
    apiKey, lightModel, advancedModel, exclusive,
    efforts: {
      light: effort('OPENAI_LIGHT_EFFORT', 'medium', lightModel),
      advanced: effort('OPENAI_ADVANCED_EFFORT', 'high', advancedModel),
      max: effort('OPENAI_MAX_EFFORT', exclusive ? 'max' : 'xhigh', advancedModel),
    },
    maxOutputTokens: {
      light: number('OPENAI_MAX_OUTPUT_TOKENS', 4000, 256, 128_000),
      advanced: number('OPENAI_ADVANCED_MAX_OUTPUT_TOKENS', 16_000, 256, 128_000),
      max: number('OPENAI_MAX_TIER_MAX_OUTPUT_TOKENS', 32_000, 256, 128_000),
    },
    routing: bool('OPENAI_ROUTING', true),
    fallback,
    timeoutMs: number('OPENAI_TIMEOUT_SECONDS', 180, 5, 3600) * 1000,
    maxRetries: number('OPENAI_MAX_RETRIES', 2, 0, 5),
    maxInputChars: number('OPENAI_MAX_INPUT_CHARS', 120_000, 1000, 2_000_000),
    concurrency: number('OPENAI_CONCURRENCY', 2, 1, 32),
    userHourly: number('OPENAI_USER_REQUESTS_PER_HOUR', 20, 0, 10_000),
    userAdvancedDaily: number('OPENAI_USER_ADVANCED_PER_DAY', 5, 0, 10_000),
    userMaxDaily: number('OPENAI_USER_MAX_PER_DAY', 1, 0, 10_000),
    dailyBudgetUsd, totalBudgetUsd,
    ...(forceTier ? {forceTier: forceTier as 'light' | 'advanced'} : {}),
    ...(forceEffort ? {forceEffort} : {}),
    models,
  };
}

/** Safe-to-log summary (no key). */
export function describeOpenAIConfig(c: OpenAIConfig) {
  return {exclusive: c.exclusive, light: `${c.lightModel}/${c.efforts.light}`, advanced: `${c.advancedModel}/${c.efforts.advanced}`, max: `${c.advancedModel}/${c.efforts.max}`,
    routing: c.routing, fallback: c.fallback, dailyBudgetUsd: c.dailyBudgetUsd, totalBudgetUsd: c.totalBudgetUsd, concurrency: c.concurrency};
}
