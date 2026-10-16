import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnnouncementStore } from '../src/announcements/store.js';
import { syncGmail,bootstrapGmail,GmailError,type GmailClient,type GmailMessage } from '../src/announcements/gmail.js';
import { documentTemplates } from '../src/announcements/model.js';
import type { AutomationConfig } from '../src/announcements/config.js';
import { removeAnnouncementTestDirectory } from './announcement-test-cleanup.js';

const guild='111111111111111111',account='synthetic-pagination',prefix=`gmail:${account}`;
const config:AutomationConfig={enabled:true,autoSend:false,database:':memory:',assets:'/tmp/synthetic-pagination-assets',policy:{guild,channel:'222222222222222222',role:null,staffChannel:null,policies:[],templates:documentTemplates},gmail:{account,query:'subject:VTAMPS from:organizer@example.org',senders:['organizer@example.org'],clientId:'',clientSecret:'',refreshToken:''},provider:{backend:'https://synthetic-provider.example.org/v1',model:'synthetic',backendKey:'',nativeTools:false,vision:false},pollMs:120000};
type Request={path:string;params:Record<string,string>};
function fakeClient(handler:(request:Request)=>unknown|Promise<unknown>):Pick<GmailClient,'get'>{return {get:async<T>(path:string,params:Record<string,string>)=>await handler({path,params}) as T};}
function seeded(path=':memory:'){
  const store=new AnnouncementStore(path);store.setState(`${prefix}:cursor`,'100');store.setState(`${prefix}:bootstrap-history-id`,'100');store.setState(`${prefix}:bootstrap-mode`,'future-only');return store;
}
const tick=(store:AnnouncementStore,client:Pick<GmailClient,'get'>,cfg=config)=>syncGmail(store,client,cfg,AbortSignal.timeout(5000));
const sources=(store:AnnouncementStore)=>store.db.prepare('SELECT message_id FROM sources ORDER BY message_id').all().map(row=>String(row.message_id));

test('a delayed concurrent bootstrap cannot overwrite a saved future-only boundary',async()=>{
  const store=new AnnouncementStore(':memory:');try{
    let release!:(value:unknown)=>void;const delayed=new Promise(resolve=>{release=resolve;});
    const second=bootstrapGmail(store,fakeClient(()=>delayed),config,AbortSignal.timeout(5000));
    await bootstrapGmail(store,fakeClient(()=>({historyId:'100'})),config,AbortSignal.timeout(5000));
    store.setState(`${prefix}:cursor`,'200');release({historyId:'300'});
    await assert.rejects(second,/already completed/);assert.equal(store.state(`${prefix}:cursor`),'200');assert.equal(store.state(`${prefix}:bootstrap-history-id`),'100');assert.deepEqual(sources(store),[]);
  }finally{store.close();}
});
const progress=(store:AnnouncementStore)=>JSON.parse(store.state(`${prefix}:sync-progress`)!) as {phase:string;historyPage:string|null;queryPage:string|null;arrivals:string[];allowed:string[];admissionOffset:number;nextCursor:string};
function message(id:string,sender='organizer@example.org'):GmailMessage{return {id,payload:{mimeType:'text/plain',headers:[{name:'From',value:sender}],body:{data:Buffer.from('VTAMPS V.30.0 synthetic public timetable.').toString('base64url')}}};}
function history(ids:string[],nextPageToken?:string,historyId='200'){return {historyId,history:[{messagesAdded:ids.map(id=>({message:{id}}))}],...(nextPageToken?{nextPageToken}:{})};}

