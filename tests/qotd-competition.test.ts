import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas } from '@napi-rs/canvas';
import { MessageFlags } from 'discord.js';
import { QotdStore } from '../src/qotd/store.js';
import { Competition, CLOSED } from '../src/qotd/competition.js';
import { parseManual, hash } from '../src/qotd/parser.js';
import { grade, type GradingConfig } from '../src/qotd/grading.js';
import { DEFAULT_SCORING, scoreSubmission, type ScoreContext } from '../src/qotd/scoring.js';
import { dayTimes, periods, manilaDay } from '../src/qotd/periods.js';
import { postDaily, revealAnswer, revealMessages, disableAnswerButton, qotdScheduler } from '../src/qotd/posting.js';
import { handleQotdComponent, answerModal } from '../src/qotd/components.js';
import { leaderboardText, statsText } from '../src/qotd/standings.js';
import { handleStudyMessage } from '../src/study.js';
import { qotd } from '../src/commands/qotd.js';
import { phimo } from './qotd-fixtures.js';

const dir=mkdtempSync(join(tmpdir(),'qotd-competition-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
const guild='111111111111111111', channel='222222222222222222', message='333333333333333333';
const users=['444444444444444444','555555555555555555','666666666666666666'];
const day='2026-09-14', times=dayTimes(day);
function crop(name:string,color:string) {
  const canvas=createCanvas(80,40),ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,80,40);
  const bytes=canvas.toBuffer('image/png'),path=join(dir,name);writeFileSync(path,bytes);
  return {status:'override' as const,images:[{path,sha256:hash(bytes),page:1,rect:null,width:80,height:40}],flags:[]};
}
const questionCrop=crop('question.png','white'), solutionCrop=crop('solution.png','red');
function setup(path=':memory:') {
  const store=new QotdStore(path),c=new Competition(store),parsed=parseManual(phimo);
  for(const q of parsed.questions)q.crop=questionCrop;
  store.import('synthetic','meaningless (2).pdf','/private/source.pdf',3,parsed);
  for(const q of store.list()) {store.review(q.id,'approved','mod',true,true);c.configure(q.id,{grading:{mode:'numeric',value:'94'},scoring:DEFAULT_SCORING},'mod');}
  return {store,c};
}
function start(c:Competition,date=day) {
  const selected=c.store.claim(guild,channel,date)!;
  c.create(selected.claim.id,selected.question,dayTimes(date).opensAt);
  c.store.finish(selected.claim.id,message);
  return c.session(selected.claim.id)!;
}
function submit(c:Competition,id:number,answer:string,at:number,user=users[0]!) {
  const token=c.openModal(id,guild,channel,message,user,at);
  return c.submit(token,guild,channel,user,answer,at);
}

const unit:GradingConfig={mode:'numeric_with_unit',value:'3',units:['cm'],unitRequired:true};
for(const [answer,expected] of [['3cm',true],['3 cm',true],['3 CM',true],['3m',false],['3kg',false],['3',false],['3cm garbage',false]] as const) {
  test(`explicit unit grading: ${answer}`,()=>assert.equal(grade(answer,unit),expected));
}
test('optional units allow missing unit but never incompatible units',()=>{
  const config={...unit,unitRequired:false} as GradingConfig;
  assert.equal(grade('3',config),true);assert.equal(grade('3cm',config),true);assert.equal(grade('3m',config),false);
});
test('fractions and decimal forms are equivalent only when configured',()=>{
  assert.equal(grade('1/2',{mode:'numeric',value:'0.5',fractions:true}),true);
  assert.equal(grade('1/2',{mode:'numeric',value:'0.5'}),false);
  for(const bad of ['1/0','NaN','Infinity','3junk','0x10','1+2'])assert.equal(grade(bad,{mode:'numeric',value:'3',fractions:true}),false);
  assert.equal(grade('3.00',{mode:'numeric',value:'3'}),true);
});
test('variable wrappers are local configuration, including mandatory wrapper mode',()=>{
  const config:GradingConfig={mode:'variable_value',value:'3',variable:'x',wrapperOptional:true};
  for(const answer of ['3','x=3','x = 3'])assert.equal(grade(answer,config),true);
  assert.equal(grade('y=3',config),false);assert.equal(grade('x=3',{mode:'numeric',value:'3'}),false);
  assert.equal(grade('3',{...config,wrapperOptional:false}),false);
});
test('exact, normalized and configured multiple-choice aliases; no AI dependency',()=>{
  assert.equal(grade(' Blue ',{mode:'exact_text',answers:['Blue']}),false);
  assert.equal(grade(' BLUE  sky ',{mode:'normalized_text',answers:['blue sky']}),true);
  for(const answer of ['A','a','option a'])assert.equal(grade(answer,{mode:'multiple_choice',answers:['A','option A']}),true);
  assert.equal(grade('option a',{mode:'multiple_choice',answers:['A']}),false);
});
test('centralized scoring has a modest configurable speed bonus and worthwhile late points',()=>{
  const context:ScoreContext={correct:true,openedAt:0,submittedAt:30_000,elapsedSeconds:30,placement:1,participantCount:70,correctCount:20,questionType:'open'};
  assert.equal(scoreSubmission(context),11.983);
  assert.equal(scoreSubmission({...context,elapsedSeconds:240}),11.867);
  assert.equal(scoreSubmission({...context,elapsedSeconds:40000}),10);
  assert.equal(scoreSubmission({...context,correct:false}),0);
  assert.equal(scoreSubmission(context,{...DEFAULT_SCORING,basePoints:20,speedBonus:0}),20);
});
for(const answers of [['94','92'],['92','94'],['94','92','94']]) {
  test(`latest answer and timestamp win: ${answers.join(' -> ')}`,()=>{
    const {store,c}=setup();try {
      const s=start(c);
      answers.forEach((a,i)=>assert.equal(submit(c,s.id,a,times.opensAt+(i+1)*60_000),i>0));
      const final=c.results(s.id)[0]!;
      assert.equal(final.answer,answers.at(-1));assert.equal(final.submittedAt,times.opensAt+answers.length*60_000);
      assert.equal(final.correct,null);
      const rows=c.score(s.id,times.revealAt);
      assert.equal(rows[0]!.correct,Number(answers.at(-1)==='94'));
      assert.equal(JSON.parse(rows[0]!.context!).elapsedSeconds,answers.length*60);
    }finally{store.close();}
  });
}
test('main question gets the sole button and source question crop; thread gets only a name',async()=>{
  const {store,c}=setup();try{
    const sent:any[]=[],threads:any[]=[];
    await postDaily(store,guild,channel,async payload=>{sent.push(payload);return{id:message,startThread:async options=>{threads.push(options);return{id:message};}};},day,users[2],times.opensAt);
    assert.equal(sent.length,1);assert.equal(sent[0].poll,undefined);assert.equal(sent[0].components[0].toJSON().components[0].label,'Submit Answer');
    assert.equal(sent[0].files[0].attachment,questionCrop.images[0]!.path);
    assert.match(sent[0].content,/You may change your answer anytime/);
    assert.equal(threads.length,1);assert.equal(threads[0].components,undefined);assert.match(threads[0].name,/09\/14\/2026/);
    assert.equal(c.session(Number(store.history(guild)[0]!.id))!.thread,message);assert.equal(c.isDiscussion(guild,message),true);
    await postDaily(store,guild,channel,async()=>{throw new Error('duplicate');},day,undefined,times.opensAt);
  }finally{store.close();}
});
test('failed discussion creation never loses the confirmed question reservation',async()=>{
  const {store,c}=setup();try{
    await postDaily(store,guild,channel,async()=>({id:message,startThread:async()=>{throw new Error('forbidden');}}),day,undefined,times.opensAt);
    assert.equal(store.history(guild)[0]!.state,'posted');assert.equal(c.isDiscussion(guild,message),true);
  }finally{store.close();}
});
test('button opens modal and private first/replacement responses never reveal correctness',async()=>{
  const {store,c}=setup();try{
    const s=start(c),now=times.opensAt+1000;
    const realOpen=c.openModal.bind(c),realSubmit=c.submit.bind(c);
    c.openModal=(...args)=>realOpen(...args.slice(0,5) as [number,string,string,string,string],now);
    c.submit=(...args)=>realSubmit(...args.slice(0,5) as [string,string,string,string,string],now);
    let modal:any;const replies:any[]=[];
    const button:any={isButton:()=>true,isModalSubmit:()=>false,customId:`qotd:answer:${s.id}`,guildId:guild,channelId:channel,message:{id:message},user:{id:users[0]},showModal:async(m:any)=>{modal=m.toJSON();},reply:async(p:any)=>replies.push(p)};
    assert.equal(await handleQotdComponent(button,c),true);
    assert.equal(modal.title,'Submit QOTD Answer');assert.equal(modal.components[0].components[0].placeholder,'Enter your final answer...');
    const interaction:any={...button,isButton:()=>false,isModalSubmit:()=>true,customId:modal.custom_id,fields:{getTextInputValue:()=> '94'}};
    await handleQotdComponent(interaction,c);
    assert.equal(replies[0].flags,MessageFlags.Ephemeral);assert.match(replies[0].content,/Answer submitted! 🔒/);assert.doesNotMatch(replies[0].content,/correct|incorrect/);
    await handleQotdComponent(button,c);interaction.customId=modal.custom_id;await handleQotdComponent(interaction,c);
    assert.match(replies[1].content,/Answer updated!/);assert.equal(c.results(s.id).length,1);
  }finally{store.close();}
});
test('copied, stale, wrong-guild, wrong-user and replayed components are rejected',()=>{
  const {store,c}=setup();try{
    const s=start(c);
    for(const [g,ch,m] of [[users[0]!,channel,message],[guild,message,message],[guild,channel,users[0]!]])assert.throws(()=>c.openModal(s.id,g!,ch!,m!,users[0]!,times.opensAt));
    const token=c.openModal(s.id,guild,channel,message,users[0]!,times.opensAt);
    assert.throws(()=>c.submit(token,guild,channel,users[1]!,'94',times.opensAt));
    assert.throws(()=>c.submit(token,users[1]!,channel,users[0]!,'94',times.opensAt));
    c.submit(token,guild,channel,users[0]!,'94',times.opensAt);
    assert.throws(()=>c.submit(token,guild,channel,users[0]!,'92',times.opensAt));
    start(c,'2026-09-15');assert.throws(()=>c.openModal(s.id,guild,channel,message,users[0]!,times.opensAt),/closed/);
  }finally{store.close();}
});
test('authoritative cutoff rejects already-open modal, even when disabling Discord fails',async()=>{
  const {store,c}=setup();try{
    const s=start(c),token=c.openModal(s.id,guild,channel,message,users[0]!,times.closesAt-1);
    await assert.rejects(disableAnswerButton(c,s,async()=>{throw new Error('Discord offline');},times.closesAt));
    assert.equal(c.session(s.id)!.state,'closed');assert.equal(c.session(s.id)!.disabled,0);
    assert.throws(()=>c.submit(token,guild,channel,users[0]!,'94',times.closesAt),new RegExp(CLOSED.replace(/[.]/g,'\\.')));
    let payload:any;await disableAnswerButton(c,c.session(s.id)!,async p=>{payload=p;},times.closesAt);
    assert.equal(payload.components[0].toJSON().components[0].disabled,true);assert.equal(c.session(s.id)!.disabled,1);
  }finally{store.close();}
});
test('cutoff is enforced without a scheduler tick and early reveal bypass is removed',async()=>{
  const {store,c}=setup();try{
    const s=start(c),token=c.openModal(s.id,guild,channel,message,users[0]!,times.closesAt-1);
    assert.throws(()=>c.submit(token,guild,channel,users[0]!,'94',times.closesAt),/closed/);
    await assert.rejects(revealAnswer(store,guild,s.id,'mod',async()=>{throw new Error('must not send');},times.opensAt,true),/not due/);
  }finally{store.close();}
});
test('correct placements use final timestamps, ties use stable IDs, scoring is immutable',()=>{
  const {store,c}=setup();try{
    const s=start(c);submit(c,s.id,'94',times.opensAt+1000,users[1]);submit(c,s.id,'94',times.opensAt+1000,users[0]);submit(c,s.id,'92',times.opensAt+2000,users[2]);
    const once=c.score(s.id,times.revealAt),again=c.score(s.id,times.revealAt+99999);
    assert.deepEqual(once,again);assert.equal(once[0]!.user,users[0]);assert.equal(once[1]!.placement,2);assert.equal(once[2]!.points,0);
    const context=JSON.parse(once[0]!.context!);assert.equal(context.participantCount,3);assert.equal(context.correctCount,2);
    c.configure(String(store.history(guild)[0]!.question),{grading:{mode:'numeric',value:'92'},scoring:{...DEFAULT_SCORING,basePoints:100}},'mod');
    assert.deepEqual(c.score(s.id,times.revealAt),once);
  }finally{store.close();}
});
test('period boundaries are Manila calendar months and Monday through Sunday',()=>{
  assert.deepEqual(periods('2026-09-20'),{month:'2026-09',week:'2026-09-14',weekEnd:'2026-09-20'});
  assert.equal(periods('2026-09-21').week,'2026-09-21');assert.equal(periods('2027-01-01').week,'2026-12-28');
  assert.equal(manilaDay(new Date('2026-09-30T16:00:00Z')),'2026-10-01');assert.equal(times.revealAt-times.closesAt,1000);
});
test('period reset notices persist and appear once, both on first post',()=>{
  const path=join(dir,'notices.sqlite');let {store,c}=setup(path);
  try{
    const first=start(c);assert.deepEqual(first.notices,['Weekly leaderboard reset.','Monthly leaderboard reset.']);
    store.close();store=new QotdStore(path);c=new Competition(store);
    assert.deepEqual(start(c,'2026-09-15').notices,[]);
    const q=String(store.history(guild)[0]!.question);store.reset(guild,q,'mod');
    assert.deepEqual(start(c,'2026-09-21').notices,['Weekly leaderboard reset.']);
    store.reset(guild,q,'mod');assert.deepEqual(start(c,'2026-10-01').notices,['Weekly leaderboard reset.','Monthly leaderboard reset.']);
  }finally{store.close();}
});
test('leaderboards and stats use historical final results, scoped ranks and participated days only',()=>{
  const {store,c}=setup();try{
    for(const [date,answers] of [['2026-08-31',['94','92']],['2026-09-13',['92','94']],['2026-09-14',['94','94']]] as const) {
      for(const q of store.list('approved'))store.reset(guild,q.id,'mod');
      const s=start(c,date),t=dayTimes(date);
      answers.forEach((answer,i)=>submit(c,s.id,answer,t.opensAt+1000,users[i]));c.score(s.id,t.revealAt);
    }
    assert.equal(c.leaderboard(guild,'total',day)[0]!.submitted,3);
    assert.equal(c.leaderboard(guild,'month',day)[0]!.submitted,2);
    assert.equal(c.leaderboard(guild,'week',day)[0]!.submitted,1);
    const stats=c.stats(guild,users[0]!,day);assert.equal(stats[0]!.rank,1);assert.equal(stats[1]!.rank,2);assert.equal(stats[2]!.rank,1);
    assert.match(statsText(c,guild,users[0]!,day),/Accuracy: 66.7%/);assert.match(leaderboardText(c,guild,day),/2026-09-14 to 2026-09-20/);
    assert.equal(c.stats(guild,'777777777777777777',day)[0]!.rank,null);
    assert.deepEqual(c.leaderboard('other','total',day),[]);
  }finally{store.close();}
});
test('reveal uses separate solution assets and public source metadata, with only participant pings',()=>{
  const {store,c}=setup();try{
    for(const q of store.list('approved'))c.configure(q.id,{grading:{mode:'numeric',value:'94'},solutionCrop},'mod');
    const s=start(c);submit(c,s.id,'94',times.opensAt+1000);submit(c,s.id,'private-wrong-answer',times.opensAt+2000,users[1]);c.score(s.id,times.revealAt);
    const payloads=revealMessages(c,c.session(s.id)!);
    assert.equal((payloads[0]!.files![0] as any).attachment,solutionCrop.images[0]!.path);
    assert.match(payloads[0]!.content!,/PHIMO/);assert.doesNotMatch(JSON.stringify(payloads),/meaningless|private\/source|private-wrong-answer/);
    assert.doesNotMatch(payloads[0]!.content!,/Subtract the two/);
    assert.deepEqual(payloads[0]!.allowedMentions,{parse:[]});
    assert.deepEqual(payloads[1]!.allowedMentions,{parse:[],users:[users[0]],roles:[],repliedUser:false});
    assert.match(payloads[1]!.content!,new RegExp(`<@${users[0]}>`));assert.doesNotMatch(payloads[1]!.content!,new RegExp(users[1]!));
  }finally{store.close();}
});
test('solution text fallback and answer-only fallback do not reuse question image',()=>{
  const {store,c}=setup();try{
    const s=start(c);c.score(s.id,times.revealAt);
    assert.ok(revealMessages(c,s)[0]!.content!.includes(s.snapshot.solution));
    assert.equal(revealMessages(c,s)[0]!.files!.length,0);
    const without={...s,snapshot:{...s.snapshot,solution:''}};assert.ok(revealMessages(c,without)[0]!.content!.includes(s.snapshot.expectedAnswer));
    assert.match(revealMessages(c,s)[1]!.content!,/Nobody answered correctly/);
    assert.throws(()=>c.configure(String(store.history(guild)[0]!.question),{grading:{mode:'numeric',value:'94'},solutionCrop:questionCrop},'mod'),/must not reuse/);
  }finally{store.close();}
});
test('official content cannot ping everyone, here, roles or arbitrary users',()=>{
  const {store,c}=setup();try{
    const s=start(c);s.snapshot.solution='@everyone @here <@&123456789012345678> <@555555555555555555>';
    assert.deepEqual(revealMessages(c,s)[0]!.allowedMentions,{parse:[]});
  }finally{store.close();}
});
test('reveal retry after API rejection skips sent parts and never awards twice',async()=>{
  const {store,c}=setup();try{
    const s=start(c);submit(c,s.id,'94',times.opensAt+1000);let calls=0;
    await assert.rejects(revealAnswer(store,guild,s.id,'mod',async()=>{calls++;if(calls===2)throw Object.assign(new Error('forbidden'),{status:403});return{id:message};},times.revealAt));
    const score=c.results(s.id)[0]!.points;
    await revealAnswer(store,guild,s.id,'mod',async()=>{calls++;return{id:users[0]!};},times.revealAt+1000);
    await revealAnswer(store,guild,s.id,'mod',async()=>{throw new Error('duplicate send');},times.revealAt+2000);
    assert.equal(calls,3);assert.equal(c.results(s.id)[0]!.points,score);assert.ok(c.session(s.id)!.revealedAt);
  }finally{store.close();}
});
test('ambiguous reveal stays consumed across restart and requires reconciliation',async()=>{
  const path=join(dir,'reveal.sqlite');let {store,c}=setup(path);
  try{
    const s=start(c);submit(c,s.id,'94',times.opensAt+1000);
    await assert.rejects(revealAnswer(store,guild,s.id,'mod',async()=>{throw new Error('timeout after delivery');},times.revealAt));
    store.close();store=new QotdStore(path);c=new Competition(store);
    await assert.rejects(revealAnswer(store,guild,s.id,'mod',async()=>{throw new Error('must not send');},times.revealAt+2000),/uncertain/);
    assert.equal(c.results(s.id).length,1);assert.ok(c.results(s.id)[0]!.points!>0);
    store.db.prepare("UPDATE qotd_delivery SET state='sent',message=? WHERE qotd=? AND part=0").run(message,s.id);
    let calls=0;await revealAnswer(store,guild,s.id,'mod',async()=>{calls++;return{id:users[0]!};},times.revealAt+3000);assert.equal(calls,1);
  }finally{store.close();}
});
test('two connections serialize rapid replacements and scoring',()=>{
  const path=join(dir,'concurrent.sqlite'),{store,c}=setup(path),other=new QotdStore(path),d=new Competition(other);
  try{
    const s=start(c);for(let n=1;n<=20;n++)submit(n%2?c:d,s.id,n===20?'94':'92',times.opensAt+n);
    assert.equal(c.results(s.id).length,1);assert.equal(c.results(s.id)[0]!.submittedAt,times.opensAt+20);
    assert.deepEqual(c.score(s.id,times.revealAt),d.score(s.id,times.revealAt));
  }finally{other.close();store.close();}
});
test('v2 migration preserves bank, review locks, approvals, schedules, used state and history',()=>{
  const path=join(dir,'migration.sqlite');let {store}=setup(path);
  const q=store.list('approved')[0]!;store.claim(guild,channel,day);store.db.prepare('INSERT INTO qotd_schedule VALUES(?,?,?,?)').run(guild,channel,0,users[0]!);store.close();
  const raw=new DatabaseSync(path);raw.exec('DROP TABLE qotd_delivery;DROP TABLE qotd_modal_tokens;DROP TABLE qotd_submissions;DROP TABLE qotd_period_notices;DROP TABLE qotd_sessions;DROP TABLE qotd_question_settings;PRAGMA user_version=2;');raw.close();
  store=new QotdStore(path);try{
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version,3);assert.equal(store.get(q.id)!.state,'approved');assert.equal(store.history(guild).length,1);assert.equal(store.db.prepare('SELECT count(*) n FROM qotd_used').get()!.n,1);assert.equal(store.db.prepare('SELECT role FROM qotd_schedule').get()!.role,users[0]);
    assert.equal(store.claim(guild,channel,day),null);
  }finally{store.close();}
});
test('human discussion and AI mentions/replies stay silent before any service queue call',async()=>{
  const {store,c}=setup();try{
    const s=start(c);let calls=0;
    const runtime:any={config:()=>({messageFeatures:true,aiTesterUserIds:[users[0]],guildId:guild}),service:async()=>{calls++;throw new Error('must not queue');},isQotdDiscussion:(g:string,ch:string)=>c.isDiscussion(g,ch)};
    const m:any={author:{id:users[0],bot:false},guildId:guild,channelId:message,content:'<@999999999999999999> I think it is 23',client:{user:{id:'999999999999999999'}},reference:{messageId:message},reply:async()=>{calls++;}};
    await handleStudyMessage(m,runtime);assert.equal(calls,0);assert.equal(c.results(s.id).length,0);
    assert.equal(submit(c,s.id,'94',times.opensAt+1000),false);
  }finally{store.close();}
});
test('public stats and leaderboard are registered without exposing moderator actions',()=>{
  const json=qotd.data.toJSON();assert.equal(json.default_member_permissions,undefined);
  assert.ok(json.options!.some(o=>o.name==='leaderboard'));assert.ok(json.options!.some(o=>o.name==='stats'));
  assert.ok(!json.options!.some(o=>o.name==='answer'));
  assert.equal(answerModal('token').toJSON().components.length,1);
});
test('scheduler posts at 8, survives duplicate ticks, disables at 21:59:59 and reveals at 22',async()=>{
  const {store,c}=setup();try{
    store.db.prepare('INSERT INTO qotd_schedule VALUES(?,?,0,?)').run(guild,channel,users[0]!);
    let now=times.opensAt-1;const sent:any[]=[],edits:any[]=[];
    const destination:any={id:channel,guildId:guild,isSendable:()=>true,send:async(p:any)=>{sent.push(p);return{id:message,startThread:async()=>({id:message})};},messages:{fetch:async()=>({edit:async(p:any)=>{edits.push(p);}})}};
    const client:any={channels:{fetch:async()=>destination}};
    let tick=qotdScheduler(client,store,guild,()=>now);await tick();assert.equal(sent.length,0);
    now=times.opensAt;tick=qotdScheduler(client,store,guild,()=>now);await Promise.all([tick(),qotdScheduler(client,store,guild,()=>now)()]);assert.equal(sent.length,1);
    const id=Number(store.history(guild)[0]!.id);submit(c,id,'94',now+1000);
    now=times.closesAt;await tick();assert.equal(edits.length,1);assert.equal(sent.length,1);assert.equal(c.session(id)!.state,'closed');
    now=times.revealAt;await tick();assert.equal(sent.length,3);assert.ok(c.session(id)!.revealedAt);
    await qotdScheduler(client,store,guild,()=>now)();assert.equal(sent.length,3);
  }finally{store.close();}
});
test('restart catches yesterday’s due reveal without a schedule; failed button edit does not block results',async()=>{
  const {store,c}=setup();try{
    const s=start(c);submit(c,s.id,'94',times.opensAt+1000);let sends=0;
    const client:any={channels:{fetch:async()=>({guildId:guild,isSendable:()=>true,messages:{fetch:async()=>{throw new Error('edit failed');}},send:async()=>{sends++;return{id:message};}})}};
    await qotdScheduler(client,store,guild,()=>times.revealAt+12*3600_000)();
    assert.equal(sends,2);assert.ok(c.session(s.id)!.revealedAt);assert.equal(c.session(s.id)!.disabled,0);
  }finally{store.close();}
});
test('modal tokens survive restart but stay user-bound and expire at the daily cutoff',()=>{
  const path=join(dir,'modal-restart.sqlite');let {store,c}=setup(path);
  try{
    const s=start(c),token=c.openModal(s.id,guild,channel,message,users[0]!,times.opensAt);
    store.close();store=new QotdStore(path);c=new Competition(store);
    assert.equal(c.submit(token,guild,channel,users[0]!,'94',times.opensAt+1000),false);
    assert.equal(c.results(s.id)[0]!.submittedAt,times.opensAt+1000);
  }finally{store.close();}
});
test('public subcommands are allowed for ordinary members, moderator actions are denied',async()=>{
  let reply:any;const i:any={inGuild:()=>true,memberPermissions:{has:()=>false},options:{getSubcommand:()=> 'reset'},reply:async(p:any)=>{reply=p;}};
  await qotd.execute(i);assert.match(reply.content,/manage server/);assert.equal(reply.flags,MessageFlags.Ephemeral);
});
test('configured scoring can change future days without changing persisted past totals',()=>{
  const {store,c}=setup();try{
    const first=start(c);submit(c,first.id,'94',times.opensAt+1000);c.score(first.id,times.revealAt);
    const original=c.leaderboard(guild,'total',day)[0]!.points;
    const q=store.list('approved').find(q=>q.id!==String(store.history(guild)[0]!.question))!;
    c.configure(q.id,{grading:{mode:'numeric',value:'94'},scoring:{...DEFAULT_SCORING,basePoints:25,speedBonus:0}},'mod');
    const next=start(c,'2026-09-15'),nextTimes=dayTimes(next.day);submit(c,next.id,'94',nextTimes.opensAt+1000);c.score(next.id,nextTimes.revealAt);
    assert.equal(c.results(next.id)[0]!.points,25);assert.equal(c.leaderboard(guild,'total',next.day)[0]!.points,Math.round((original+25)*1000)/1000);
  }finally{store.close();}
});
