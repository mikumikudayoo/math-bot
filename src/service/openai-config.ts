/**
 * OpenAI configuration for Aleph-Zero v2. Values come from `.env.ai.<mode>`; only
 * OPENAI_API_KEY may additionally be inherited from the process environment.
 * Two independent restrictions:
 *   1. provider: AI_PROVIDER=openai means OpenAI is the ONLY inference provider.
 *   2. models:   OPENAI_ALLOWED_MODELS decides which OpenAI models may be called.
 * Diagnostics never include secret values.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelRole = 'luna' | 'terra' | 'sol';
/** Budget class of a request; decides its spending ceiling. */
export type RequestClass = 'ordinary' | 'terra' | 'sol' | 'both' | 'seven' | 'system';
export const EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const rank = (effort: ReasoningEffort) => EFFORTS.indexOf(effort);

export interface ModelSpec {
  /** USD per 1M tokens, standard tier. Reasoning tokens are billed as output tokens. */
  input: number; cachedInput: number; output: number;
  efforts: ReasoningEffort[];
}

/**
 * Luna and Terra verified 2026-11-16; gpt-6.2-sol verified 2026-11-18 against
 * https://developers.openai.com/api/docs/models/gpt-6.2-sol (introduced 2026-11-17) and a
 * bounded live check on the configured organization: low|medium|high|xhigh|max accepted,
 * none rejected with HTTP 400 unsupported_value. Prices change: override with
 * OPENAI_PRICING_JSON rather than editing silently.
 */
