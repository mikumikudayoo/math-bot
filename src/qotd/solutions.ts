import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { QuestionRenderer, validateCrop } from './crops.js';
import { openPdf } from './pdf.js';
import { fingerprint, hash, parseManual } from './parser.js';
import type { ParsedQuestion, SolutionSource } from './types.js';
import type { Competition, Session } from './competition.js';

export function bindSolutionSource(occurrence: {source?:unknown;payload?:unknown} | undefined, answer:string, solution:string):SolutionSource | undefined {
  if(!occurrence) return;
  const q:ParsedQuestion=JSON.parse(String(occurrence.payload));
  if(q.officialAnswer!==answer || q.officialSolution!==solution || !q.solutionPage || !q.solutionEndPage) return;
  return {sourceId:String(occurrence.source),number:q.number,solutionPage:q.solutionPage,solutionEndPage:q.solutionEndPage,
    ...(q.solutionRange ? {range:q.solutionRange} : {})};
}

// The same source verification and renderer serve daily reveals and private practice.
export async function renderSolutionSnapshot(store: import('./store.js').QotdStore, questionId: string, snapshot: import('./competition.js').Snapshot) {
  if (snapshot.solutionCrop) {
    try { validateCrop(snapshot.solutionCrop); return snapshot; } catch { /* Recover from original PDF. */ }
  }
    const occurrence=store.occurrences(questionId)[0];
    const bound=snapshot.solutionSource ?? bindSolutionSource(occurrence,snapshot.expectedAnswer,snapshot.solution);
    if(!bound) throw new Error('missing-solution-source');
    const source=store.source(bound.sourceId);
    if(!source) throw new Error('missing-source-document');
    const path=String(source.asset);
    if(hash(await readFile(path))!==bound.sourceId) throw new Error('source-document-hash-mismatch');
    const pdf=await openPdf(path);
    try {
      // Re-parse old imports to recover line anchors without resetting/re-importing
      // the bank. Exact official fields and the fingerprint must still match.
      const parsed=parseManual(pdf.pages.map(p=>p.text));
      const matches=parsed.questions.filter(q=>q.number===bound.number && q.solutionPage===bound.solutionPage &&
        q.solutionEndPage===bound.solutionEndPage && fingerprint(q)===questionId &&
        q.officialAnswer===snapshot.expectedAnswer && q.officialSolution===snapshot.solution);
      if(matches.length!==1) throw new Error('source-solution-not-uniquely-matched');
      const question=matches[0]!;
      if(!question.solutionRange || question.flags.includes('ambiguous-solution-pair')) throw new Error('unreliable-solution-boundaries');
      const renderer=new QuestionRenderer(pdf,resolve(dirname(path),'solution-crops'));
      const crop=await renderer.solution(question);
      if(crop.status==='failed') throw new Error(crop.flags.join('; '));
      validateCrop(crop);
      if(crop.images.some(i=>snapshot.questionCrop.images.some(q=>q.sha256===i.sha256))) throw new Error('solution-is-question-crop');
      const solutionSource={...bound,range:question.solutionRange};
      return {...snapshot, solutionSource, solutionCrop: crop};
    } finally { await pdf.close(); }
}

// Existing daily frozen delivery plans remain unchanged; media failures never undo scoring.
export async function prepareSolutionCrop(c:Competition,s:Session):Promise<Session> {
  try {
    const history=c.store.historyEntry(s.guild,s.id);
    if(!history) throw new Error('missing-history');
    const snapshot=await renderSolutionSnapshot(c.store,String(history.question),s.snapshot);
    c.db.prepare(`UPDATE qotd_sessions SET snapshot=json_set(snapshot,'$.solutionSource',json(?),'$.solutionCrop',json(?))
      WHERE id=? AND NOT EXISTS(SELECT 1 FROM qotd_delivery WHERE qotd=?)`)
      .run(JSON.stringify(snapshot.solutionSource ?? null),JSON.stringify(snapshot.solutionCrop ?? null),s.id,s.id);
    return {...s,snapshot};
  } catch {
    console.error(`MPoTD #${s.id}: official solution crop failed; using existing reveal fallback.`);
    return s;
  }
}