test('history beyond five pages resumes after restart and search-only historical matches never become sources',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'announcement-history-pages-')),path=join(dir,'synthetic.sqlite');let store=seeded(path);
  const requests:Request[]=[];
  const client=fakeClient(request=>{
    requests.push(request);
    if(request.path==='history'){
      assert.equal(request.params.startHistoryId,'100');assert.equal(request.params.historyTypes,'messageAdded');
      const page=Number(request.params.pageToken?.slice(1)??0);
      return history(page===6?['future-final','future-duplicate']:['future-duplicate'],page<6?`h${page+1}`:undefined);
    }
    if(request.path==='messages')return {messages:[{id:'historical-search-only'},{id:'future-final'}]};
    assert.equal(request.path,'messages/future-final');return message('future-final');
  });
  try{
    await tick(store,client);assert.equal(requests.length,5);assert.deepEqual(sources(store),[]);assert.equal(store.state(`${prefix}:cursor`),'100');
    assert.equal(progress(store).historyPage,'h5');assert.deepEqual(progress(store).arrivals,['future-duplicate']);
    store.close();store=new AnnouncementStore(path);requests.length=0;
    await tick(store,client);assert.equal(requests.filter(r=>r.path==='history').length,2);assert.equal(requests[0]!.params.pageToken,'h5');
    assert.deepEqual(sources(store),['future-final']);assert.equal(store.state(`${prefix}:cursor`),'200');assert.equal(store.state(`${prefix}:bootstrap-history-id`),'100');assert.equal(store.state(`${prefix}:sync-progress`),'');
  }finally{store.close();removeAnnouncementTestDirectory(dir);}
});

test('restricted-query pagination resumes durably and intersects only the retained post-bootstrap arrivals',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'announcement-query-pages-')),path=join(dir,'synthetic.sqlite');let store=seeded(path);
  const requests:Request[]=[];
  const client=fakeClient(request=>{
    requests.push(request);
    if(request.path==='history')return history(['future-target']);
    if(request.path==='messages'){
      assert.equal(request.params.q,config.gmail.query);const page=Number(request.params.pageToken?.slice(1)??0);
      return {messages:[{id:page===6?'future-target':`historical-${page}`}],...(page<6?{nextPageToken:`q${page+1}`}:{})};
    }
    assert.equal(request.path,'messages/future-target');return message('future-target');
  });
  try{
    await tick(store,client);assert.equal(requests.length,5);assert.equal(progress(store).phase,'query');assert.equal(progress(store).queryPage,'q4');
    assert.deepEqual(progress(store).allowed,[]);assert.equal(store.state(`${prefix}:cursor`),'100');assert.doesNotMatch(store.state(`${prefix}:sync-progress`)!,/historical-/u);
    store.close();store=new AnnouncementStore(path);requests.length=0;
    await tick(store,client);assert.equal(requests[0]!.path,'messages');assert.equal(requests[0]!.params.pageToken,'q4');assert.equal(requests.filter(r=>r.path==='messages').length,3);
    assert.deepEqual(sources(store),['future-target']);assert.equal(store.state(`${prefix}:cursor`),'200');
  }finally{store.close();removeAnnouncementTestDirectory(dir);}
});

test('transient history and query failures retry their uncommitted page without replaying successful pages',async()=>{
  const store=seeded(),requests:string[]=[];let historyFailed=false,queryFailed=false;
  const client=fakeClient(({path,params})=>{
    requests.push(`${path}:${params.pageToken??'first'}`);
    if(path==='history'){
      if(!params.pageToken)return history(['future-target'],'h1');
      if(!historyFailed){historyFailed=true;throw new GmailError(503);}
      assert.equal(params.pageToken,'h1');return history(['future-target']);
    }
    if(path==='messages'){
      if(!params.pageToken)return {messages:[{id:'historical-search-only'}],nextPageToken:'q1'};
      if(!queryFailed){queryFailed=true;throw new GmailError(503);}
      assert.equal(params.pageToken,'q1');return {messages:[{id:'future-target'}]};
    }
    return message('future-target');
  });
  try{
    await assert.rejects(()=>tick(store,client),GmailError);assert.equal(progress(store).historyPage,'h1');assert.equal(store.state(`${prefix}:cursor`),'100');
    await assert.rejects(()=>tick(store,client),GmailError);assert.equal(progress(store).queryPage,'q1');assert.equal(store.state(`${prefix}:cursor`),'100');
    await tick(store,client);assert.deepEqual(sources(store),['future-target']);assert.equal(store.state(`${prefix}:cursor`),'200');
    assert.deepEqual(requests,['history:first','history:h1','history:h1','messages:first','messages:q1','messages:q1','messages/future-target:first']);
  }finally{store.close();}
});