export const PRICING_SOURCE = 'developers.openai.com/api/docs/pricing (luna/terra 2026-11-16, gpt-6.2-sol 2026-11-18)';
/** The active Sol specialist. gpt-6.1-sol stays priced only for an explicit, documented rollback. */
export const DEFAULT_SOL_MODEL = 'gpt-6.2-sol';
export const DEFAULT_MODELS: Record<string, ModelSpec> = {
  'gpt-6-luna': {input: 0.10, cachedInput: 0.01, output: 0.50, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max']},
  'gpt-6.1-terra': {input: 1.00, cachedInput: 0.05, output: 5.00, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max']},
  'gpt-6.2-sol': {input: 2.00, cachedInput: 0.10, output: 10.00, efforts: ['low', 'medium', 'high', 'xhigh', 'max']},
  // Rollback only: selected solely by an explicit OPENAI_SOL_MODEL=gpt-6.1-sol (see docs/openai.md).
  'gpt-6.1-sol': {input: 2.00, cachedInput: 0.10, output: 10.00, efforts: ['low', 'medium', 'high', 'xhigh', 'max']},
};
/** Above this many input tokens OpenAI bills 2x input/cache and 1.5x output for the whole request. */
export const LONG_CONTEXT_TOKENS = 272_000;

export interface OpenAIConfig {
  apiKey: string;
  models: Record<ModelRole, string>;
  /** Roles whose model may be called. Luna is always allowed. */
  allowed: Record<ModelRole, boolean>;
  /** Luna: default effort and the ceiling she may raise herself to mid-request. */
  lunaEffort: ReasoningEffort; lunaMaxEffort: ReasoningEffort;
  /** Specialists: default effort, and the highest effort the server authorizes. */
  consultEffort: Record<'terra' | 'sol', ReasoningEffort>; consultMaxEffort: Record<'terra' | 'sol', ReasoningEffort>;
  maxOutputTokens: Record<ModelRole, number>;
  /** USD ceilings per request class (estimated spend incl. reservations). */
  requestBudgetUsd: Record<RequestClass, number>;
  dailyBudgetUsd: number; totalBudgetUsd: number;
  timeoutMs: number; maxRetries: number; maxInputChars: number; concurrency: number;
  userHourly: number; userSolDaily: number; userTerraDaily: number; sevenDaily: number; userSevenDaily: number;
  /** Probability of spontaneous seven-agent mode per eligible request. */
  sevenAgentChance: number;
  softRounds: number; hardRounds: number; toolConcurrency: number; imageCorrections: number;
  streaming: boolean;
  pricing: Record<string, ModelSpec>;
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
  // Settings from the retired user-facing routing must not silently keep doing something else.
  for (const retired of ['OPENAI_FALLBACK', 'OPENAI_FORCE_TIER', 'OPENAI_FORCE_EFFORT', 'OPENAI_ADVANCED_MODEL', 'OPENAI_LIGHT_MODEL', 'OPENAI_ROUTING']) {
    const value = env[retired]?.trim();
    if (value && !(retired === 'OPENAI_FALLBACK' && value === 'none')) throw new ConfigError(`${retired} is no longer supported; remove it (see docs/openai.md).`);
  }

  const pricing: Record<string, ModelSpec> = {...DEFAULT_MODELS};
  if (env.OPENAI_PRICING_JSON) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.OPENAI_PRICING_JSON); } catch { throw new ConfigError('OPENAI_PRICING_JSON is not valid JSON.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError('OPENAI_PRICING_JSON must be an object keyed by model id.');
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as Partial<ModelSpec>;
      const price = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 10_000;
      if (!v || !price(v.input) || !price(v.cachedInput) || !price(v.output)) throw new ConfigError(`OPENAI_PRICING_JSON entry ${id} needs numeric input, cachedInput and output.`);
      const efforts = v.efforts ?? pricing[id]?.efforts;
      if (!Array.isArray(efforts) || !efforts.length || efforts.some(e => !EFFORTS.includes(e))) throw new ConfigError(`OPENAI_PRICING_JSON entry ${id} needs a valid efforts list.`);
      pricing[id] = {input: v.input!, cachedInput: v.cachedInput!, output: v.output!, efforts};
    }
  }

  const modelId = (key: string, fallback: string) => {
    const id = (env[key] ?? '').trim() || fallback;
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(id)) throw new ConfigError(`Invalid ${key}.`);
    // Fail closed: never run a model whose cost cannot be estimated. The value is not echoed.
    if (!pricing[id]) throw new ConfigError(`${key} names a model with no pricing entry; add it to OPENAI_PRICING_JSON.`);
    return id;
  };
  const models: Record<ModelRole, string> = {
    luna: modelId('OPENAI_LUNA_MODEL', 'gpt-6-luna'),
    terra: modelId('OPENAI_TERRA_MODEL', 'gpt-6.1-terra'),
    sol: modelId('OPENAI_SOL_MODEL', DEFAULT_SOL_MODEL),
  };
  const allowedList = (env.OPENAI_ALLOWED_MODELS ?? 'luna,terra,sol').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowedList.some(name => !['luna', 'terra', 'sol'].includes(name))) throw new ConfigError('OPENAI_ALLOWED_MODELS may only list luna, terra and sol.');
  if (!allowedList.includes('luna')) throw new ConfigError('OPENAI_ALLOWED_MODELS must include luna (the permanent orchestrator).');
  const allowed = {luna: true, terra: allowedList.includes('terra'), sol: allowedList.includes('sol')};

  const effort = (key: string, fallback: ReasoningEffort, role: ModelRole, floor?: ReasoningEffort) => {
    const value = ((env[key] ?? '').trim() || fallback) as ReasoningEffort;
    if (!EFFORTS.includes(value)) throw new ConfigError(`Invalid ${key}.`);
    if (!pricing[models[role]]!.efforts.includes(value)) throw new ConfigError(`${key}=${value} is not supported by the ${role} model (supported: ${pricing[models[role]]!.efforts.join(', ')}).`);
    if (floor && rank(value) < rank(floor)) throw new ConfigError(`${key} must be at least ${floor}.`);
    return value;
  };
  // The orchestrator never deliberately runs without reasoning.
  const lunaEffort = effort('OPENAI_LUNA_EFFORT', 'low', 'luna', 'low');
  const lunaMaxEffort = effort('OPENAI_LUNA_MAX_EFFORT', 'high', 'luna', lunaEffort);
  const consultEffort = {terra: effort('OPENAI_TERRA_EFFORT', 'medium', 'terra', 'low'), sol: effort('OPENAI_SOL_EFFORT', 'medium', 'sol', 'low')};
  // `max` stays unavailable unless the server explicitly authorizes it here.
  const consultMaxEffort = {terra: effort('OPENAI_TERRA_MAX_EFFORT', 'xhigh', 'terra', consultEffort.terra), sol: effort('OPENAI_SOL_MAX_EFFORT', 'xhigh', 'sol', consultEffort.sol)};

  const softRounds = number('AI_SOFT_ROUNDS', 32, 2, 256);
  const hardRounds = number('AI_HARD_ROUNDS', 64, softRounds, 512);

  return {
    apiKey, models, allowed, lunaEffort, lunaMaxEffort, consultEffort, consultMaxEffort,
    maxOutputTokens: {
      luna: number('OPENAI_LUNA_MAX_OUTPUT_TOKENS', 4000, 256, 128_000),
      terra: number('OPENAI_TERRA_MAX_OUTPUT_TOKENS', 6000, 256, 128_000),
      sol: number('OPENAI_SOL_MAX_OUTPUT_TOKENS', 8000, 256, 128_000),
    },
    requestBudgetUsd: {
      ordinary: number('OPENAI_REQUEST_BUDGET_USD', 0.02, 0, 100, false),
      terra: number('OPENAI_TERRA_REQUEST_BUDGET_USD', 0.08, 0, 100, false),
      sol: number('OPENAI_SOL_REQUEST_BUDGET_USD', 0.10, 0, 100, false),
      both: number('OPENAI_BOTH_REQUEST_BUDGET_USD', 0.15, 0, 100, false),
      seven: number('OPENAI_SEVEN_REQUEST_BUDGET_USD', 0.15, 0, 100, false),
      system: number('OPENAI_SYSTEM_REQUEST_BUDGET_USD', 0.05, 0, 100, false),
    },
    dailyBudgetUsd: number('OPENAI_DAILY_BUDGET_USD', 1, 0, 1000, false),
    totalBudgetUsd: number('OPENAI_TOTAL_BUDGET_USD', 40, 0, 100_000, false),
    timeoutMs: number('OPENAI_TIMEOUT_SECONDS', 180, 5, 3600) * 1000,
    maxRetries: number('OPENAI_MAX_RETRIES', 2, 0, 5),
    maxInputChars: number('OPENAI_MAX_INPUT_CHARS', 160_000, 1000, 2_000_000),
    concurrency: number('OPENAI_CONCURRENCY', 6, 1, 32),
    userHourly: number('OPENAI_USER_REQUESTS_PER_HOUR', 30, 0, 10_000),
    userSolDaily: number('OPENAI_USER_SOL_PER_DAY', 4, 0, 10_000),
    userTerraDaily: number('OPENAI_USER_TERRA_PER_DAY', 4, 0, 10_000),
    sevenDaily: number('OPENAI_SEVEN_PER_DAY', 3, 0, 10_000),
    userSevenDaily: number('OPENAI_USER_SEVEN_PER_DAY', 1, 0, 10_000),
    sevenAgentChance: number('AI_SEVEN_AGENT_CHANCE', 1 / 10_000, 0, 1, false),
    softRounds, hardRounds,
    toolConcurrency: number('AI_TOOL_CONCURRENCY', 4, 1, 16),
    imageCorrections: number('AI_IMAGE_CORRECTIONS', 5, 0, 20),
    streaming: bool('AI_STREAMING', true),
    pricing,
  };
}

