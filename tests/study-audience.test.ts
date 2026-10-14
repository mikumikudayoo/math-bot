import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChannelType,Collection,PermissionFlagsBits,type Client} from 'discord.js';
import {studyDeliveryPayload} from '../src/study-audience.js';
import type {Job} from '../src/service/types.js';

const gid='123456789012345678',uid='223456789012345678',bid='323456789012345678';
const privateId='423456789012345678',publicId='523456789012345678',otherId='623456789012345678';
const sentinel='PRIVATE_DELIVERY_SENTINEL';
const longAnswer=sentinel.repeat(100);
function provenance(...channels:string[]){return JSON.stringify({version:1,classification:'private-discord',discordSources:channels.map(channelId=>({guildId:gid,channelId})),audienceUnknown:false});}
function job(channels:string[]=[privateId],destination=privateId):Job{return {id:'delivery',guild:gid,channel:destination,user:uid,coach:false,kind:'ask',prompt:'summarize the messages',provenance:provenance(...channels),state:'completed',status:'complete',answer:longAnswer,artifact:Buffer.from('synthetic-image').toString('base64'),created:0,message:'723456789012345678',delivered:0};}
function fixture(){
  const calls:string[]=[];const channels=new Collection<string,any>();
  const requester:any={id:uid,guild:null,manage:false},bot:any={id:bid,guild:null,manage:true};
  const guild:any={id:gid,
    roles:{everyone:{id:gid},fetch:async()=>{calls.push('roles');}},
    members:{fetch:async(options:any)=>{assert.equal(options.user,uid);assert.equal(options.force,true);assert.equal(options.cache,false);calls.push('requester');return requester;},fetchMe:async(options:any)=>{assert.equal(options.force,true);assert.equal(options.cache,false);calls.push('bot');return bot;}},
    channels:{fetch:async(id:string,options:any)=>{assert.equal(options.force,true);calls.push('channel:'+id);return channels.get(id)??null;}},
  };
  requester.guild=bot.guild=guild;
  function channel(id:string,everyone=false,type=ChannelType.GuildText,parentId:string|null=null){
    const c:any={id,guildId:gid,guild,type,parentId,name:'synthetic-channel',readers:new Set([uid,bid]),joined:new Set([uid,bid]),permissionOverwrites:{cache:new Collection()},
      isTextBased:()=>true,isSendable:()=>true,isThread:()=>[ChannelType.PrivateThread,ChannelType.PublicThread,ChannelType.AnnouncementThread].includes(type),
      permissionsFor:(member:any)=>({has:(permissions:any)=>permissions===PermissionFlagsBits.ManageThreads?member.manage:member.id===gid?everyone:c.readers.has(member.id)}),
      members:{fetch:async({member,force,cache}:any)=>{assert.equal(force,true);assert.equal(cache,false);if(!c.joined.has(member))throw new Error('not a member');return {id:member};}},
    };channels.set(id,c);return c;
  }
  channel(privateId);channel(publicId,true);channel(otherId);
  const client={guilds:{fetch:async(options:any)=>{assert.deepEqual(options,{guild:gid,force:true});calls.push('guild');return guild;}}} as unknown as Client;
  return {client,calls,channels,channel,guild,requester,bot};
}
function assertRefusal(result:Awaited<ReturnType<typeof studyDeliveryPayload>>){
  assert.equal(result.files.length,0);assert.deepEqual(result.allowedMentions,{parse:[]});
  assert.deepEqual(result.attachments,[]);assert.deepEqual(result.embeds,[]);
  assert.ok(!JSON.stringify(result).includes(sentinel));
  for(const id of [gid,privateId,publicId,otherId])assert.ok(!result.content.includes(id));
  assert.match(result.content,/can't safely share/);
}

test('same private audience allows the full answer attachment and plot only after fresh checks',async()=>{
  const f=fixture(),j=job();const result=await studyDeliveryPayload(f.client,j,j.answer);
  assert.ok(result.content.includes(sentinel));assert.match(result.content,/full answer attached/);
  assert.deepEqual(result.files.map(file=>file.name),['answer.txt','plot.png']);
  assert.equal(Buffer.from(result.files[0]!.attachment as Buffer).toString(),longAnswer);
  assert.ok(f.calls.includes('roles')&&f.calls.includes('requester')&&f.calls.includes('bot'));
});
test('requester access to private source does not authorize a public destination',async()=>{
  const f=fixture(),j=job([privateId],publicId);assertRefusal(await studyDeliveryPayload(f.client,j,j.answer));
});
test('public source may be delivered to another public channel',async()=>{
  const f=fixture();f.channel(otherId,true);const j=job([publicId],otherId);
  const result=await studyDeliveryPayload(f.client,j,'public evidence');assert.equal(result.content,'public evidence');assert.equal(result.files.length,1);
});
test('multiple sources require every audience rather than just the first',async()=>{
  const f=fixture(),j=job([publicId,privateId],publicId);assertRefusal(await studyDeliveryPayload(f.client,j,'model says this is safe '+sentinel));
});
test('public plus same private source permits the narrower private destination',async()=>{
  const f=fixture(),j=job([publicId,privateId]);assert.equal((await studyDeliveryPayload(f.client,j,'authorized summary')).content,'authorized summary');
});
test('membership or channel permission revoked before final delivery prevents artifacts',async()=>{
  const f=fixture(),j=job();f.channels.get(privateId).readers.delete(uid);assertRefusal(await studyDeliveryPayload(f.client,j,j.answer));
});
test('denied retry explicitly removes attachments and embeds retained by an earlier successful edit',async()=>{
  const f=fixture(),j=job();const first=await studyDeliveryPayload(f.client,j,j.answer);
  assert.equal(first.files.length,2);
  f.channels.get(privateId).readers.delete(uid);
  const retry=await studyDeliveryPayload(f.client,j,j.answer);
  assertRefusal(retry);
  // files:[] alone would not remove previously uploaded files from a Discord edit.
  assert.ok(Object.hasOwn(retry,'attachments'));assert.ok(Object.hasOwn(retry,'embeds'));
  assert.deepEqual(retry.attachments,[]);assert.deepEqual(retry.embeds,[]);
});
test('private thread membership is refreshed before delivering into that thread',async()=>{
  const f=fixture();f.channel(privateId,false,ChannelType.PrivateThread,publicId);const j=job();
  assert.equal((await studyDeliveryPayload(f.client,j,'authorized thread answer')).content,'authorized thread answer');
  f.channels.get(privateId).joined.delete(uid);assertRefusal(await studyDeliveryPayload(f.client,j,j.answer));
});
test('unknown, missing and foreign provenance fail without leaking source metadata',async()=>{
  const f=fixture();
  for(const p of [provenance(),JSON.stringify({version:1,classification:'private-discord',discordSources:[{guildId:'823456789012345678',channelId:privateId}],audienceUnknown:false}),provenance('923456789012345678')]){
    const j={...job(),provenance:p};assertRefusal(await studyDeliveryPayload(f.client,j,j.answer));
  }
});
test('legacy Discord provenance receives the same final delivery protection',async()=>{
  const f=fixture(),j=job([privateId],publicId);delete j.provenance;j.retrievalContext=JSON.stringify({kind:'discord',refs:[{channelId:privateId}]});assertRefusal(await studyDeliveryPayload(f.client,j,j.answer));
});
test('permission fetch failures return a generic refusal without error payloads',async()=>{
  const f=fixture(),j=job();f.guild.roles.fetch=async()=>{throw new Error(sentinel);};assertRefusal(await studyDeliveryPayload(f.client,j,j.answer));
});
test('ordinary public delivery preserves existing content and attachment behavior without private lookups',async()=>{
  const f=fixture(),j=job();j.provenance=JSON.stringify({version:1,classification:'public',discordSources:[],audienceUnknown:false});
  const result=await studyDeliveryPayload(f.client,j,j.answer);assert.equal(result.files.length,2);assert.ok(result.content.includes(sentinel));assert.deepEqual(f.calls,[]);
});
test('nonterminal private status updates do not contain artifacts or require content-audience lookups',async()=>{
  const f=fixture(),j={...job(),state:'running' as const};const result=await studyDeliveryPayload(f.client,j,'thinking...');
  assert.equal(result.content,'thinking...');assert.equal(result.files.length,0);assert.deepEqual(f.calls,[]);
});