test('message admission is bounded across ticks and the cursor waits until every admitted source is durable',async()=>{
  const store=seeded(),ids=Array.from({length:150},(_,i)=>`future-${String(i).padStart(3,'0')}`),requests:Request[]=[];
  const client=fakeClient(request=>{
    requests.push(request);
    if(request.path==='history')return history(ids);
    if(request.path==='messages')return request.params.pageToken?{messages:ids.slice(100).map(id=>({id}))}:{messages:ids.slice(0,100).map(id=>({id})),nextPageToken:'q1'};
    return message(request.path.slice('messages/'.length));
  });
  try{
    await tick(store,client);assert.equal(sources(store).length,100);assert.equal(progress(store).phase,'admission');assert.equal(progress(store).admissionOffset,100);assert.equal(store.state(`${prefix}:cursor`),'100');
    requests.length=0;await tick(store,client);assert.equal(requests.length,50);assert.ok(requests.every(r=>r.path.startsWith('messages/')));assert.deepEqual(sources(store),ids);assert.equal(store.state(`${prefix}:cursor`),'200');
  }finally{store.close();}
});

test('failed admission rolls back its offset and retries without duplicating an earlier durable source',async()=>{
  const store=seeded(),reads:string[]=[];let fail=true;const original=store.source.bind(store);
  store.source=(server,source)=>{if(source.messageId==='future-second'&&fail){fail=false;throw new Error('synthetic persistence failure');}return original(server,source);};
  const client=fakeClient(({path})=>{
    if(path==='history')return history(['future-first','future-second']);
    if(path==='messages')return {messages:[{id:'future-first'},{id:'future-second'}]};
    const id=path.slice('messages/'.length);reads.push(id);return message(id);
  });
  try{
    await assert.rejects(()=>tick(store,client),/synthetic persistence failure/u);assert.deepEqual(sources(store),['future-first']);assert.equal(progress(store).admissionOffset,1);assert.equal(store.state(`${prefix}:cursor`),'100');
    await tick(store,client);assert.deepEqual(sources(store),['future-first','future-second']);assert.deepEqual(reads,['future-first','future-second','future-second']);assert.equal(store.state(`${prefix}:cursor`),'200');
  }finally{store.close();}
});

test('arrivals while a query is paginating remain after the frozen history cursor for the next cycle',async()=>{
  const store=seeded(),starts:string[]=[];let firstCycle=true;
  const client=fakeClient(({path,params})=>{
    if(path==='history'){
      starts.push(params.startHistoryId!);
      return params.startHistoryId==='100'?history(['future-initial']):history(['future-delayed'],undefined,'300');
    }
    if(path==='messages'){
      if(!firstCycle)return {messages:[{id:'future-delayed'}]};
      const page=Number(params.pageToken?.slice(1)??0);
      return {messages:[{id:page===6?'future-initial':`historical-${page}`}],...(page<6?{nextPageToken:`q${page+1}`}:{})};
    }
    return message(path.slice('messages/'.length));
  });
  try{
    await tick(store,client);assert.equal(progress(store).nextCursor,'200');assert.equal(store.state(`${prefix}:cursor`),'100');
    await tick(store,client);assert.deepEqual(sources(store),['future-initial']);assert.equal(store.state(`${prefix}:cursor`),'200');
    firstCycle=false;await tick(store,client);assert.deepEqual(starts,['100','200']);assert.deepEqual(sources(store),['future-delayed','future-initial']);assert.equal(store.state(`${prefix}:cursor`),'300');
  }finally{store.close();}
});

