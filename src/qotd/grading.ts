export type GradingConfig =
  | { mode: 'exact_text' | 'normalized_text' | 'multiple_choice'; answers: string[] }
  | { mode: 'numeric'; value: string; fractions?: boolean; tolerance?: number }
  | { mode: 'numeric_with_unit'; value: string; units: string[]; unitRequired: boolean; fractions?: boolean; tolerance?: number }
  | { mode: 'variable_value'; value: string; variable: string; wrapperOptional: boolean; fractions?: boolean; tolerance?: number };

const normalized = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const numberPattern = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
function numeric(s: string, fractions = false): number | null {
  s = s.trim();
  if (fractions && s.includes('/')) {
    const parts = s.split('/');
    if (parts.length !== 2) return null;
    const a = numeric(parts[0]!), b = numeric(parts[1]!);
    return a === null || b === null || b === 0 || !Number.isFinite(a / b) ? null : a / b;
  }
  if (!new RegExp(`^${numberPattern}$`).test(s)) return null;
  const n = Number(s); return Number.isFinite(n) ? n : null;
}
export function validateGrading(config: GradingConfig): void {
  if (!config || typeof config !== 'object') throw new Error('Grading must be an object.');
  if ('answers' in config) {
    if (!['exact_text','normalized_text','multiple_choice'].includes(config.mode) || !Array.isArray(config.answers) || !config.answers.length || config.answers.some(a => typeof a !== 'string' || !a.trim())) throw new Error('Supply nonempty accepted answers.');
    return;
  }
  if (!['numeric','numeric_with_unit','variable_value'].includes(config.mode) || typeof config.value !== 'string' || numeric(config.value, config.fractions) === null) throw new Error('Invalid numeric expected value.');
  if (config.fractions !== undefined && typeof config.fractions !== 'boolean') throw new Error('fractions must be a boolean.');
  if (config.tolerance !== undefined && (!Number.isFinite(config.tolerance) || config.tolerance < 0)) throw new Error('Invalid tolerance.');
  if (config.mode === 'numeric_with_unit' && (!Array.isArray(config.units) || !config.units.length || config.units.some(u => typeof u !== 'string' || !u.trim()) || typeof config.unitRequired !== 'boolean')) throw new Error('Explicit units and unitRequired are required.');
  if (config.mode === 'variable_value' && (!/^[a-zA-Z]+$/.test(config.variable) || typeof config.wrapperOptional !== 'boolean')) throw new Error('Invalid variable wrapper configuration.');
}
export function grade(answer: string, config: GradingConfig): boolean {
  validateGrading(config);
  if ('answers' in config) return config.answers.some(a => config.mode === 'exact_text' ? answer === a : normalized(answer) === normalized(a));
  let value = answer.trim();
  if (config.mode === 'numeric_with_unit') {
    const match = value.match(new RegExp(`^(${numberPattern}(?:\\s*/\\s*${numberPattern})?)\\s*(.*?)$`));
    if (!match) return false;
    value = match[1]!;
    const unit = normalized(match[2]!);
    if (!unit ? config.unitRequired : !config.units.some(u => normalized(u) === unit)) return false;
  }
  if (config.mode === 'variable_value') {
    const match = value.match(/^([a-zA-Z]+)\s*=\s*(.*)$/);
    if (match) { if (match[1] !== config.variable) return false; value = match[2]!; }
    else if (!config.wrapperOptional) return false;
  }
  const actual = numeric(value, config.fractions), expected = numeric(config.value, config.fractions)!;
  return actual !== null && Math.abs(actual - expected) <= (config.tolerance ?? 0);
}
