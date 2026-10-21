import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChannelType,type Client} from 'discord.js';
import {AnnouncementStore} from '../src/announcements/store.js';
import {documentTemplates,type Extraction} from '../src/announcements/model.js';
import {plan} from '../src/announcements/planner.js';
import {alertActionable} from '../src/announcements/alerts.js';
import {deliverStaffAlerts} from '../src/announcements/delivery.js';
import {validatePolicy,type AutomationConfig} from '../src/announcements/config.js';

const guild='111111111111111111',staff='333333333333333333',now=Date.parse('2030-01-01T00:00:00Z');
const config:AutomationConfig={enabled:true,autoSend:false,database:':memory:',assets:'.cache/test',pollMs:30000,policy:{guild,channel:'222222222222222222',role:null,staffChannel:staff,policies:[],templates:documentTemplates},gmail:{account:'synthetic',query:'synthetic',senders:['organizer@example.invalid'],clientId:'',clientSecret:'',refreshToken:''},provider:{backend:'https://example.invalid',model:'synthetic',backendKey:'',nativeTools:false,vision:false}};
const staffRole='444444444444444444';
test('staff notification role must be explicit, valid and paired with a private destination',()=>{
  assert.doesNotThrow(()=>validatePolicy({...config.policy,staffRole}));
  for(const role of [guild,'@everyone','bad'])assert.throws(()=>validatePolicy({...config.policy,staffRole:role}));
  assert.throws(()=>validatePolicy({...config.policy,staffChannel:null,staffRole}));
});
test('staff alerts ping only the configured role, recheck changed routing, and retain failed preflights',async()=>{
  for(const mode of ['configured','none','changed','missing','unmentionable','public','disabled','uncertain'] as const){
    const store=new AnnouncementStore(':memory:');try{
      const runtime=structuredClone(config);if(mode!=='none')runtime.policy.staffRole=staffRole;
      store.alert(guild,'test-notice','synthetic');const sent:{content:string;allowedMentions:unknown}[]=[];
      const everyone={id:guild},bot={id:'bot'};
      const channel={type:ChannelType.GuildText,guildId:guild,guild:{roles:{everyone,fetch:async()=>{
        if(mode==='changed')runtime.policy.staffRole='555555555555555555';
        if(mode==='disabled')runtime.enabled=false;
        return mode==='missing'?null:{id:staffRole,mentionable:mode!=='unmentionable'};
      }},members:{fetchMe:async()=>bot}},permissionsFor:(member:unknown)=>({has:()=>member===everyone?mode==='public':mode!=='unmentionable'}),send:async(payload:{content:string;allowedMentions:unknown})=>{sent.push(payload);if(mode==='uncertain')throw new Error('ambiguous transport');return {id:'synthetic-message'};}};
      const run=()=>deliverStaffAlerts({channels:{fetch:async()=>channel}} as unknown as Client,store,runtime,()=>runtime);
      if(['missing','unmentionable','public'].includes(mode))await assert.rejects(run);else await run();
      const delivered=['configured','none','uncertain'].includes(mode);
      assert.equal(sent.length,delivered?1:0);
      assert.equal(store.db.prepare('SELECT state FROM staff_alerts').get()!.state,mode==='uncertain'?'uncertain':delivered?'sent':'pending');
      if(delivered){assert.equal(sent[0]!.content.startsWith(`<@&${staffRole}>`),mode!=='none');assert.deepEqual(sent[0]!.allowedMentions,{parse:[],roles:mode==='none'?[]:[staffRole],users:[],repliedUser:false});}
      if(mode==='uncertain'){await run();assert.equal(sent.length,1);}
    }finally{store.close();}
  }
});
function propose(store:AnnouncementStore,offset=0,count=1){
  const input:Extraction={source:{account:'synthetic',messageId:`synthetic-${offset}`,attachment:null,sha256:'a'.repeat(64),locator:'body'},catalog:{competitions:[],rounds:[],programs:[{id:'vtamps-v30-0',name:'VTAMPS',version:'30.0'}]},events:Array.from({length:count},(_,index)=>({event:{competitionId:null,roundId:null,programId:'vtamps-v30-0',preparesFor:[],yearLevel:'Senior Secondary',type:'training-session',slot:String(offset+index+1),start:now+3600000,end:now+7200000,deadline:null,timezone:'Asia/Manila',timezoneAssumed:false,url:null,detailLabel:null,temporal:{start:{precision:'exact',expression:'2030-01-01T01:00:00Z',sourceTime:null},end:{precision:'exact',expression:'2030-01-01T02:00:00Z',sourceTime:null}}},confidence:'high',issues:[],evidenceIds:['body']}))};
  store.saveEvidence(store.source(guild,input.source),{evidence:[{id:'body',text:'VTAMPS V.30.0 Senior Secondary public session timetable, January 1, 2030, 9 AM to 10 AM Asia/Manila.'}],blocked:[]});
  return store.ingest(guild,input,now);
}
test('pending review beyond newest100 still receives an actionable approaching-event alert',()=>{
  const store=new AnnouncementStore(':memory:');try{
    propose(store,0,100);propose(store,100,5);const oldest=store.resolveCandidate(guild,'1')!;
    assert.equal(store.candidates(guild).some(c=>c.id===oldest.id),false);plan(store,config.policy,now);
    assert.ok(store.db.prepare("SELECT id FROM staff_alerts WHERE kind='approaching-unapproved' AND target=?").get(oldest.id));
    const alert={id:'synthetic',kind:'approaching-unapproved',target:oldest.id};assert.equal(alertActionable(store,guild,alert,now),true);
    store.reject(guild,oldest.id,oldest.review_version,'synthetic-staff');assert.equal(alertActionable(store,guild,alert,now),false);
  }finally{store.close();}
});
test('resolution during staff channel fetch suppresses stale notice immediately before fake transport',async()=>{
  const store=new AnnouncementStore(':memory:');try{
    const batch=propose(store);let sends=0;const candidate=store.candidates(guild)[0]!;
    const everyone={id:guild},bot={id:'synthetic-bot'};
    const channel={type:ChannelType.GuildText,guildId:guild,guild:{roles:{everyone},members:{fetchMe:async()=>bot}},permissionsFor:(member:unknown)=>({has:()=>member!==everyone}),send:async()=>{sends++;return {id:'synthetic-message'};}};
    const client={channels:{fetch:async()=>{store.reject(guild,candidate.id,candidate.review_version,'synthetic-staff');return channel;}}} as unknown as Client;
    await deliverStaffAlerts(client,store,config,()=>config);assert.equal(sends,0);
    assert.equal(store.db.prepare("SELECT state FROM staff_alerts WHERE kind='factual-review' AND target=?").get(batch)!.state,'superseded');
  }finally{store.close();}
});
test('fresh disabled configuration blocks a pending staff alert after awaited channel refresh',async()=>{
  const store=new AnnouncementStore(':memory:');try{
    propose(store);let sends=0;const everyone={};const channel={type:ChannelType.GuildText,guildId:guild,guild:{roles:{everyone},members:{fetchMe:async()=>({})}},permissionsFor:(member:unknown)=>({has:()=>member!==everyone}),send:async()=>{sends++;return {id:'synthetic'};}};
    await deliverStaffAlerts({channels:{fetch:async()=>channel}} as unknown as Client,store,config,()=>({...config,enabled:false}));assert.equal(sends,0);
  }finally{store.close();}
});

test('operational provider and writer notices become obsolete when their actionable work is gone',()=>{
  const store=new AnnouncementStore(':memory:');try{
    propose(store);store.setState('provider:health','misconfigured');
    assert.equal(alertActionable(store,guild,{id:'synthetic',kind:'extraction-provider-misconfigured',target:'groq'},now),false);
    assert.equal(alertActionable(store,guild,{id:'synthetic',kind:'writing-unavailable',target:'writer'},now),false);
    const source=store.source(guild,{account:'synthetic',messageId:'synthetic-waiting',attachment:null,sha256:'b'.repeat(64),locator:'body'});
    assert.equal(alertActionable(store,guild,{id:'synthetic',kind:'extraction-provider-misconfigured',target:'groq'},now),true);
    store.resolveSource(guild,source,'ignore','Synthetic unsupported source.');assert.equal(alertActionable(store,guild,{id:'synthetic',kind:'extraction-provider-misconfigured',target:'groq'},now),false);
  }finally{store.close();}
});
