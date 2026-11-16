import { RE2JS, RE2JSSyntaxException } from 're2js';
import { UserError } from './types.js';

/**
 * Safe regex tool backed by re2js (a pure-JS port of RE2): matching is linear in the input, so a
 * model-written pattern cannot trigger catastrophic backtracking. See docs/tools-v2.md.
 * All lengths and indices are UTF-16 code units (JavaScript string positions).
 */
export const REGEX_MAX_PATTERN_CHARS = 500;
export const REGEX_MAX_TEXT_CHARS = 100_000;
export const REGEX_MAX_REPLACEMENT_CHARS = 1_000;
/** Most matches (extract), parts (split) or replacements (`limit`) one call may ask for. */
export const REGEX_MAX_MATCHES = 200;
/** Longest match text or capture-group text returned; longer values are clipped and flagged. */
export const REGEX_MAX_MATCH_CHARS = 500;
/** Longest split part returned; longer parts are clipped and counted in `clippedParts`. */
export const REGEX_MAX_PART_CHARS = 2_000;
/** Upper bound on `JSON.stringify(result).length` for every operation. */
export const REGEX_MAX_OUTPUT_CHARS = 16_000;
/** `g` and `u` are accepted no-ops: scanning is global where relevant and always Unicode-aware. */
export const REGEX_ALLOWED_FLAGS = 'gimsu';
/** Cap on text length x compiled program size, which bounds the cost of a single linear scan. */
export const REGEX_MAX_WORK = 10_000_000;
/** Wall-clock budget for multi-match scans; when it runs out the result is partial and flagged. */
export const REGEX_TIME_BUDGET_MS = 250;
export const REGEX_OPERATIONS = ['test', 'match', 'extract', 'count', 'replace', 'split'] as const;

export type RegexOperation = typeof REGEX_OPERATIONS[number];
export interface RegexArgs { pattern: string; flags?: string; text: string; operation?: RegexOperation; replacement?: string; limit?: number }
export interface RegexMatch {
  text: string; index: number; end: number;
  /** Numbered groups 1..n in order; null when a group did not take part in the match. */
  groups?: (string | null)[];
  named?: Record<string, string | null>;
  /** Present when the match text or a group was cut to fit the size limits. */
  clipped?: true;
}
export type RegexResult =
  | { operation: 'test'; matched: boolean }
  | { operation: 'match'; matched: boolean; match: RegexMatch | null }
  | { operation: 'extract'; count: number; countExact: boolean; truncated: boolean; matches: RegexMatch[]; timeLimited?: true }
  | { operation: 'count'; count: number; countExact: boolean; timeLimited?: true }
  | { operation: 'replace'; result: string; replacements: number; truncated: boolean; timeLimited?: true }
  | { operation: 'split'; count: number; countExact: boolean; truncated: boolean; parts: string[]; clippedParts?: number; timeLimited?: true };
/** Test seam: a deterministic clock and budget. Production callers pass only `args`. */
export interface RegexRuntime { now?: () => number; timeBudgetMs?: number }

export const regexToolDefinition = {type:'function',function:{name:'regex',description:'Run a safe linear-time regular expression (RE2 syntax: no lookarounds or backreferences) over the given text. Operations: test, match (first match with groups), extract (all matches), count, replace (all matches; $1 and $<name> allowed in replacement), split. Indices are UTF-16 offsets. Use \\p{L} or \\p{Nd} for non-ASCII letters or digits.',parameters:{type:'object',properties:{pattern:{type:'string',description:'RE2 pattern, at most 500 characters.'},text:{type:'string',description:'Text to search, at most 100000 characters.'},operation:{type:'string',enum:['test','match','extract','count','replace','split']},flags:{type:'string',description:'Any of: i (ignore case), m (multiline ^ and $), s (dot matches newline).'},replacement:{type:'string',description:'Required for replace, at most 1000 characters.'},limit:{type:'integer',minimum:1,maximum:200,description:'Maximum matches or parts returned, or replacements made.'}},required:['pattern','text'],additionalProperties:false}}};

const KEYS = new Set(['pattern', 'flags', 'text', 'operation', 'replacement', 'limit']);
/** Room left for the JSON envelope around the collected items. */
const ENVELOPE = 240;

