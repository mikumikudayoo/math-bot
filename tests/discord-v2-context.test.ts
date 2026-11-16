import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField, type Client, type Guild, type Message } from 'discord.js';
import { captureDiscordState, type SnapshotAnchor } from '../src/discord-snapshot.js';
import { CREATOR_ID, parseTrigger, speakerFacts, currentUser, type DiscordTask } from '../src/discord-context.js';
import { renderContext, snapshotImages, snapshotProvenance } from '../src/service/context-snapshot.js';
import { executeDiscordTool,canDisclose } from '../src/discord-tools.js';
import { studyDeliveryPayload } from '../src/study-audience.js';
import { TurnWebBoundary } from '../src/service/turn-web-boundary.js';
import { mergeProvenance } from '../src/service/provenance.js';
import type { Job } from '../src/service/types.js';
import { handleStudyMessage, type StudyRuntime } from '../src/study.js';
import { parseConfig } from '../src/config.js';

const gid='111111111111111111',cid='211111111111111111',user='311111111111111111',bot='411111111111111111';
const ref=(id:string,channelId=cid)=>({type:0 as const,guildId:gid,channelId,messageId:id});
const id=(n:number)=>String(511111111111111100n+BigInt(n));
const anchor:SnapshotAnchor={id:id(10),guildId:gid,channelId:cid,userId:user,prompt:'explain the geometry',reference:ref(id(8))};
function fixture(){
  const members=new Collection<string,any>(),channels=new Collection<string,any>();
  const reads:{channelId:string;options:any}[]=[];
  let moderates=false;
  const guild:any={id:gid,roles:{everyone:{id:gid},cache:new Collection(),fetch:async()=>{}},members:{fetch:async({user}:any)=>members.get(user),
    fetchMe:async()=>members.get(bot)},channels:{fetch:async(id?:string)=>id?channels.get(id)??null:channels,
      fetchActiveThreads:async()=>({threads:new Collection()})}};
  for(const memberId of [user,bot,CREATOR_ID])members.set(memberId,{id:memberId,guild,
    roles:{cache:new Collection([['staff',{id:'staff',name:'role label',position:1}]])},permissions:{has:(flag:bigint)=>moderates&&flag===PermissionFlagsBits.ModerateMembers}});
  function channel(channelId:string,publicAudience=true){
    const records=new Collection<string,any>();
    const c:any={id:channelId,name:'channel',guildId:gid,guild,type:ChannelType.GuildText,readable:true,publicAudience,records,
      isThread:()=>false,isTextBased:()=>true,isSendable:()=>true,permissionsFor:(m:any)=>({has:(bit:any)=>m.id===gid?(bit===PermissionFlagsBits.ReadMessageHistory||c.publicAudience):c.readable}),permissionOverwrites:{cache:new Collection()},
      messages:{fetch:async(options:{message?:string;before?:string;limit?:number})=>{
        reads.push({channelId,options});
        if(options.message){const m=records.get(options.message);if(!m)throw new Error('deleted');return m;}
        return new Collection([...records.entries()].filter(([k])=>!options.before||BigInt(k)<BigInt(options.before))
          .sort(([a],[b])=>a<b?1:-1).slice(0,options.limit));
      }}};
    channels.set(c.id,c);
    return c;
  }
  const main=channel(cid);
  function message(n:number,content:string,author=user,channel=main){
    const mid=id(n);const m={id:mid,channelId:channel.id,guildId:gid,createdAt:new Date(n*1000),createdTimestamp:n*1000,
      author:{id:author,username:'account handle',displayName:'label',bot:author===bot},member:{displayName:'member label'},
      reference:null,content,system:false,attachments:new Collection<string,unknown>()};
    channel.records.set(mid,m);return m;
  }
  const client={guilds:{fetch:async()=>guild}} as unknown as Client;
  return {guild:guild as Guild,client,main,message,channel,reads,moderator:()=>{moderates=true;}};
}
test('reply and earlier chain links precede scoped recent discussion; IDs and signed image URLs stay outside model text',async()=>{
  const f=fixture();const direct=f.message(8,'the geometry diagram'),earlier=f.message(3,'our earlier construction',CREATOR_ID);
  Object.assign(direct,{reference:ref(earlier.id)});
  direct.attachments.set('bad',{url:'https://example.com/unknown',contentType:'application/pdf',size:24});
  const imageUrl=`https://cdn.discordapp.com/attachments/${cid}/701111111111111111/shape.png`;
  direct.attachments.set('pic',{url:imageUrl,contentType:'image/png',size:340});
  f.message(6,'geometry in the same channel');f.message(7,'unrelated lunch');f.message(9,'geometry from an old bot answer',bot);
  f.message(11,'geometry sent after the ask');
  Object.assign(f.message(2,'geometry edited after the ask'),{editedTimestamp:Date.now()});
  const {host,context}=await captureDiscordState(f.guild,anchor,true);
  assert.ok(context);assert.equal(host.isModerator,false);assert.deepEqual(host.roles,['role label']);
  assert.equal(context.reply?.id,direct.id);assert.deepEqual(context.chain.map(m=>m.id),[earlier.id]);assert.equal(context.chain[0]?.author.relation,'creator');
  assert.deepEqual(context.recent.map(m=>m.id),[id(6)]);assert.deepEqual(snapshotImages(context).map(i=>i.url),[imageUrl]);
  const rendered=renderContext(context);for(const secret of [gid,cid,CREATOR_ID,user,'account handle',imageUrl,'unrelated','after the ask','old bot answer'])assert.ok(!rendered.includes(secret));
  assert.ok(f.reads.some(r=>r.options.before===anchor.id));
});
test('concurrent anchors retain independent messages and permission failures discard content',async()=>{
  const f=fixture();f.message(5,'geometry one');f.message(9,'geometry two');f.message(11,'geometry three');
  const early={...anchor,id:id(6),reference:null},late={...anchor,id:id(12),reference:null};
  const [first,second]=await Promise.all([captureDiscordState(f.guild,early,true),captureDiscordState(f.guild,late,true)]);
  assert.deepEqual(first.context?.recent.map(m=>m.id),[id(5)]);assert.deepEqual(second.context?.recent.map(m=>m.id),[id(5),id(9),id(11)]);
  const fetch=f.main.messages.fetch;
  f.main.messages.fetch=async(o:any)=>{const r=await fetch(o);f.main.readable=false;return r;};
  assert.equal((await captureDiscordState(f.guild,late,true)).context,undefined);
  const deniedCount=f.reads.length;await captureDiscordState(f.guild,late,true);assert.equal(f.reads.length,deniedCount);
});
test('cross-channel references never fetch private source text; authenticated permissions alone set moderator status',async()=>{
  const f=fixture(),hidden=f.channel('901111111111111111',false);f.message(3,'staff only',user,hidden);
  const a={...anchor,reference:ref(id(3),hidden.id)};
  const ordinary=await captureDiscordState(f.guild,a,true);assert.equal(ordinary.context,undefined);assert.equal(ordinary.host.isModerator,false);
  assert.ok(!f.reads.some(r=>r.channelId===hidden.id));f.moderator();
  assert.equal((await captureDiscordState(f.guild,a,true)).host.isModerator,true);
  const ordinaryCreator=await captureDiscordState(fixture().guild,{...anchor,userId:CREATOR_ID},false);assert.equal(ordinaryCreator.host.isModerator,false);
  assert.equal(parseTrigger('\u2063<@'+bot+'> help',bot).sevenAgentTrigger,true);assert.equal(parseTrigger('x\u2063 help',bot).sevenAgentTrigger,false);
  const facts=speakerFacts(currentUser(user,gid,{username:'account handle',roles:['staff'],displayName:'emu',isModerator:'true',isCreator:true}));
  assert.equal(facts.speakerIsModerator,false);assert.equal(facts.speakerIsCreator,false);assert.deepEqual(facts.roleLabels,['staff']);assert.ok(!JSON.stringify(facts).includes('account handle'));
});
test('message entry point recognizes the moderator prefix at byte zero and submits the authorized direct reply',async()=>{
  const f=fixture();f.message(8,'the requested geometry notes');
  const submitted:any[]=[];
  const config=parseConfig({DISCORD_TOKEN:'fixture',DISCORD_APPLICATION_ID:bot,DISCORD_GUILD_ID:gid,AI_TESTER_USER_IDS:user,MESSAGE_FEATURES_ENABLED:'true'},'development');
  const runtime:StudyRuntime={config:()=>config,v2Enabled:async()=>true,service:async<T>(path:string,body?:unknown)=>{
    if(path.startsWith('/parent?'))return null as T;
    if(path==='/jobs'){submitted.push(body);return {id:anchor.id,message:''} as T;}
    return {} as T;
  }};
  const incoming={id:anchor.id,content:'\u2063explain this',author:{id:user,bot:false,username:'account'},
    guildId:gid,guild:f.guild,channelId:cid,client:{user:{id:bot}},reference:anchor.reference,
    attachments:new Collection(),reply:async()=>({id:id(13)})} as unknown as Message;
  await handleStudyMessage(incoming,runtime);assert.equal(submitted.length,0);
  f.moderator();await handleStudyMessage(incoming,runtime);assert.equal(submitted.length,1);
  assert.equal(submitted[0].prompt,'explain this');assert.equal(submitted[0].context.reply.id,id(8));
  assert.equal(submitted[0].discordContext.sevenAgentTrigger,true);assert.equal(submitted[0].discordContext.isModerator,true);
});
test('same-channel history denies for other viewers suppress capture, search and final publication',async()=>{
  const f=fixture();f.message(3,'geometry secret');f.main.permissionOverwrites.cache.set('viewer',{id:'viewer',type:0,
    allow:new PermissionsBitField(PermissionFlagsBits.ViewChannel),deny:new PermissionsBitField(PermissionFlagsBits.ReadMessageHistory)});
  assert.equal((await captureDiscordState(f.guild,anchor,true)).context,undefined);
  const task:DiscordTask={id:'lookup',job:'proof',channel:cid,guild:gid,user,tool:'discord_search',args:{query:'geometry'}};
  assert.deepEqual((await executeDiscordTool(f.client,task,true) as any).results,[]);assert.equal(f.reads.length,0);
  const job={guild:gid,user,channel:cid,state:'completed',provenance:JSON.stringify({classification:'private-discord',discordSources:[{guildId:gid,channelId:cid}]})} as Job;
  assert.equal((await studyDeliveryPayload(f.client,job,'secret')).denied,true);
});
test('age-restricted source stays in its own channel even when its guild permissions are public',async()=>{
  const f=fixture();const source=f.channel('711111111111111111');source.nsfw=true;f.message(8,'geometry old',user,source);
  const task:DiscordTask={id:'lookup',job:'age',channel:cid,guild:gid,user,tool:'discord_search',args:{query:'geometry',channelId:source.id}};
  assert.deepEqual((await executeDiscordTool(f.client,task,true) as any).results,[]);assert.equal(f.reads.length,0);
});
test('witnesses retain verified content only: edits, deletions, permission widening and unknown/conflicting evidence withdraw replies',async()=>{
  const f=fixture();f.main.publicAudience=false;const source=f.message(8,'geometry from staff');
  const state=await captureDiscordState(f.guild,anchor,true);assert.ok(state.context);
  const p=snapshotProvenance(state.context,gid);assert.ok(p.discordEvidence?.length);
  const job={guild:gid,channel:cid,user,state:'completed',provenance:JSON.stringify(p)} as Job;
  const task:DiscordTask={id:'auth',job:'job',user,guild:gid,channel:cid,tool:'discord_audience',args:{sourceChannels:[cid],evidence:p.discordEvidence}};
  const allowed=async()=>{const r:any=await executeDiscordTool(f.client,task,false);return r.allowed===true;};
  assert.equal(await allowed(),true);
  assert.equal((await studyDeliveryPayload(f.client,job,'staff summary')).content,'staff summary');
  const b=new TurnWebBoundary('question');
  const found:any=await executeDiscordTool(f.client,{...task,tool:'discord_search',args:{query:'geometry'}},true);
  b.observeDiscord(found,gid);assert.deepEqual(b.provenance.discordEvidence,p.discordEvidence);
  f.main.publicAudience=true;assert.equal(await allowed(),false);f.main.publicAudience=false;
  source.content='updated';assert.equal(await allowed(),false);
  assert.equal((await studyDeliveryPayload(f.client,job,'staff summary')).denied,true);
  f.main.records.delete(source.id);assert.equal(await allowed(),false);
  const e=p.discordEvidence![0]!;
  assert.equal(mergeProvenance(p,{...p,discordEvidence:[{...e,digest:'a'.repeat(64)}]}).audienceUnknown,true);
});
test('private thread roster changes withdraw earlier snapshots and parent history denies prevent re-publication',async()=>{
  const f=fixture(),parent=f.main,thread=f.channel('711111111111111111');
  const joined=new Set([bot,user,...Array.from({length:101},(_,i)=>String(900111111111111100n+BigInt(i)))]);
  let continuationPages=0;
  thread.type=ChannelType.PrivateThread;thread.parentId=cid;thread.isThread=()=>true;
  thread.members={fetch:async(o:any)=>{
    if(o.withMember){if(o.after)continuationPages++;return new Collection([...joined].sort().filter(id=>!o.after||id>o.after).slice(0,o.limit).map(id=>[id,{id}]));}
    if(joined.has(o.member))return {id:o.member};throw new Error('not a member');
  }};
  parent.permissionsFor=(member:{id:string})=>({has:(bit:unknown)=>bit===PermissionFlagsBits.ManageThreads?false:member.id===gid?true:parent.readable});
  f.message(8,'geometry from thread',user,thread);
  const state=await captureDiscordState(f.guild,{...anchor,channelId:thread.id,reference:ref(id(8),thread.id)},true);assert.ok(state.context);
  const p=snapshotProvenance(state.context,gid),task:DiscordTask={id:'auth',job:'x',user,guild:gid,channel:thread.id,tool:'discord_audience',args:{sourceChannels:[thread.id],evidence:p.discordEvidence}};
  assert.equal((await executeDiscordTool(f.client,task,false) as any).allowed,true);assert.ok(continuationPages>0);
  joined.add('811111111111111111');assert.equal((await executeDiscordTool(f.client,task,false) as any).allowed,false);
  joined.delete('811111111111111111');parent.permissionOverwrites.cache.set('reader',{id:'reader',type:0,allow:new PermissionsBitField(),deny:new PermissionsBitField(PermissionFlagsBits.ReadMessageHistory)});
  const requester=await f.guild.members.fetch({user,force:true}),application=await f.guild.members.fetchMe();
  assert.equal(await canDisclose(thread,thread,requester,application),false);
});
test('legacy rollback skips context reads and treats an invisible prefix as ordinary message content',async()=>{
  const f=fixture();f.moderator();let count=0;
  const runtime:StudyRuntime={config:()=>parseConfig({DISCORD_TOKEN:'fixture',DISCORD_APPLICATION_ID:bot,DISCORD_GUILD_ID:gid,AI_TESTER_USER_IDS:user,MESSAGE_FEATURES_ENABLED:'true'},'development'),
    v2Enabled:async()=>false,service:async<T>()=>{count++;return {} as T;}};
  const event={id:anchor.id,content:'\u2063standalone',author:{id:user,bot:false},client:{user:{id:bot}},guild:f.guild,guildId:gid,channelId:cid,attachments:new Collection()} as unknown as Message;
  await handleStudyMessage(event,runtime);assert.equal(f.reads.length,0);assert.equal(count,0);
});
test('standalone public research omits incidental context before reading messages; replies, attachments and channel references keep it',async()=>{
  const f=fixture();f.message(8,'geometry earlier');
  const open={...anchor,reference:null,prompt:'search the web for geometry olympiads'};
  assert.equal((await captureDiscordState(f.guild,open,true)).context,undefined);
  assert.equal((await captureDiscordState(f.guild,{...open,prompt:'summarize this link https://example.org/geometry'},true)).context,undefined);
  assert.equal(f.reads.length,0);
  for(const a of [{...open,reference:ref(id(8))},{...open,hasAttachments:true},{...open,prompt:'search the web for the geometry idea above'}]){
    assert.ok((await captureDiscordState(f.guild,a,true)).context);
  }
});
test('ranked cursor pages recheck permissions, deletion and requester/job scope; message-ID filtering stays inside selected channel',async()=>{
  const f=fixture();const other=f.channel('701111111111111111');
  for(let n=1;n<=5;n++)f.message(n,'geometry item '+n,user,other);
  const task:DiscordTask={id:'task',guild:gid,channel:cid,user,job:'one',tool:'discord_search',args:{query:'geometry',channelId:other.id,limit:2}};
  const first:any=await executeDiscordTool(f.client,task,true);assert.deepEqual(first.results.map((r:any)=>r.id),[id(5),id(4)]);assert.ok(first.nextCursor);
  const next={...task,args:{...task.args,cursor:first.nextCursor}};
  assert.ok((await executeDiscordTool(f.client,{...next,job:'someone-else'},true) as any).error);
  other.records.delete(id(3));const second:any=await executeDiscordTool(f.client,next,true);
  assert.deepEqual(second.results.map((r:any)=>r.id),[id(2)]);assert.ok(second.nextCursor);
  const look:any=await executeDiscordTool(f.client,{...task,args:{channelId:other.id,messageId:id(1)}},true);
  assert.deepEqual(look.results.map((r:any)=>r.id),[id(1)]);
  other.publicAudience=false;const count=f.reads.length;
  const denied:any=await executeDiscordTool(f.client,{...task,args:{...task.args,cursor:second.nextCursor}},true);
  assert.deepEqual(denied.results,[]);assert.equal(f.reads.length,count);
});
test('search respects the request instant and excludes derived bot replies for scans, exact references and slash commands',async()=>{
  const f=fixture();
  f.message(3,'geometry original');
  Object.assign(f.message(4,'geometry edited later'),{editedTimestamp:Date.now()});
  f.message(5,'geometry from a previous bot answer',bot);
  f.message(11,'geometry posted later');
  const search=(task:DiscordTask)=>executeDiscordTool(f.client,task,true) as Promise<{results:{id:string}[]}>;
  for(const scope of [{job:anchor.id},{job:'message-job',sourceMessageId:anchor.id}]){
    const task:DiscordTask={...scope,id:'t',guild:gid,channel:cid,user,tool:'discord_search',args:{query:'geometry'}};
    assert.deepEqual((await search(task)).results.map(r=>r.id),[id(3)]);
    const refs=[3,4,5,11].map(n=>({id:id(n),channelId:cid}));
    assert.deepEqual((await search({...task,args:{messageRefs:refs}})).results.map(r=>r.id),[id(3)]);
  }
});
test('resume beyond six channels and continue older pages without repeating hits',async()=>{
  const f=fixture();for(let n=1;n<=7;n++){const ch=f.channel(String(711111111111111111n+BigInt(n)));if(n===7)f.message(3,'geometry beyond six',user,ch);}
  for(let n=1;n<=110;n++)f.message(n,n<=10?'geometry older':'other headlines');
  const task:DiscordTask={id:'task',guild:gid,channel:cid,user,job:'two',tool:'discord_search',args:{query:'geometry',limit:10}};
  const first:any=await executeDiscordTool(f.client,task,true);assert.deepEqual(first.results,[]);assert.ok(first.nextCursor);
  const next:any=await executeDiscordTool(f.client,{...task,args:{...task.args,cursor:first.nextCursor}},true);
  const last:any=await executeDiscordTool(f.client,{...task,args:{...task.args,cursor:next.nextCursor}},true);
  const hits=[...next.results,...last.results];assert.equal(hits.length,11);assert.equal(new Set(hits.map(r=>r.url)).size,11);
  assert.ok(hits.some(r=>r.content==='geometry beyond six'));assert.equal(last.nextCursor,undefined);
});
