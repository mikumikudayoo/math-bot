import type { Competition } from '../qotd/competition.js';
import { atomic } from '../qotd/competition.js';
import { discordId } from './auth.js';

export function memberRecords(c:Competition,guild:string,user:string) {
  discordId(user);
  return c.db.prepare(`SELECT r.*,h.day FROM qotd_submissions r JOIN qotd_sessions s ON s.id=r.qotd
    JOIN qotd_history h ON h.id=s.id WHERE h.guild=? AND r.user=? AND s.scoredAt IS NOT NULL ORDER BY r.qotd`).all(guild,user);
}
/** Placements and aggregate stats stay derived, not independently editable counters. */
function rerank(c:Competition,id:number) {
  const rows=c.results(id).sort((a,b)=>a.submittedAt-b.submittedAt||a.user.localeCompare(b.user));
  const correctCount=rows.filter(r=>r.correct===1).length;let place=0;
  for(const row of rows) {
    const placement=row.correct===1?++place:null;
    const context={...(row.context?JSON.parse(row.context):{}),correct:row.correct===1,placement,participantCount:rows.length,correctCount};
    c.db.prepare('UPDATE qotd_submissions SET placement=?,context=? WHERE qotd=? AND user=?').run(placement,JSON.stringify(context),id,row.user);
  }
}
export function correctMember(c:Competition,guild:string,user:string,operation:'set'|'add'|'reset',options:{post?:number;points?:number;correct?:boolean;confirm?:boolean}) {
  discordId(user);
  return atomic(c.db,()=>{
    const before=memberRecords(c,guild,user);
    if(operation==='reset') {
      if(options.confirm!==true)throw new Error('Reset requires confirm:true.');
      for(const row of before)c.db.prepare('DELETE FROM qotd_submissions WHERE qotd=? AND user=?').run(row.qotd!,user);
      for(const row of before)rerank(c,Number(row.qotd));
    } else {
      const row=before.find(row=>Number(row.qotd)===options.post);
      if(!row)throw new Error('Choose an existing scored submission in this server.');
      if(options.points===undefined && options.correct===undefined)throw new Error('Provide points or correctness.');
      const correct=options.correct===undefined?Number(row.correct):Number(options.correct);
      const points=options.points===undefined?(correct?Number(row.points):0):operation==='add'?Number(row.points)+options.points:options.points;
      if(!Number.isFinite(points)||points<0||points>1_000_000||Math.abs(points*1000-Math.round(points*1000))>0.00001)throw new Error('Points must be 0–1000000 with at most three decimal places.');
      if(!correct && points!==0)throw new Error('Incorrect submissions must have zero points.');
      c.db.prepare('UPDATE qotd_submissions SET points=?,correct=? WHERE qotd=? AND user=?').run(points,correct,options.post!,user);
      rerank(c,options.post!);
    }
    return {before,after:memberRecords(c,guild,user)};
  });
}
