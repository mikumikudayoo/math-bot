import { test, after } from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminStore } from '../src/admin/store.js';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction, type Message } from 'discord.js';
import { parseConfig } from '../src/config.js';
import { isAITester, PRIVATE_AI_MESSAGE } from '../src/ai-access.js';
import { loadCommands, commandJSON } from '../src/commands/index.js';
import { ask } from '../src/commands/study.js';
import { submit, handleStudyMessage, type StudyRuntime } from '../src/study.js';

const tester='821682594830614578', other='123456789012345678', bot='234567890123456789', guild='345678901234567890';
const temp=mkdtempSync(join(tmpdir(),'ai-access-'));
after(()=>rmSync(temp,{recursive:true,force:true}));
const env={DISCORD_TOKEN:'test-only',DISCORD_APPLICATION_ID:bot,DISCORD_GUILD_ID:guild,AI_TESTER_USER_IDS:tester,MESSAGE_FEATURES_ENABLED:'true',COACH_USER_IDS:other,ADMIN_DB_PATH:join(temp,'admin.sqlite')};
const config=()=>parseConfig(env,'development');
function interaction(userId:string,privileged=false){
  const replies:{content:string;flags?:number}[]=[];const edits:unknown[]=[];
  const value={id:'456789012345678901',user:{id:userId},guildId:guild,channelId:'567890123456789012',guild:{ownerId:privileged?userId:tester},
    memberPermissions:{has:()=>privileged},member:{roles:[]},inGuild:()=>true,
    channel:{isSendable:()=>true,send:async()=>({id:'678901234567890123',url:'https://discord.com/test'})},
    reply:async(body:{content:string;flags?:number})=>{replies.push(body);},deferReply:async()=>{},editReply:async(body:unknown)=>{edits.push(body);},
  } as unknown as ChatInputCommandInteraction;
  return {value,replies,edits};
}
function runtime(overrides:Partial<ReturnType<typeof config>>={}){
  const calls:{path:string;body:unknown}[]=[];
  const value:StudyRuntime={config:()=>({...config(),...overrides}),service:async<T>(path:string,body?:unknown)=>{
    calls.push({path,body});
    if(path.startsWith('/parent'))return {id:'789012345678901234',user:tester,state:'completed'} as T;
    if(path==='/jobs')return {id:'456789012345678901',message:''} as T;
    return {ok:true} as T;
  }};
  return {value,calls};
}
function message(userId:string,content=`<@${bot}> explain quadratic equations`){
  const replies:unknown[]=[];
  const value={id:'456789012345678901',author:{id:userId,bot:false},guildId:guild,channelId:'567890123456789012',
    content,client:{user:{id:bot}},member:{roles:{cache:new Map([['coach-role',{}]])}},attachments:{first:()=>undefined},
    reply:async(body:unknown)=>{replies.push(body);return {id:'678901234567890123'};},
  } as unknown as Message;
  return {value,replies};
}
test('tester IDs parse from config; blank fails closed and malformed IDs fail validation',()=>{
  assert.ok(isAITester(tester,config()));
  assert.equal(isAITester(other,config()),false);
  assert.deepEqual(parseConfig({...env,AI_TESTER_USER_IDS:` ${tester}, ${other},${tester}, `},'production').aiTesterUserIds,[tester,other]);
  for(const value of ['',undefined])assert.equal(isAITester(tester,parseConfig({...env,AI_TESTER_USER_IDS:value},'development')),false);
  assert.throws(()=>parseConfig({...env,AI_TESTER_USER_IDS:'not-an-id'},'development'),/AI_TESTER_USER_IDS/);
});
test('tester passes registered AI slash-command gate and submits through the shared handler',async()=>{
  const call=interaction(tester);const mock=runtime();
  const registered=loadCommands([{...ask,execute:i=>submit(i,'ask','hello',undefined,mock.value)}],config).get('ask')!;
  await registered.execute(call.value);
  assert.deepEqual(mock.calls.map(x=>x.path),['/jobs','/bind']);assert.equal(call.replies.length,0);assert.equal(call.edits.length,1);
  assert.equal((mock.calls[0]!.body as {discordContext:{isCreator:boolean;userId:string}}).discordContext.userId,tester);
  assert.equal((mock.calls[0]!.body as {discordContext:{isCreator:boolean}}).discordContext.isCreator,true);
});
test('all study slash commands reject normal users and privileged coaches/owners before executing',async()=>{
  const commands=loadCommands(undefined,config);
  for(const name of ['ask','calculate','plot','python','cancel','queue','ai']){
    for(const privileged of [false,true]){
      const call=interaction(other,privileged);await commands.get(name)!.execute(call.value);
      assert.deepEqual(call.replies,[{content:PRIVATE_AI_MESSAGE,flags:MessageFlags.Ephemeral}],name);assert.equal(call.edits.length,0);
    }
  }
});
test('shared submit helper independently rejects unauthorized callers without service access',async()=>{
  const mock=runtime();const call=interaction(other,true);await submit(call.value,'ask','hello',undefined,mock.value);
  assert.equal(mock.calls.length,0);assert.equal(call.replies[0]?.content,PRIVATE_AI_MESSAGE);
});
test('tester mention submits only the prompt, once; both Discord mention formats work',async()=>{
  for(const mention of [`<@${bot}>`,`<@!${bot}>`]){
    const mock=runtime();const event=message(tester,`${mention} hello`);await handleStudyMessage(event.value,mock.value);
    assert.deepEqual(mock.calls.map(x=>x.path),['/jobs','/bind']);assert.equal((mock.calls[0]?.body as {prompt:string}).prompt,'hello');assert.equal(event.replies.length,1);
    assert.equal((mock.calls[0]!.body as {discordContext:{userId:string}}).discordContext.userId,tester);
  }
});
test('non-tester mentions and replies are silent and never call the study service, even for coaches',async()=>{
  const mock=runtime({coachUsers:[other],coachRoles:['coach-role']});
  for(const reply of [false,true]){
    const event=message(other);if(reply)event.value.reference={messageId:'789012345678901234'};
    await handleStudyMessage(event.value,mock.value);assert.equal(event.replies.length,0);
  }
  assert.equal(mock.calls.length,0);
});
test('mentions require message features and nonempty prompts; ignore other bot mentions and DMs',async()=>{
  const disabled=runtime({messageFeatures:false});await handleStudyMessage(message(tester).value,disabled.value);assert.equal(disabled.calls.length,0);
  const blank=runtime({aiTesterUserIds:[]});await handleStudyMessage(message(tester).value,blank.value);assert.equal(blank.calls.length,0);
  for(const content of [`<@${bot}>  `,`<@${other}> hello`,'ordinary conversation']){
    const mock=runtime();await handleStudyMessage(message(tester,content).value,mock.value);assert.equal(mock.calls.length,0);
  }
  const dm=runtime();await handleStudyMessage({...message(tester).value,guildId:null} as Message,dm.value);assert.equal(dm.calls.length,0);
  const botAuthor=runtime();await handleStudyMessage({...message(tester).value,author:{id:tester,bot:true}} as Message,botAuthor.value);assert.equal(botAuthor.calls.length,0);
});
test('tester reply chains and mention-replies share one submission path',async()=>{
  for(const content of ['why?',`<@${bot}> why?`]){
    const mock=runtime();const event=message(tester,content);event.value.reference={messageId:'789012345678901234'};
    await handleStudyMessage(event.value,mock.value);
    assert.equal(mock.calls.filter(x=>x.path==='/jobs').length,1);assert.equal((mock.calls.find(x=>x.path==='/jobs')?.body as {parent:string}).parent,'789012345678901234');
  }
});
test('ordinary commands stay outside tester admission; QOTD public subcommands are discoverable',async()=>{
  const commands=loadCommands(undefined,()=>({aiTesterUserIds:[]}));const call=interaction(other);
  await commands.get('ping')!.execute(call.value);assert.match(call.replies[0]!.content,/pong/);
  for(const name of ['ping','filter','qotd'])assert.equal(commands.get(name)!.access,undefined);
  assert.equal(commands.get('filter')!.data.toJSON().default_member_permissions,PermissionFlagsBits.ManageMessages.toString());
  assert.equal(commands.get('qotd')!.data.toJSON().default_member_permissions,undefined);
});
test('private command definitions are default-disabled; allowlist is never published in command JSON',()=>{
  const definitions=JSON.parse(commandJSON()) as {name:string;default_member_permissions?:string}[];
  for(const name of ['ask','calculate','plot','python','cancel','queue','ai'])assert.equal(definitions.find(x=>x.name===name)?.default_member_permissions,'0');
  assert.notEqual(definitions.find(x=>x.name==='ping')?.default_member_permissions,'0');assert.ok(!commandJSON().includes(tester));
});

test('runtime testers pass both slash gates and mentions; removal denies the next prompt',async()=>{
  const path=join(temp,'runtime.sqlite'),store=new AdminStore(path),mock=runtime({aiTesterUserIds:[],adminDatabase:path});
  try {
    store.changeTester(tester,other,true);
    const registered=loadCommands([{...ask,execute:i=>submit(i,'ask','hi',undefined,mock.value)}],mock.value.config).get('ask')!;
    await registered.execute(interaction(other).value);await handleStudyMessage(message(other).value,mock.value);
    assert.equal(mock.calls.filter(c=>c.path==='/jobs').length,2);
    store.changeTester(tester,other,false);const count=mock.calls.length;
    const denied=interaction(other,true);await registered.execute(denied.value);await handleStudyMessage(message(other).value,mock.value);
    assert.equal(mock.calls.length,count);assert.equal(denied.replies[0]?.content,PRIVATE_AI_MESSAGE);
  } finally {store.close();}
});
