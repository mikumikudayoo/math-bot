import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import { AdminStore } from '../src/admin/store.js';
import { CREATOR_ID } from '../src/discord-context.js';
import { isModerator, isOwner, isDatabaseModerator, MODERATOR_ROLE_ID } from '../src/admin/auth.js';
import { isAITester } from '../src/ai-access.js';
import { runSQL, sqlText } from '../src/admin/sql.js';
import { sqlCommand } from '../src/commands/sql.js';
import { testersCommand } from '../src/commands/testers.js';
import { qotdAdminCommand } from '../src/commands/qotd-admin.js';
import { correctMember, memberRecords } from '../src/admin/qotd.js';
import { Competition } from '../src/qotd/competition.js';
import type { QotdStore } from '../src/qotd/store.js';

const dir=mkdtempSync(join(tmpdir(),'aleph-admin-')),user='222222222222222222',guild='333333333333333333';
after(()=>rmSync(dir,{recursive:true,force:true}));
function interaction(actor=user,role=false,values:Record<string,unknown>={}) {
  const replies:unknown[]=[],defers:unknown[]=[];
  const value={user:{id:actor,username:'synthetic'},guildId:guild,inGuild:()=>true,member:{roles:role?[MODERATOR_ROLE_ID]:[]},memberPermissions:{has:()=>false},
    deferReply:async(o:unknown)=>{defers.push(o);},editReply:async(o:unknown)=>{replies.push(o);},
    options:{getSubcommand:()=>values.action??'list',getString:(n:string)=>values[n]??null,getInteger:(n:string)=>values[n]??null,getNumber:(n:string)=>values[n]??null,getBoolean:(n:string)=>values[n]??null,getUser:()=>({id:values.target??user})}} as unknown as ChatInputCommandInteraction;
  return {value,replies,defers};
}
test('authorization uses authenticated actor, role and existing stronger permissions only',()=>{
  assert.equal(isModerator(interaction().value),false);
  assert.equal(isModerator(interaction(user,true).value),true);
  assert.equal(isModerator(interaction(CREATOR_ID).value),true);
  assert.equal(isOwner(interaction(user,false,{target:CREATOR_ID}).value),false);
  const admin=interaction().value;Object.assign(admin,{memberPermissions:{has:(flag:bigint)=>flag===PermissionFlagsBits.ManageGuild}});
  assert.equal(isModerator(admin),true);assert.equal(isOwner(admin),false);
  assert.equal(isModerator({...interaction(CREATOR_ID).value,inGuild:()=>false} as ChatInputCommandInteraction),false);
});
test('owner tester management persists, merges static IDs, and treats duplicates as no-ops',async()=>{
  const path=join(dir,'testers.sqlite'),store=new AdminStore(path),command=testersCommand({store:()=>store,staticIds:()=>[user]});
  try {
    for(const role of [false,true]) {
      const denied=interaction(user,role,{action:'add',target:CREATOR_ID});await command.execute(denied.value);
      assert.deepEqual(store.testers(),[]);assert.match(String(denied.replies[0]),/only emu/);
    }
    for(const [action,changed] of [['add',true],['add',false],['remove',true],['remove',false]] as const) {
      const call=interaction(CREATOR_ID,false,{action,target:user});await command.execute(call.value);
      assert.deepEqual(call.defers,[{flags:MessageFlags.Ephemeral}]);
      assert.match(JSON.stringify(call.replies),changed?/updated/:/no change/);
      assert.equal(isAITester(user,{aiTesterUserIds:[user],adminDatabase:path}),true);
    }
    store.changeTester(CREATOR_ID,user,true,guild);const reopened=new AdminStore(path);
    assert.equal(reopened.has(user),true);reopened.close();
    assert.equal(isAITester(user,{aiTesterUserIds:[],adminDatabase:path}),true);
    store.changeTester(CREATOR_ID,user,false,guild);
    assert.equal(isAITester(user,{aiTesterUserIds:[],adminDatabase:path}),false);
    assert.throws(()=>store.changeTester(user,CREATOR_ID,true),/Only emu/);
    assert.throws(()=>store.changeTester(CREATOR_ID,'../bad',true),/Invalid/);
    const list=interaction(CREATOR_ID);await command.execute(list.value);assert.match(JSON.stringify(list.replies),/static/);
    assert.ok(store.recent(guild).length>=4);
  } finally {store.close();}
});
test('database-wide access rejects admins from unrelated guilds; admin storage rejects shared bot schemas',async()=>{
  const i=interaction().value;Object.assign(i,{memberPermissions:{has:()=>true},guild:{roles:{fetch:async()=>null}}});
  assert.equal(await isDatabaseModerator(i),false);
  Object.assign(i,{guild:{roles:{fetch:async()=>({id:MODERATOR_ROLE_ID})}}});assert.equal(await isDatabaseModerator(i),true);
  assert.throws(()=>new AdminStore(sqlPath),/separate/);
});
const sqlPath=join(dir,'sql.sqlite');
const fixture=new DatabaseSync(sqlPath);fixture.exec('CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT UNIQUE); INSERT INTO items(value) VALUES(\'one\')');fixture.close();
test('SQL registry rejects paths and missing databases; select, update, errors and truncation are bounded',async()=>{
  const registry={qotd:sqlPath,missing:join(dir,'missing.sqlite')};
  assert.equal((await runSQL(registry,sqlPath,'SELECT 1')).error,'UNKNOWN_DATABASE');
  assert.equal((await runSQL(registry,'__proto__','SELECT 1')).error,'UNKNOWN_DATABASE');
  assert.equal((await runSQL(registry,'missing','SELECT 1')).ok,false);
  const read=await runSQL(registry,'qotd','SELECT value FROM items');assert.deepEqual(read.rows,[['one']]);assert.deepEqual(read.columns,['value']);
  assert.equal((await runSQL(registry,'qotd',"UPDATE items SET value='two' WHERE id=1")).changes,1);
  assert.equal((await runSQL(registry,'qotd','not SQL')).ok,false);
  assert.equal((await runSQL(registry,'qotd',"INSERT INTO items VALUES(2,'x'); DELETE FROM items")).ok,false);
  assert.deepEqual((await runSQL(registry,'qotd','SELECT count(*) FROM items')).rows,[[1]]);
  const many=await runSQL(registry,'qotd','WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) SELECT x FROM n');
  assert.equal(many.shown,20);assert.equal(many.truncated,true);assert.match(sqlText(many),/truncated/);assert.ok(sqlText(many).length<=1800);
  const blob=await runSQL(registry,'qotd','SELECT zeroblob(10000), printf(\'%1000s\',\'x\')');assert.equal(blob.truncated,true);assert.match(JSON.stringify(blob.rows),/blob omitted/);
  assert.equal((await runSQL(registry,'qotd',"PRAGMA table_info('items')")).ok,true);
});
test('SQL blocks filesystem escape, extensions, pragmas, transaction control and rolls back constraint failures',async()=>{
  const registry={test:sqlPath};
  for(const statement of ["ATTACH DATABASE '/tmp/aleph-escape.sqlite' AS other", "VACUUM INTO '/tmp/aleph-escape.sqlite'",'PRAGMA database_list','SELECT * FROM pragma_database_list',"PRAGMA journal_mode=OFF", "SELECT load_extension('file')",'BEGIN','COMMIT','ROLLBACK','SAVEPOINT x',"CREATE VIRTUAL TABLE escape USING fts5(x)"])
    assert.equal((await runSQL(registry,'test',statement)).ok,false,statement);
  await runSQL(registry,'test',"INSERT INTO items VALUES(3,'three')");
  const failed=await runSQL(registry,'test',"UPDATE items SET value='same'");assert.equal(failed.ok,false);
  assert.deepEqual((await runSQL(registry,'test','SELECT value FROM items ORDER BY id')).rows,[['two'],['three']]);
});
test('SQL commands always defer ephemerally and audit attempts, denials, reads and failures',async()=>{
  const store=new AdminStore(':memory:');
  const command=sqlCommand({store:()=>store,registry:()=>({test:sqlPath}),python:()=> 'python3'});
  try {
    const denied=interaction(user,false,{action:'run',database:'test',command:'DELETE FROM items'});await command.execute(denied.value);assert.match(String(denied.replies[0]),/moderator/);
    for(const action of ['run','schema','databases','audit']) {
      const call=interaction(user,true,{action,database:'test',command:'SELECT 42'});await command.execute(call.value);
      assert.deepEqual(call.defers,[{flags:MessageFlags.Ephemeral}]);assert.ok(call.replies.length===1);
    }
    const bad=interaction(user,true,{action:'run',database:'arbitrary/path',command:'SELECT 1'});await command.execute(bad.value);
    assert.match(JSON.stringify(bad.replies),/UNKNOWN_DATABASE/);assert.ok(store.recent(guild).some(r=>r.phase==='failure'));
    const unavailable=sqlCommand({store:()=>{throw new Error('private/path');},registry:()=>({}),python:()=> 'python3'});
    const call=interaction(user,true);await unavailable.execute(call.value);assert.match(String(call.replies[0]),/unavailable/);assert.doesNotMatch(String(call.replies[0]),/private\/path/);
  } finally {store.close();}
});
test('SQL worker interrupts unbounded computation and remains usable afterward',async()=>{
  const start=Date.now();
  const result=await runSQL({test:sqlPath},'test','WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n');
  assert.equal(result.ok,false);assert.ok(Date.now()-start<10000);
  assert.deepEqual((await runSQL({test:sqlPath},'test','SELECT 7')).rows,[[7]]);
});
function competition() {
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE qotd_history(id INTEGER PRIMARY KEY,guild TEXT,day TEXT);
    CREATE TABLE qotd_sessions(id INTEGER PRIMARY KEY REFERENCES qotd_history(id),scoredAt INTEGER);
    CREATE TABLE qotd_submissions(qotd INTEGER REFERENCES qotd_sessions(id),user TEXT,answer TEXT,submittedAt INTEGER,correct INTEGER,placement INTEGER,points REAL,context TEXT,PRIMARY KEY(qotd,user));`);
  db.prepare('INSERT INTO qotd_history VALUES(1,?,?)').run(guild,'2026-09-17');db.exec('INSERT INTO qotd_sessions VALUES(1,10)');
  db.prepare('INSERT INTO qotd_submissions VALUES(1,?,\'answer\',1,1,1,10,\'{}\')').run(user);
  db.prepare('INSERT INTO qotd_submissions VALUES(1,?,\'answer\',2,1,2,9,\'{}\')').run(CREATOR_ID);
  return new Competition({db} as QotdStore);
}
test('QOTD correction preserves derived totals/placements, rejects invalid writes and confirms reset',()=>{
  const c=competition();
  try {
    correctMember(c,guild,user,'set',{post:1,points:5});assert.equal(c.stats(guild,user)[0]!.points,5);
    correctMember(c,guild,user,'add',{post:1,points:-2});assert.equal(c.stats(guild,user)[0]!.points,3);
    for(const points of [-1,NaN,Infinity,0.1234,1_000_001])assert.throws(()=>correctMember(c,guild,user,'set',{post:1,points}));
    assert.throws(()=>correctMember(c,'other',user,'set',{post:1,points:1}));
    assert.throws(()=>correctMember(c,guild,user,'set',{post:1,points:3,correct:false}));
    correctMember(c,guild,user,'set',{post:1,correct:false});assert.equal(c.stats(guild,user)[0]!.result!.correct,0);
    assert.equal(c.stats(guild,CREATOR_ID)[0]!.result!.firsts,1);
    assert.throws(()=>correctMember(c,guild,user,'reset',{confirm:false}));assert.equal(memberRecords(c,guild,user).length,1);
    c.db.prepare('INSERT INTO qotd_history VALUES(2,?,?)').run(guild,'2026-09-18');c.db.exec('INSERT INTO qotd_sessions VALUES(2,NULL)');
    c.db.prepare('INSERT INTO qotd_submissions VALUES(2,?,\'active answer\',1,NULL,NULL,NULL,NULL)').run(user);
    correctMember(c,guild,user,'reset',{confirm:true});assert.equal(memberRecords(c,guild,user).length,0);assert.equal(c.stats(guild,user)[0]!.points,0);
    assert.equal(c.db.prepare('SELECT answer FROM qotd_submissions WHERE qotd=2 AND user=?').get(user)?.answer,'active answer');
    assert.deepEqual(c.db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {c.db.close();}
});
test('QOTD admin denies ordinary users, audits corrections and keeps results private',async()=>{
  const c=competition(),store=new AdminStore(':memory:'),command=qotdAdminCommand({store:()=>store,competition:()=>c});
  try {
    const denied=interaction(user,false,{action:'set',post:1,points:1});await command.execute(denied.value);assert.equal(c.stats(guild,user)[0]!.points,10);
    const corrected=interaction(user,true,{action:'add',post:1,points:2});await command.execute(corrected.value);
    assert.equal(c.stats(guild,user)[0]!.points,12);assert.deepEqual(corrected.defers,[{flags:MessageFlags.Ephemeral}]);assert.equal(store.recent(guild)[0]!.phase,'success');
    const reset=interaction(user,true,{action:'reset',confirm:false});await command.execute(reset.value);assert.equal(c.stats(guild,user)[0]!.points,12);assert.equal(store.recent(guild)[0]!.phase,'failure');
  } finally {store.close();c.db.close();}
});
