/**
 * Pure, deterministic grader for the math evaluation harness (evals/math).
 * No I/O, no model calls. Every verdict carries a human-readable `detail`
 * so a reviewer can audit the extraction instead of trusting it blindly.
 */
import { formatDiscord } from '../discord-format.js';

export type Check =
  | {type: 'numeric'; answer: number; tolerance?: number}
  | {type: 'exact'; answers: string[]}
  | {type: 'contains-all'; terms: string[]}
  | {type: 'flags-ambiguity'; terms: string[]}
  | ProofRubric;

/**
 * A proof is scored on separate dimensions; it passes only when all hold. A correct final
 * answer with an invalid or incomplete argument fails. Patterns are regular expressions over
 * normalizeText() output (lowercase, collapsed spaces, superscripts as ^x, no Markdown).
 * Rubrics state necessary evidence of a complete argument and known-invalid steps; they are a
 * regression net, not a proof checker, so live evaluations should still be read by a human.
 */
export interface ProofRubric {
  type: 'proof-rubric';
  answer: {type: 'numeric'; answer: number; tolerance?: number} | {type: 'exact'; answers: string[]};
  required: {label: string; pattern: string}[];
  forbidden?: {label: string; pattern: string}[];
}
export interface Grade {pass: boolean; detail: string; dimensions?: Record<string, boolean>}

export const DEFAULT_TOLERANCE = 1e-9;

const SUPERSCRIPT: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+', '⁼': '=', '⁽': '(', '⁾': ')',
  'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵉ': 'e', 'ᶠ': 'f', 'ᵍ': 'g', 'ʰ': 'h', 'ⁱ': 'i', 'ʲ': 'j', 'ᵏ': 'k', 'ˡ': 'l', 'ᵐ': 'm',
  'ⁿ': 'n', 'ᵒ': 'o', 'ᵖ': 'p', 'ʳ': 'r', 'ˢ': 's', 'ᵗ': 't', 'ᵘ': 'u', 'ᵛ': 'v', 'ʷ': 'w', 'ˣ': 'x', 'ʸ': 'y', 'ᶻ': 'z',
};
const SUPERSCRIPT_RUN = new RegExp('[' + Object.keys(SUPERSCRIPT).join('') + ']+', 'g');

/**
 * Superscripts become `^digits` *before* NFKC, which would otherwise turn
 * `3²` into `32`. Unicode minus signs and dashes become ASCII `-`.
 */