test('a stale concurrent sync cannot overwrite completed progress or rewind the cursor',async()=>{
  const store=seeded();let release!:(value:unknown)=>void,first=true;
  const delayed=new Promise(resolve=>{release=resolve;});
  const client=fakeClient(({path})=>{
    if(path==='history'){if(first){first=false;return delayed;}return history(['future-target']);}
    if(path==='messages')return {messages:[{id:'future-target'}]};
    return message('future-target');
  });
  try{
    const slow=tick(store,client);await tick(store,client);assert.equal(store.state(`${prefix}:cursor`),'200');
    release(history(['future-target']));assert.equal(await slow,0);assert.deepEqual(sources(store),['future-target']);assert.equal(store.state(`${prefix}:cursor`),'200');assert.equal(store.state(`${prefix}:sync-progress`),'');
  }finally{release?.(history([]));store.close();}
});

test('expired history during resumed pagination pauses once without query fallback or cursor replacement',async()=>{
  const store=seeded();let expired=false,calls=0;
  const client=fakeClient(({path,params})=>{
    calls++;assert.equal(path,'history');if(expired)throw new GmailError(404);
    const page=Number(params.pageToken?.slice(1)??0);return history(['future-staged'],`h${page+1}`);
  });
  try{
    await tick(store,client);assert.equal(calls,5);expired=true;await tick(store,client);await tick(store,client);
    assert.equal(calls,6);assert.equal(store.state(`${prefix}:cursor`),'100');assert.equal(store.state(`${prefix}:bootstrap-history-id`),'100');assert.equal(store.state(`${prefix}:health`),'history-gap');assert.deepEqual(sources(store),[]);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM staff_alerts WHERE kind='gmail-history-gap'").get()!.n,1);assert.deepEqual(progress(store).arrivals,['future-staged']);
  }finally{store.close();}
});

test('oversized staging pauses explicitly and never advances or silently discards its continuation',async()=>{
  const store=seeded();let calls=0;
  const client=fakeClient(({path})=>{calls++;assert.equal(path,'history');return history(Array.from({length:5001},(_,i)=>`future-${i}`),'h1');});
  try{
    await tick(store,client);await tick(store,client);assert.equal(calls,1);assert.equal(store.state(`${prefix}:cursor`),'100');assert.equal(store.state(`${prefix}:health`),'pagination-hold');assert.ok(store.state(`${prefix}:pagination-hold`));assert.deepEqual(sources(store),[]);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM staff_alerts WHERE kind='gmail-pagination-review'").get()!.n,1);
  }finally{store.close();}
});

test('corrupt progress or admission-policy drift pauses without replacing the future-only boundary',async()=>{
  for(const scenario of ['corrupt','policy-change'] as const){
    const store=seeded();let calls=0;
    const client=fakeClient(({path,params})=>{calls++;assert.equal(path,'history');const page=Number(params.pageToken?.slice(1)??0);return history(['future-staged'],`h${page+1}`);});
    try{
      if(scenario==='corrupt')store.setState(`${prefix}:sync-progress`,'{invalid');else await tick(store,client);
      const before=calls;await tick(store,client,scenario==='policy-change'?{...config,gmail:{...config.gmail,query:'subject:changed'}}:config);
      assert.equal(calls,before);assert.equal(store.state(`${prefix}:health`),'pagination-hold');assert.equal(store.state(`${prefix}:cursor`),'100');assert.equal(store.state(`${prefix}:bootstrap-history-id`),'100');assert.deepEqual(sources(store),[]);
    }finally{store.close();}
  }
});

test('query matches still require the configured organizer sender before source admission',async()=>{
  const store=seeded(),reads:string[]=[];
  const client=fakeClient(({path})=>{
    if(path==='history')return history(['future-wrong-sender','future-organizer']);
    if(path==='messages')return {messages:[{id:'future-wrong-sender'},{id:'future-organizer'},{id:'historical-search-only'}]};
    const id=path.slice('messages/'.length);reads.push(id);return message(id,id==='future-organizer'?'organizer@example.org':'other@example.org');
  });
  try{await tick(store,client);assert.deepEqual(reads,['future-wrong-sender','future-organizer']);assert.deepEqual(sources(store),['future-organizer']);assert.equal(store.state(`${prefix}:cursor`),'200');}finally{store.close();}
});
