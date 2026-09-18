import { createHash } from 'node:crypto';
import type { ManualMetadata, ParsedManual, ParsedQuestion } from './types.js';

// Fingerprinting never modifies the stored source text. Keep case and math symbols:
// x and X, or < and >, can denote different mathematical problems.
export const normalize = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();
export const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
export function fingerprint(q: Pick<ParsedQuestion, 'text' | 'choices'>) {
  return hash(JSON.stringify([normalize(q.text), q.choices.map(c => [c.label.toUpperCase(), normalize(c.text)])]));
}
export function metadataFromPages(pages: string[]): ManualMetadata {
  const text = pages.join('\n');
  const heading = text.split('\n').find(l => /(?:PHIMO|VTAMPS).*\bSet\s+\d/i.test(l))?.trim() ?? '';
  const competition = /PHIMO/i.test(heading || text) ? 'PHIMO' : /VTAMPS/i.test(text) ? 'VTAMPS' : null;
  const edition = (heading || text).match(competition === 'PHIMO' ? /(?:FRR\s*|PHIMO\s*)(20\d\d|\d{2})\b/i : /VTAMPS\s*v?\s*(\d+(?:\.\d+)?)/i)?.[1] ?? null;
  const year = edition && /^\d{2}$/.test(edition) ? 2000 + Number(edition) : edition && /^20\d{2}$/.test(edition) ? Number(edition) : null;
  return { competition, edition, year, level: (heading || text).match(/(?:Senior\s+Secondary|Junior\s+Secondary|Secondary\s*\d+|Primary\s*\d+)/i)?.[0] ?? null,
    set: (heading || text).match(/\bSet\s+([\d-]+)/i)?.[1] ?? null, title: heading || 'Unidentified manual' };
}
const topic = /^(?:LOGICAL THINKING|ALGEBRA|NUMBER THEORY|GEOMETRY|COMBINATORICS|PART\s+\d+\s*:\s*.+)\s*$/i;
const footer = /^(?:VTAMPS|PHIMO).*\bSet\s+\d/i;
interface Line { text: string; page: number; index: number }
interface Block { number: number; section: string; lines: Line[]; page: number }
function choicesFrom(text: string, section: string) {
  if (!/MULTIPLE\s+CHOICE/i.test(section)) return { text, choices: [] };
  const all = [...text.matchAll(/(?<!\S)([A-Ea-e])[.)]\s+/g)];
  const matches = all.slice(all.findIndex(m => m[1]!.toUpperCase() === 'A'));
  if (matches.length < 2 || matches.some((m, i) => m[1]!.toUpperCase() !== String.fromCharCode(65 + i))) return { text, choices: [] };
  return { text: text.slice(0, matches[0]!.index).trim(), choices: matches.map((m, i) => ({ label: m[1]!.toUpperCase(), text: text.slice(m.index! + m[0].length, matches[i + 1]?.index ?? text.length).trim() })) };
}
export function parseManual(pages: string[]): ParsedManual {
  const metadata = metadataFromPages(pages);
  const lines: Line[] = pages.flatMap((p, i) => p.split('\n').map((text,index) => ({ text, page: i + 1, index })).filter(l => !footer.test(l.text.trim())));
  const blocks: Block[] = [];
  let section = ''; let current: Block | undefined; let solutionMode = false;
  for (const line of lines) {
    if (topic.test(line.text.trim())) { section = line.text.trim(); continue; }
    const start = line.text.match(/^\s*(\d{1,3})[.)]\s+(?=\S)/);
    // Restrict starts to the expected sequence (or a restart at 1), avoiding
    // numbered equations/steps within official solutions where possible.
    const number = start ? Number(start[1]) : 0;
    if (start && (!current || number === current.number + 1 || (number === 1 && current.number > 1 && !solutionMode))) {
      if (number === 1 && current) solutionMode = true;
      current = { number, section, page: line.page, lines: [{ ...line, text: line.text.slice(start[0].length) }] };
      blocks.push(current);
    } else if (current) current.lines.push(line);
  }
  const questions: ParsedQuestion[] = [];
  const warnings: string[] = [];
  // The first repeated question number separates the question listing from
  // worked solutions. The source formats use continuous numbering across parts.
  const seen = new Set<number>();
  const split = blocks.findIndex(b => { if (seen.has(b.number)) return true; seen.add(b.number); return false; });
  const questionBlocks = split < 0 ? blocks.filter(b => !b.lines.some(l => /^\s*Answer\s*:/i.test(l.text))) : blocks.slice(0, split);
  const solutionBlocks = split < 0 ? blocks.filter(b => b.lines.some(l => /^\s*Answer\s*:/i.test(l.text))) : blocks.slice(split);
  const inputs = questionBlocks.length ? questionBlocks : solutionBlocks;
  for (const b of inputs) {
    const candidates = solutionBlocks.filter(s => s.number === b.number);
    const s = candidates[0];
    const rawQuestion = b.lines.map(l => l.text).join('\n');
    const rawSolution = s?.lines.map(l => l.text).join('\n') ?? '';
    const answer = /(?:^|\n)\s*Answer\s*:/i.exec(rawSolution);
    const solution = /(?:^|\n)\s*Solution\s*[:.]/i.exec(rawSolution);
    const sourceText = (b === s && answer ? rawQuestion.slice(0, answer.index) : rawQuestion).trim();
    const extracted = choicesFrom(sourceText, b.section);
    const flags = ['visual-source-review-required'];
    if (!answer || !solution || solution.index < answer.index) flags.push('missing-answer-or-solution');
    if (candidates.length > 1) flags.push('ambiguous-solution-pair');
    if (/MULTIPLE\s+CHOICE/i.test(b.section) && extracted.choices.length < 2) flags.push('choices-unreadable');
    if (/[\x00-\x08\x0e-\x1f\ufffd\ue000-\uf8ff]/.test(rawQuestion + rawSolution)) flags.push('damaged-math-text');
    if (/diagram|figure|shown|circle|triangle|graph|square|rectangle/i.test(sourceText)) flags.push('possible-diagram');
    if (sourceText.length < 20) flags.push('sparse-text');
    // Slice source strings directly; no trimming or answer correction.
    const officialAnswer = answer && solution && solution.index > answer.index ? rawSolution.slice(answer.index + answer[0].length, solution.index) : '';
    const officialSolution = solution ? rawSolution.slice(solution.index + solution[0].length) : '';
    const solutionLine = solution ? rawSolution.slice(0, solution.index + solution[0].length).split('\n').length - 1 : -1;
    const next = blocks[blocks.indexOf(b) + 1];
    const solutionStart = s?.lines[solutionLine];
    const nextSolution = s ? blocks[blocks.indexOf(s) + 1] : undefined;
    // Question listings and worked solutions use different line widths. Compare
    // the shared first-line prefix, not an identical physical line wrap.
    const reliableEnd = !nextSolution || questionBlocks.some(q => {
      if(q.number!==nextSolution.number) return false;
      const a=normalize(q.lines[0]!.text),b=normalize(nextSolution.lines[0]!.text);
      return a===b || Math.min(a.length,b.length)>=20 && (a.startsWith(b)||b.startsWith(a));
    }) &&
      nextSolution.lines.some(l=>/^\s*Answer\s*:/i.test(l.text)) && nextSolution.lines.some(l=>/^\s*Solution\s*[:.]/i.test(l.text));
    questions.push({ number: b.number, section: b.section, text: extracted.text, choices: extracted.choices,
      kind: extracted.choices.length ? 'mcq' : 'open', officialAnswer, officialSolution,
      questionPage: b.page, questionEndPage: b.lines.at(-1)?.page ?? b.page,
      solutionPage: s ? s.lines[solutionLine]?.page ?? s.page : null,
      solutionEndPage: s?.lines.at(-1)?.page ?? null, rawQuestion, rawSolution, flags,
      ...(solutionStart && candidates.length === 1 && reliableEnd ? { solutionRange: {
        start: { page: solutionStart.page, line: solutionStart.index },
        end: nextSolution ? { page: nextSolution.page, line: nextSolution.lines[0]!.index } : null,
      } } : {}),
      questionRange: { start: { page: b.page, line: b.lines[0]!.index },
        end: next ? { page: next.page, line: next.lines[0]!.index } : null, separateListing: b !== s && split >= 0 } });
  }
  if (!metadata.competition || !metadata.set) warnings.push('Unrecognized metadata: inspect source manually.');
  if (!questions.length) warnings.push('No questions extracted; scanned or unsupported PDF needs manual transcription.');
  if (solutionBlocks.length !== questions.length) warnings.push(`Question/solution count mismatch: ${questions.length}/${solutionBlocks.length}.`);
  return { metadata, questions, warnings };
}