function baseNormalize(text: string): string {
  return text
    // A multi-character exponent keeps its grouping: 2ᵃ⁻¹ -> 2^(a-1), x² -> x^2.
    .replace(SUPERSCRIPT_RUN, run => { const v = [...run].map(c => SUPERSCRIPT[c] ?? '').join(''); return '^' + (v.length > 1 ? '(' + v + ')' : v); })
    .normalize('NFKC')
    .replace(/[−‐‑‒–—﹣－]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/\\left|\\right/g, '')
    // Markdown emphasis, inline code and math delimiters carry no mathematical content here.
    .replace(/[*`$]/g, '');
}

/** Lowercase, collapse whitespace, and drop spaces next to punctuation/operators (`(x - 3)` == `(x-3)`). */
export function normalizeText(text: string): string {
  return baseNormalize(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([^\w\s])\s*/g, '$1')
    .trim();
}

// ---- numeric ----------------------------------------------------------------

const FRAC = /\\[dt]?frac\s*\{\s*(-?[\d.,]+)\s*\}\s*\{\s*(-?[\d.,]+)\s*\}/g;
/**
 * A number, optionally signed, optionally with thousands separators and a decimal
 * part, optionally followed by `/ denominator`. Digits adjacent to `^` (exponents
 * and their bases) or letters (variable names, units glued to digits) are skipped.
 */
const NUMBER = /(?<![\w.^])(?<!\^\{)(-\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s*\/\s*(-)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?)?(?![\w^])/g;

interface Extracted {value: number; text: string}

function numbersIn(segment: string): Extracted[] {
  const out: Extracted[] = [];
  for (const m of segment.matchAll(NUMBER)) {
    const num = Number(m[2]!.replace(/,/g, '') + (m[3] ?? ''));
    let value = m[1] ? -num : num;
    if (m[5] !== undefined) {
      const den = Number(m[5].replace(/,/g, '') + (m[6] ?? '')) * (m[4] ? -1 : 1);
      if (den === 0) continue;
      value /= den;
    }
    if (Number.isFinite(value)) out.push({value, text: m[0].trim()});
  }
  return out;
}

function lastBoxed(text: string): string | undefined {
  const all = [...text.matchAll(/\\boxed\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
  return all.length ? all[all.length - 1]![1] : undefined;
}

/**
 * Drops space-preceded parenthetical asides (`6 (x = 1 is extraneous)`), keeping
 * function-call parentheses (`f(2) = 3`); then takes the text after the last
 * `=` / `≈` / `≡` when a number follows it (`x = 5`, `≡ 481`).
 */
function afterRelation(raw: string): string {
  const stripped = raw.replace(/\s\([^()]*\)/g, '');
  const segment = numbersIn(stripped).length ? stripped : raw;
  const idx = Math.max(segment.lastIndexOf('='), segment.lastIndexOf('≈'), segment.lastIndexOf('≡'));
  if (idx < 0) return segment;
  const rest = segment.slice(idx + 1);
  return numbersIn(rest).length ? rest : segment;
}

/**
 * Extraction order: last `\boxed{}`; else the last line mentioning "answer" (text after
 * the word); else the last line containing a number; then, inside that segment, the text
 * after the last relation sign; finally the last number in that segment. If the chosen
 * segment has no number, fall back to the last number anywhere in the answer.
 */
export function extractFinalNumber(answer: string): (Extracted & {source: string}) | undefined {
  const text = baseNormalize(answer).replace(FRAC, '$1/$2');
  const boxed = lastBoxed(text);
  let segment: string | undefined, source = '';
  if (boxed !== undefined && numbersIn(boxed).length) { segment = boxed; source = 'boxed'; }
  if (segment === undefined) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const answerLine = [...lines].reverse().find(l => /answer/i.test(l) && numbersIn(l.slice(l.toLowerCase().lastIndexOf('answer') + 6)).length);
    if (answerLine) { segment = answerLine.slice(answerLine.toLowerCase().lastIndexOf('answer') + 6); source = 'answer line'; }
    else {
      const numberLine = [...lines].reverse().find(l => numbersIn(l).length);
      if (numberLine) { segment = numberLine; source = 'last line with a number'; }
    }
  }
  if (segment !== undefined) {
    const nums = numbersIn(afterRelation(segment));
    const last = nums[nums.length - 1];
    if (last) return {...last, source};
  }
  const all = numbersIn(text);
  const last = all[all.length - 1];
  return last ? {...last, source: 'last number in text'} : undefined;
}

// ---- exact ------------------------------------------------------------------

function finalLine(answer: string): string {
  const lines = answer.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return [...lines].reverse().find(l => /answer/i.test(l)) ?? lines[lines.length - 1] ?? '';
}

function exactNormalize(s: string): string {
  return normalizeText(s).replace(/\s+/g, '').replace(/[.,;!]+$/, '').replace(/^\{(.*)\}$/, '$1');
}

function exactCandidates(answer: string): string[] {
  const boxed = lastBoxed(baseNormalize(answer));
  const line = normalizeText(finalLine(answer));
  const after = (sep: string) => { const i = line.lastIndexOf(sep); return i >= 0 ? line.slice(i + sep.length) : undefined; };
  const afterAnswer = after('answer')?.replace(/^(?:\s|:|=|is\b)+/, '');
  return [line, after(':'), after('='), after('∈'), afterAnswer, boxed]
    .filter((c): c is string => c !== undefined)
    .map(exactNormalize)
    .filter(Boolean);
}

// ---- terms ------------------------------------------------------------------

/** `a|b|c` = any of the alternatives. Word-initial terms must start at a word boundary ("even" != "seven"). */
function termMatches(haystack: string, term: string): string | undefined {
  for (const raw of term.split('|')) {
    const alt = normalizeText(raw);
    if (!alt) continue;
    const escaped = alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${/^\w/.test(alt) ? '\\b' : ''}${escaped}${/\d$/.test(alt) ? '(?!\\d)' : ''}`);
    if (re.test(haystack)) return alt;
  }
  return undefined;
}

