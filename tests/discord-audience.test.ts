import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionsBitField, PermissionFlagsBits, type GuildBasedChannel } from 'discord.js';
import { publicSource } from '../src/discord-audience.js';
import { canDisclose } from '../src/discord-tools.js';

function fixture(){
  const gid='123456789012345678',everyone={id:gid};
  const channels=new Map<string,any>();
  const fetches:{id:string;force:boolean}[]=[];
  const guild:any={id:gid,roles:{everyone},channels:{fetch:async(id:string,options:{force:boolean})=>{
    fetches.push({id,force:options.force});return channels.get(id)??null;
  }}};
  const requester:any={id:'requester',guild,manage:false};
  const bot:any={id:'bot',guild,manage:true};
  function channel(id:string,isPublic=true,type:ChannelType=ChannelType.GuildText,parentId:string|null=null){
    const c:any={id,guildId:gid,guild,type,parentId,isPublic,requesterAccess:true,botAccess:true,joined:false,
      isThread:()=>[ChannelType.PublicThread,ChannelType.AnnouncementThread,ChannelType.PrivateThread].includes(type),
      permissionsFor:(principal:{id:string;manage?:boolean})=>({has:(bits:any)=>bits===PermissionFlagsBits.ManageThreads?Boolean(principal.manage):principal.id===gid?c.isPublic:principal.id==='bot'?c.botAccess:c.requesterAccess}),
      members:{fetch:async({member}:any)=>{if(member==='bot'||c.joined)return {id:member};throw new Error('not a thread member');}},
      permissionOverwrites:{cache:new Collection<string,{deny:PermissionsBitField}>()}};
    if(c.isThread())delete c.permissionOverwrites;
    channels.set(id,c);return c as GuildBasedChannel;
  }
  return {guild,channels,channel,fetches,requester,bot};
}

test('only everyone-readable sources qualify for cross-channel publication',async()=>{
  const f=fixture();
  assert.equal(await publicSource(f.channel('public')),true);
  const privateSource=f.channel('private',false);
  assert.equal(privateSource.permissionsFor({id:'requester'} as any)!.has(PermissionFlagsBits.ViewChannel),true);
  assert.equal(await publicSource(privateSource),false);
});

test('role/member read denies prevent an everyone-allow from proving a public audience',async()=>{
  for(const denied of [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]){
    const f=fixture();const source=f.channel('source');
    (source as any).permissionOverwrites.cache.set('restricted',{deny:new PermissionsBitField(denied)});
    assert.equal(await publicSource(source),false);
  }
  const f=fixture();const source=f.channel('source');
  (source as any).permissionOverwrites.cache.set('posting-only',{deny:new PermissionsBitField(PermissionFlagsBits.SendMessages)});
  assert.equal(await publicSource(source),true);
});

test('public threads require freshly fetched publicly readable parents',async()=>{
  for(const type of [ChannelType.PublicThread,ChannelType.AnnouncementThread]){
    const f=fixture();f.channel('parent');const thread=f.channel('thread',true,type,'parent');
    assert.equal(await publicSource(thread),true);
    assert.deepEqual(f.fetches,[{id:'parent',force:true}]);
    f.channels.get('parent').isPublic=false;
    assert.equal(await publicSource(thread),false);
  }
});

test('private-thread membership does not make its audience public',async()=>{
  const f=fixture();f.channel('parent');
  assert.equal(await publicSource(f.channel('thread',true,ChannelType.PrivateThread,'parent')),false);
  assert.deepEqual(f.fetches,[]);
});

test('parent-specific read denies, missing parents and unavailable permissions fail closed',async()=>{
  const f=fixture();const parent=f.channel('parent');const thread=f.channel('thread',true,ChannelType.PublicThread,'parent');
  (parent as any).permissionOverwrites.cache.set('excluded-user',{deny:new PermissionsBitField(PermissionFlagsBits.ViewChannel)});
  assert.equal(await publicSource(thread),false);
  f.channels.delete('parent');assert.equal(await publicSource(thread),false);
  f.guild.channels.fetch=async()=>{throw new Error('permission lookup unavailable');};
  assert.equal(await publicSource(thread),false);
  const incomplete=f.channel('incomplete');delete (incomplete as any).permissionOverwrites;
  assert.equal(await publicSource(incomplete),false);
  (incomplete as any).permissionsFor=()=>null;assert.equal(await publicSource(incomplete),false);
});

test('foreign guild metadata and private thread parents fail closed',async()=>{
  const f=fixture();const foreign=f.channel('foreign');(foreign as any).guildId='another-guild';
  assert.equal(await publicSource(foreign),false);
  f.channel('parent',true,ChannelType.PrivateThread,'unused');
  assert.equal(await publicSource(f.channel('thread',true,ChannelType.PublicThread,'parent')),false);
});

test('each source must qualify; one restricted source makes a mixed audience unsafe',async()=>{
  const f=fixture();const sources=[f.channel('one'),f.channel('two',false)];
  assert.equal((await Promise.all(sources.map(publicSource))).every(Boolean),false);
  assert.equal((await Promise.all([sources[0]!].map(publicSource))).every(Boolean),true);
});

test('same authorized private channel is an allowed response audience',async()=>{
  const f=fixture();const source=f.channel('private',false);
  assert.equal(await canDisclose(source,source,f.requester,f.bot),true);
  (source as any).requesterAccess=false;
  assert.equal(await canDisclose(source,source,f.requester,f.bot),false);
});

test('requester read permission does not authorize private-to-public republication',async()=>{
  const f=fixture();const source=f.channel('private',false),destination=f.channel('public');
  assert.equal(await canDisclose(source,destination,f.requester,f.bot),false);
  assert.equal(await canDisclose(destination,f.channel('other-public'),f.requester,f.bot),true);
});

test('each source constrains delivery even when another source permits the destination',async()=>{
  const f=fixture();const destination=f.channel('destination');
  const sources=[f.channel('public'),f.channel('restricted',false)];
  assert.deepEqual(await Promise.all(sources.map(source=>canDisclose(source,destination,f.requester,f.bot))),[true,false]);
});

test('private-thread members may respond in that thread but not its broader parent',async()=>{
  const f=fixture();const parent=f.channel('parent');const thread=f.channel('private-thread',true,ChannelType.PrivateThread,'parent');
  (thread as any).joined=true;
  assert.equal(await canDisclose(thread,thread,f.requester,f.bot),true);
  assert.equal(await canDisclose(thread,parent,f.requester,f.bot),false);
  (thread as any).joined=false;
  assert.equal(await canDisclose(thread,thread,f.requester,f.bot),false);
});

test('destination and bot access remain required even for public source data',async()=>{
  const f=fixture();const source=f.channel('source'),destination=f.channel('destination');
  (destination as any).requesterAccess=false;
  assert.equal(await canDisclose(source,destination,f.requester,f.bot),false);
  (destination as any).requesterAccess=true;(source as any).botAccess=false;
  assert.equal(await canDisclose(source,destination,f.requester,f.bot),false);
});