function optionalString(value: unknown, message: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new UserError(message);
  return value;
}
/** Cuts at `max` code units without leaving half of a surrogate pair behind. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = max > 0 ? text.charCodeAt(max - 1) : 0;
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}
function printable(text: string, max: number): string {
  return clip(text, max).replace(/[^\x20-\x7e]/g, '?');
}

function syntaxError(error: RE2JSSyntaxException): UserError {
  const description = typeof error.error === 'string' ? error.error : '';
  const near = typeof error.input === 'string' ? error.input : '';
  let feature = '';
  if (/^\(\?<[=!]/.test(near)) feature = 'lookbehind';
  else if (/^\(\?[=!]/.test(near)) feature = 'lookahead';
  else if (/^\(\?>/.test(near)) feature = 'atomic group';
  else if (/^\(\?\(/.test(near)) feature = 'conditional';
  else if (description === 'invalid escape sequence' && /^\\[1-9k]/.test(near)) feature = 'backreference';
  else if (description === 'invalid nested repetition operator' && /^(?:[*+?]|\{[\d,]*\})\+$/.test(near)) feature = 'possessive quantifier';
  else if (description === 'invalid or unsupported Perl syntax') feature = `"${printable(near, 12)}"`;
  if (feature) return new UserError(`Unsupported regex feature: ${feature}. This tool uses RE2 syntax, which has no lookarounds or backreferences.`);
  const detail = printable(description, 60) || 'syntax error';
  return new UserError(`Invalid regex pattern: ${detail}${near && near.length <= 12 ? ` near "${printable(near, 12)}"` : ''}.`);
}

function compile(pattern: string, flags: string): RE2JS {
  let bits = 0;
  if (flags.includes('i')) bits |= RE2JS.CASE_INSENSITIVE;
  if (flags.includes('m')) bits |= RE2JS.MULTILINE;
  if (flags.includes('s')) bits |= RE2JS.DOTALL;
  try { return RE2JS.compile(pattern, bits); }
  catch (error) { throw error instanceof RE2JSSyntaxException ? syntaxError(error) : new UserError('Invalid regex pattern.'); }
}

type Piece = string | { group: number } | { special: 'match' | 'before' | 'after' };
/** Parses a replacement with String.prototype.replace semantics: $$ $& $` $' $n $nn $<name>. */
function replacementPieces(replacement: string, groupCount: number, names: Record<string, number>): Piece[] {
  const pieces: Piece[] = [];
  let literal = '';
  const push = (piece: Piece) => { if (literal) { pieces.push(literal); literal = ''; } pieces.push(piece); };
  const hasNames = Object.keys(names).length > 0;
  for (let i = 0; i < replacement.length; i++) {
    const char = replacement[i]!;
    const next = replacement[i + 1];
    if (char !== '$' || next === undefined) { literal += char; continue; }
    if (next === '$') { literal += '$'; i++; continue; }
    if (next === '&') { push({ special: 'match' }); i++; continue; }
    if (next === '`') { push({ special: 'before' }); i++; continue; }
    if (next === "'") { push({ special: 'after' }); i++; continue; }
    if (next >= '0' && next <= '9') {
      const after = replacement[i + 2];
      const two = after !== undefined && after >= '0' && after <= '9' ? Number(next + after) : 0;
      if (two >= 1 && two <= groupCount) { push({ group: two }); i += 2; continue; }
      const one = Number(next);
      if (one >= 1 && one <= groupCount) { push({ group: one }); i++; continue; }
    } else if (next === '<' && hasNames) {
      const close = replacement.indexOf('>', i + 2);
      if (close !== -1) {
        const name = replacement.slice(i + 2, close);
        // An unknown name expands to nothing, exactly like JavaScript.
        if (Object.hasOwn(names, name)) push({ group: names[name]! });
        i = close;
        continue;
      }
    }
    literal += char;
  }
  if (literal) pieces.push(literal);
  return pieces;
}

/**
 * Evaluates one regex request. Throws UserError with a short message for invalid input; never
 * returns more than REGEX_MAX_OUTPUT_CHARS of JSON.
 */