/** Highest effort ≤ `ceiling` that the model supports and that is ≥ low; falls back to the model default. */
export function clampEffort(config: OpenAIConfig, role: ModelRole, requested: unknown, ceiling: ReasoningEffort, fallback: ReasoningEffort): ReasoningEffort {
  const supported = config.pricing[config.models[role]]!.efforts;
  const wanted = typeof requested === 'string' && EFFORTS.includes(requested as ReasoningEffort) ? requested as ReasoningEffort : fallback;
  const capped = rank(wanted) > rank(ceiling) ? ceiling : wanted;
  if (rank(capped) >= rank('low') && supported.includes(capped)) return capped;
  return fallback;
}

/** Safe-to-log summary (no key). */
export function describeOpenAIConfig(c: OpenAIConfig) {
  return {luna: `${c.models.luna}/${c.lunaEffort}..${c.lunaMaxEffort}`,
    terra: c.allowed.terra ? `${c.models.terra}/${c.consultEffort.terra}..${c.consultMaxEffort.terra}` : 'disabled',
    sol: c.allowed.sol ? `${c.models.sol}/${c.consultEffort.sol}..${c.consultMaxEffort.sol}` : 'disabled',
    dailyBudgetUsd: c.dailyBudgetUsd, totalBudgetUsd: c.totalBudgetUsd, requestBudgetUsd: c.requestBudgetUsd,
    concurrency: c.concurrency, rounds: `${c.softRounds}/${c.hardRounds}`, streaming: c.streaming};
}