// ---- entry point ------------------------------------------------------------

export function grade(check: Check, answer: string): Grade {
  if (typeof answer !== 'string' || !answer.trim()) return {pass: false, detail: 'empty answer'};
  switch (check.type) {
    case 'numeric': {
      const tolerance = check.tolerance ?? DEFAULT_TOLERANCE;
      const found = extractFinalNumber(answer);
      if (!found) return {pass: false, detail: `no number found; expected ${check.answer}`};
      const pass = Math.abs(found.value - check.answer) <= tolerance * Math.max(1, Math.abs(check.answer));
      return {pass, detail: `extracted ${found.value} ("${found.text}", ${found.source}); expected ${check.answer} ±${tolerance} (relative/absolute)`};
    }
    case 'exact': {
      const expected = check.answers.map(exactNormalize);
      const candidates = exactCandidates(answer);
      const hit = candidates.find(c => expected.includes(c));
      return hit !== undefined
        ? {pass: true, detail: `matched "${hit}"`}
        : {pass: false, detail: `final line "${finalLine(answer).slice(0, 120)}" matched none of ${JSON.stringify(check.answers)}`};
    }
    case 'contains-all': {
      const text = normalizeText(answer);
      const missing = check.terms.filter(t => termMatches(text, t) === undefined);
      return missing.length
        ? {pass: false, detail: `missing key step(s): ${missing.map(t => JSON.stringify(t)).join(', ')}`}
        : {pass: true, detail: `all ${check.terms.length} key steps present`};
    }
    case 'proof-rubric': {
      const final = grade(check.answer, answer);
      // Grade what Discord readers see: TeX is converted first (2^{a-1} -> 2ᵃ⁻¹ -> 2^(a-1)).
      const shown = formatDiscord(answer);
      const text = normalizeText(shown);
      const test = (pattern: string) => new RegExp(pattern, 'i').test(text);
      const missing = check.required.filter(r => !test(r.pattern)).map(r => r.label);
      const invalid = (check.forbidden ?? []).filter(r => test(r.pattern)).map(r => r.label);
      // Discord shows formatted text; leftover TeX commands or brace groups are a notation failure.
      const residue = /\\[a-zA-Z]+|\b(?:tag|boxed|frac|begin|end)\{/.test(shown);
      const dimensions = {finalAnswer: final.pass, completeArgument: !missing.length, validSteps: !invalid.length, notation: !residue};
      return {pass: Object.values(dimensions).every(Boolean), dimensions,
        detail: [`answer: ${final.pass ? 'correct' : 'wrong'} (${final.detail})`,
          missing.length ? `missing: ${missing.join('; ')}` : 'all required steps present',
          invalid.length ? `invalid steps: ${invalid.join('; ')}` : 'no known-invalid step',
          residue ? 'TeX residue after Discord formatting' : 'notation clean'].join(' | ')};
    }
    case 'flags-ambiguity': {
      const text = normalizeText(answer);
      for (const term of check.terms) {
        const hit = termMatches(text, term);
        if (hit !== undefined) return {pass: true, detail: `flags the problem ("${hit}")`};
      }
      return {pass: false, detail: 'does not say the problem is ambiguous, underspecified or impossible'};
    }
  }
}