export function regexTool(args: Record<string, unknown>, runtime: RegexRuntime = {}): RegexResult {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new UserError('Invalid regex arguments.');
  for (const key of Object.keys(args)) if (!KEYS.has(key)) throw new UserError('Unknown regex argument.');
  const { pattern, text } = args;
  if (typeof pattern !== 'string' || !pattern) throw new UserError('Missing regex pattern.');
  if (pattern.length > REGEX_MAX_PATTERN_CHARS) throw new UserError(`Regex pattern is too long (max ${REGEX_MAX_PATTERN_CHARS} characters).`);
  if (typeof text !== 'string') throw new UserError('Missing text to search.');
  if (text.length > REGEX_MAX_TEXT_CHARS) throw new UserError(`Text is too long (max ${REGEX_MAX_TEXT_CHARS} characters).`);
  const operation = optionalString(args.operation, 'Unknown regex operation.') ?? 'match';
  if (!(REGEX_OPERATIONS as readonly string[]).includes(operation)) throw new UserError(`Unknown regex operation. Use one of: ${REGEX_OPERATIONS.join(', ')}.`);
  const flags = optionalString(args.flags, 'Invalid regex flags.') ?? '';
  if (flags.length > REGEX_ALLOWED_FLAGS.length || [...flags].some((flag, index) => !REGEX_ALLOWED_FLAGS.includes(flag) || flags.indexOf(flag) !== index))
    throw new UserError(`Unsupported regex flag. Allowed flags: ${[...REGEX_ALLOWED_FLAGS].join(', ')}.`);
  const replacement = optionalString(args.replacement, 'Invalid replacement.');
  if (replacement !== undefined && replacement.length > REGEX_MAX_REPLACEMENT_CHARS) throw new UserError(`Replacement is too long (max ${REGEX_MAX_REPLACEMENT_CHARS} characters).`);
  if (operation === 'replace' && replacement === undefined) throw new UserError('Missing replacement.');
  let limit: number | undefined;
  if (args.limit !== undefined && args.limit !== null) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > REGEX_MAX_MATCHES)
      throw new UserError(`Limit must be a whole number from 1 to ${REGEX_MAX_MATCHES}.`);
    limit = args.limit;
  }

  const regex = compile(pattern, flags);
  if (Math.max(text.length, 1) * regex.programSize() > REGEX_MAX_WORK) throw new UserError('Regex is too complex for this much text. Simplify the pattern or shorten the text.');

  const now = runtime.now ?? (() => performance.now());
  const budget = runtime.timeBudgetMs ?? REGEX_TIME_BUDGET_MS;
  const started = now();
  const overTime = () => now() - started > budget;
  const room = REGEX_MAX_OUTPUT_CHARS - ENVELOPE;
  try {
    if (operation === 'test') return { operation, matched: regex.test(text) };

    const matcher = regex.matcher(text);
    const groupCount = regex.groupCount();
    const names = regex.namedGroups();
    const nameList = Object.keys(names);
    const capture = (max: number): RegexMatch => {
      const whole = matcher.group(0) ?? '';
      let clipped = whole.length > max;
      const match: RegexMatch = { text: clip(whole, max), index: matcher.start(0), end: matcher.end(0) };
      if (groupCount) {
        match.groups = [];
        for (let group = 1; group <= groupCount; group++) {
          const value = matcher.group(group);
          if (value !== null && value.length > max) clipped = true;
          match.groups.push(value === null ? null : clip(value, max));
        }
        // fromEntries defines own properties, so a group named __proto__ stays a plain key.
        if (nameList.length) match.named = Object.fromEntries(nameList.map(name => [name, match.groups![names[name]! - 1] ?? null]));
      }
      if (clipped) match.clipped = true;
      return match;
    };
    /** Captures the current match, shrinking the clip length until it fits in `space`. */
    const fitted = (space: number): { match: RegexMatch; size: number } => {
      let max = REGEX_MAX_MATCH_CHARS;
      for (;;) {
        const match = capture(max);
        const size = JSON.stringify(match).length + 1;
        if (size <= space || max === 0) return { match, size };
        max >>= 1;
      }
    };

    if (operation === 'match') {
      if (!matcher.find()) return { operation, matched: false, match: null };
      return { operation, matched: true, match: fitted(room).match };
    }

    if (operation === 'count') {
      let count = 0;
      while (matcher.find()) {
        count++;
        if (overTime()) return { operation, count, countExact: false, timeLimited: true };
      }
      return { operation, count, countExact: true };
    }

    if (operation === 'extract') {
      const max = limit ?? REGEX_MAX_MATCHES;
      const matches: RegexMatch[] = [];
      let count = 0, used = 0, truncated = false;
      while (matcher.find()) {
        count++;
        if (!truncated) {
          if (matches.length >= max) truncated = true;
          else {
            // Only the first match may shrink below the normal clip length to fit; later ones are dropped.
            const { match, size } = matches.length ? { match: capture(REGEX_MAX_MATCH_CHARS), size: 0 } : fitted(room);
            const cost = size || JSON.stringify(match).length + 1;
            if (used + cost > room) truncated = true;
            else { matches.push(match); used += cost; }
          }
        }
        // Past the limit the scan only counts, which is cheap, until the time budget runs out.
        if (overTime()) return { operation, count, countExact: false, truncated: true, matches, timeLimited: true };
      }
      return { operation, count, countExact: true, truncated, matches };
    }

    if (operation === 'replace') {
      const pieces = replacementPieces(replacement ?? '', groupCount, names);
      const max = limit ?? Number.POSITIVE_INFINITY;
      const out: string[] = [];
      let length = 0, last = 0, replacements = 0, full = false, timeLimited = false;
      const append = (piece: string) => {
        if (full || !piece) return;
        out.push(piece);
        length += piece.length;
        if (length > room) full = true;
      };
      while (!full && replacements < max && matcher.find()) {
        const start = matcher.start(0), end = matcher.end(0);
        append(text.slice(last, start));
        for (const piece of pieces) {
          if (full) break;
          if (typeof piece === 'string') append(piece);
          else if ('group' in piece) append(matcher.group(piece.group) ?? '');
          else append(piece.special === 'match' ? matcher.group(0) ?? '' : piece.special === 'before' ? text.slice(0, start) : text.slice(end));
        }
        last = end;
        replacements++;
        if (overTime()) { timeLimited = true; break; }
      }
      if (!timeLimited) append(text.slice(last));
      let result = out.join('');
      let truncated = full || timeLimited;
      // JSON escaping can expand the text, so shrink until the serialized result fits.
      for (let keep = Math.min(result.length, room); ; ) {
        const candidate = clip(result, keep);
        const size = JSON.stringify(candidate).length;
        if (size <= room) { truncated ||= candidate.length < result.length; result = candidate; break; }
        keep = Math.max(0, Math.min(keep - 1, Math.floor(keep * room / size)));
      }
      return { operation, result, replacements, truncated, ...(timeLimited ? { timeLimited: true as const } : {}) };
    }

    // split: JavaScript String.prototype.split semantics, without captured groups in the output.
    const max = limit ?? REGEX_MAX_MATCHES;
    const parts: string[] = [];
    let count = 0, used = 0, clippedParts = 0, truncated = false, last = 0, timeLimited = false;
    const emit = (part: string) => {
      count++;
      if (truncated) return;
      if (parts.length >= max) { truncated = true; return; }
      const kept = clip(part, REGEX_MAX_PART_CHARS);
      const cost = JSON.stringify(kept).length + 1;
      if (used + cost > room) { truncated = true; return; }
      if (kept.length < part.length) clippedParts++;
      parts.push(kept);
      used += cost;
    };
    if (!text) {
      if (!matcher.find()) emit('');
    } else {
      while (matcher.find()) {
        const start = matcher.start(0), end = matcher.end(0);
        if (start >= text.length) break; // never split at the very end
        if (end !== last) { emit(text.slice(last, start)); last = end; } // skip an empty match at the previous split point
        if (overTime()) { timeLimited = true; break; }
      }
      if (!timeLimited) emit(text.slice(last));
    }
    return {
      operation: 'split', count, countExact: !timeLimited, truncated: truncated || timeLimited, parts,
      ...(clippedParts ? { clippedParts } : {}), ...(timeLimited ? { timeLimited: true as const } : {}),
    };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError('Regex could not be evaluated.');
  }
}
