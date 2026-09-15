import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits,type ChatInputCommandInteraction } from 'discord.js';
import { ReminderStore } from '../src/reminders/store.js';
import { deliverDue } from '../src/reminders/scheduler.js';
import { renderReminder } from '../src/reminders/templates.js';
import { nextOccurrence,parseTime,templates,type ReminderInput } from '../src/reminders/types.js';
import { makeReminderCommand } from '../src/commands/reminder.js';
import { loadCommands } from '../src/commands/index.js';
const now=parseTime('2030-01-01 12:00');
const guild='123456789012345678',actor='223456789012345678';
const input:ReminderInput={guild,channel:'323456789012345678',role:null,template:'session',details:'VTAMPS begins in one hour. Bring your worksheet.',due:now+60000,recurrence:'none',interval:1};

test('Manila input is strict and stored as an unambiguous instant',()=>{
  assert.equal(parseTime('2030-01-01 12:00'),Date.UTC(2030,0,1,4));
  for(const text of ['2030-02-30 12:00','2030-01-01 24:00','tomorrow','2030-13-01 12:00'])assert.throws(()=>parseTime(text));
});
test('one-time reminder never sends early and sends only once when due, without AI',async()=>{
  const s=new ReminderStore(':memory:');let sends=0;
  try{const r=s.create(input,actor,now);const send=async()=>{sends++;return {id:'message'};};
    await deliverDue(s,send,input.due-1);assert.equal(sends,0);
    await deliverDue(s,send,input.due);await deliverDue(s,send,input.due+1);
    assert.equal(sends,1);assert.equal(s.get(guild,r.id)!.state,'sent');
  }finally{s.close();}
});
test('pending reminders survive reopening and competing connections cannot duplicate slow delivery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'reminders-')),path=join(dir,'test.sqlite');
  let s=new ReminderStore(path);s.create(input,actor,now);s.close();s=new ReminderStore(path);const other=new ReminderStore(path);
  let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);let sends=0;
  try{
    const first=deliverDue(s,async()=>{sends++;await wait;return {id:'sent'};},input.due);
    await deliverDue(other,async()=>{sends++;return {id:'duplicate'};},input.due);
    release();await first;assert.equal(sends,1);
    await deliverDue(other,async()=>{sends++;return {id:'duplicate'};},input.due);assert.equal(sends,1);
  }finally{release();s.close();other.close();rmSync(dir,{recursive:true,force:true});}
});
test('crash after reservation and ambiguous send errors never retry on restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'reminders-')),path=join(dir,'test.sqlite');let s=new ReminderStore(path);
  const r=s.create(input,actor,now);assert.ok(s.claim(r));s.close();s=new ReminderStore(path);
  try{let sends=0;await deliverDue(s,async()=>{sends++;return {id:'bad'};},input.due);assert.equal(sends,0);assert.equal(s.get(guild,r.id)!.state,'delivering');
    const failed=s.create(input,actor,now);await deliverDue(s,async()=>{throw new Error('Discord may have accepted this');},input.due);
    assert.equal(s.get(guild,failed.id)!.state,'uncertain');await deliverDue(s,async()=>{sends++;return {id:'bad'};},input.due);assert.equal(sends,0);
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('five-month and yearly recurrence preserve Manila time and clamp from original month day',()=>{
  const anchor=parseTime('2030-01-31 18:00');
  const r={anchor,due:anchor,recurrence:'months' as const,interval:5};
  const next=nextOccurrence(r,anchor)!;assert.equal(next,parseTime('2030-06-30 18:00'));
  assert.equal(nextOccurrence({...r,due:next},next),parseTime('2030-11-30 18:00'));
  const monthly={...r,interval:1};const feb=nextOccurrence(monthly,anchor)!;
  assert.equal(feb,parseTime('2030-02-28 18:00'));assert.equal(nextOccurrence({...monthly,due:feb},feb),parseTime('2030-03-31 18:00'));
  const leap=parseTime('2032-02-29 09:00');assert.equal(nextOccurrence({anchor:leap,due:leap,recurrence:'months',interval:12},leap),parseTime('2033-02-28 09:00'));
});
test('recurring delivery advances atomically and skips missed occurrences without a burst',async()=>{
  const s=new ReminderStore(':memory:');
  try{const r=s.create({...input,recurrence:'months',interval:5},actor,now);
    await deliverDue(s,async()=>({id:'sent'}),parseTime('2031-02-01 12:00'));
    const next=s.get(guild,r.id)!;assert.equal(next.state,'pending');assert.equal(next.due,parseTime('2031-04-01 12:01'));
    assert.equal(nextOccurrence({anchor:now,due:now,recurrence:'days',interval:3},now+10*86400000),now+12*86400000);
  }finally{s.close();}
});
test('cancel and edit are guild-scoped and cannot race a claimed send',async()=>{
  const s=new ReminderStore(':memory:');
  try{const r=s.create(input,actor,now);assert.throws(()=>s.cancel('other',r.id,actor));
    s.edit(guild,r.id,{...input,due:input.due+60000,details:'updated'},actor,now);
    let sends=0;await deliverDue(s,async()=>{sends++;return {id:'bad'};},input.due);assert.equal(sends,0);
    s.cancel(guild,r.id,actor);await deliverDue(s,async()=>{sends++;return {id:'bad'};},input.due+60000);assert.equal(sends,0);
    const second=s.create(input,actor,now);s.edit(guild,second.id,{...input,details:'fresh text'},actor,now);
    const claimed=s.claim(second);assert.ok(claimed);assert.equal(claimed.details,'fresh text');
    assert.throws(()=>s.edit(guild,second.id,input,actor,now));assert.throws(()=>s.cancel(guild,second.id,actor));
  }finally{s.close();}
});
test('templates preserve moderator text and allow only the configured role mention',()=>{
  const details='@everyone @here <@123456789012345678> <@&999999999999999999> do not rewrite';
  for(const template of templates){const payload=renderReminder({...input,template,details,role:'423456789012345678'});
    assert.ok(payload.content.includes(details));assert.ok(payload.content.includes(`<t:${input.due/1000}:F>`));
    assert.deepEqual(payload.allowedMentions,{parse:[],roles:['423456789012345678'],users:[],repliedUser:false});assert.deepEqual(payload,renderReminder({...input,template,details,role:'423456789012345678'}));
  }
  assert.deepEqual(renderReminder(input).allowedMentions.roles,[]);
  const s=new ReminderStore(':memory:');try{assert.throws(()=>s.create({...input,role:guild},actor,now));assert.throws(()=>s.create({...input,due:now},actor,now));}finally{s.close();}
});
test('all reminder actions reject normal users before accessing storage; moderator access is not AI-gated',async()=>{
  for(const action of ['create','list','view','edit','cancel']){
    let replies=0;const command=makeReminderCommand(()=>{throw new Error('must not open storage');});
    await command.execute({inGuild:()=>true,memberPermissions:{has:()=>false},options:{getSubcommand:()=>action},reply:async()=>{replies++;}} as unknown as ChatInputCommandInteraction);assert.equal(replies,1);
  }
  const s=new ReminderStore(':memory:');let result='';
  try{const command=makeReminderCommand(()=>s);await command.execute({inGuild:()=>true,guildId:guild,memberPermissions:{has:(p:bigint)=>p===PermissionFlagsBits.ManageGuild},options:{getSubcommand:()=> 'list'},deferReply:async()=>{},editReply:async(p:{content:string})=>{result=p.content;}} as unknown as ChatInputCommandInteraction);assert.equal(result,'no reminders yet.');
    assert.equal(loadCommands().get('reminder')!.access,undefined);assert.equal(command.data.toJSON().default_member_permissions,PermissionFlagsBits.ManageGuild.toString());
  }finally{s.close();}
});
