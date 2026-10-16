import type { AutomationConfig } from './config.js';
import { AnnouncementStore } from './store.js';
import { digest,type Source } from './model.js';

export class GmailError extends Error {constructor(readonly status:number,readonly retryAt=Date.now()+30000){super(`Gmail HTTP ${status}.`);}}
export interface GmailPart { mimeType?:string;filename?:string;headers?:{name:string;value:string}[];body?:{data?:string;attachmentId?:string;size?:number};parts?:GmailPart[] }
export interface GmailMessage {id:string;threadId?:string;historyId?:string;payload?:GmailPart;internalDate?:string}
export class GmailClient {
  private token='';private expires=0;
  constructor(private readonly config:AutomationConfig['gmail'],private readonly request:typeof fetch=fetch){}
  private async access(signal:AbortSignal){
    if(this.token&&this.expires>Date.now()+60000)return this.token;
    if(!this.config.clientId||!this.config.clientSecret||!this.config.refreshToken)throw new GmailError(401);
    const r=await this.request('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.config.clientId,client_secret:this.config.clientSecret,refresh_token:this.config.refreshToken,grant_type:'refresh_token'})});
    if(!r.ok){await r.body?.cancel();throw new GmailError(r.status);}
    const data=await r.json() as {access_token?:string;expires_in?:number;scope?:string};
    const scopes=(data.scope??'').split(' ');if(!scopes.includes('https://www.googleapis.com/auth/gmail.readonly') || scopes.some(s=>s.startsWith('https://mail.google.com') || /gmail\.(?:modify|send|compose|insert)/.test(s)))throw new Error('Gmail token must have read-only mail access.');
    if(!data.access_token)throw new GmailError(401);this.token=data.access_token;this.expires=Date.now()+Math.min(data.expires_in??3600,3600)*1000;return this.token;
  }
  async get<T>(path:string,params:Record<string,string>,signal:AbortSignal):Promise<T>{
    const token=await this.access(signal);const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/'+path);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
    const r=await this.request(url,{signal,redirect:'error',headers:{Authorization:`Bearer ${token}`}});
    if(!r.ok){if(r.status===401)this.expires=0;const retry=Number(r.headers.get('retry-after')??30);await r.body?.cancel();throw new GmailError(r.status,Date.now()+Math.max(1000,Math.min(Number.isFinite(retry)?retry*1000:30000,3600000)));}
    const raw=await boundedResponse(r,8_000_000);return JSON.parse(raw) as T;
  }
}
export async function boundedResponse(r:Response,max:number){const reader=r.body?.getReader();if(!reader)throw new Error('Empty response.');const chunks:Uint8Array[]=[];let bytes=0;try{for(;;){const v=await reader.read();if(v.done)break;bytes+=v.value.length;if(bytes>max)throw new Error('Response too large.');chunks.push(v.value);}return Buffer.concat(chunks).toString('utf8');}finally{await reader.cancel();}}
export function organizer(message:GmailMessage,senders:string[]){
  const header=message.payload?.headers?.find(h=>h.name.toLowerCase()==='from')?.value??'';
  const email=(header.match(/<([^<>]+)>/)?.[1]??header).trim().toLowerCase();return senders.includes(email);
}
export async function bootstrapGmail(store:AnnouncementStore,client:Pick<GmailClient,'get'>,config:AutomationConfig,signal:AbortSignal){
  const prefix=`gmail:${config.gmail.account}`;
  if(store.state(`${prefix}:cursor`))throw new Error('Gmail is already bootstrapped.');
  if(Number(store.db.prepare('SELECT COUNT(*) n FROM sources').get()!.n)!==0)throw new Error('Future-only bootstrap requires an empty source database.');
  const profile=await client.get<{emailAddress?:string;historyId:string}>('profile',{},signal);
  if(config.gmail.account.includes('@')&&profile.emailAddress?.toLowerCase()!==config.gmail.account.toLowerCase())throw new GmailError(401);
  if(!/^\d+$/.test(profile.historyId))throw new Error('Gmail profile has no valid history cursor.');
  store.transaction(()=>{
    if(store.state(`${prefix}:cursor`)||Number(store.db.prepare('SELECT COUNT(*) n FROM sources').get()!.n)!==0)throw new Error('Future-only bootstrap was already completed or source admission began.');
    store.setState(`${prefix}:cursor`,profile.historyId);store.setState(`${prefix}:bootstrap-history-id`,profile.historyId);
    store.setState(`${prefix}:bootstrap-at`,String(Date.now()));store.setState(`${prefix}:bootstrap-mode`,'future-only');store.setState(`${prefix}:health`,'healthy');
    store.audit(config.policy.guild,'automation','gmail-future-only-bootstrap',config.gmail.account,{historyId:profile.historyId,imported:0});
  });
  return profile.historyId;
}
const syncLimits={pagesPerTick:5,messagesPerTick:100,stagedIds:5000,totalPages:10000,stateBytes:4_000_000};
interface GmailSyncProgress {
  version:1;cursor:string;nextCursor:string;policyHash:string;phase:'history'|'query'|'admission';
  historyPage:string|null;queryPage:string|null;arrivals:string[];allowed:string[];admissionOffset:number;pages:number;
}
class GmailSyncConflict extends Error {}
const mailId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,256}$/u.test(value);
const cursorValue=(value:unknown):value is string=>typeof value==='string'&&/^\d{1,256}$/u.test(value);
const pageToken=(value:unknown):value is string|null=>value===null||typeof value==='string'&&value.length>0&&value.length<=4096;
function validSyncProgress(value:unknown):value is GmailSyncProgress {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const p=value as GmailSyncProgress,keys=['version','cursor','nextCursor','policyHash','phase','historyPage','queryPage','arrivals','allowed','admissionOffset','pages'];
  if(Object.keys(p).length!==keys.length||Object.keys(p).some(key=>!keys.includes(key))||p.version!==1||!cursorValue(p.cursor)||!cursorValue(p.nextCursor)||!(/^[a-f0-9]{64}$/u.test(p.policyHash))||!['history','query','admission'].includes(p.phase)||!pageToken(p.historyPage)||!pageToken(p.queryPage))return false;
  if(![p.arrivals,p.allowed].every(ids=>Array.isArray(ids)&&ids.length<=syncLimits.stagedIds&&ids.every(mailId)&&new Set(ids).size===ids.length))return false;
  const arrivals=new Set(p.arrivals);
  if(p.allowed.some(id=>!arrivals.has(id))||!Number.isSafeInteger(p.admissionOffset)||p.admissionOffset<0||p.admissionOffset>p.allowed.length||!Number.isSafeInteger(p.pages)||p.pages<0||p.pages>syncLimits.totalPages)return false;
  return p.phase==='history'?p.queryPage===null&&p.allowed.length===0&&p.admissionOffset===0:p.historyPage===null&&(p.phase==='query'?p.admissionOffset===0:p.queryPage===null);
}
export async function syncGmail(store:AnnouncementStore,client:Pick<GmailClient,'get'>,config:AutomationConfig,signal:AbortSignal){
  const account=config.gmail.account,prefix=`gmail:${account}`,cursorKey=`${prefix}:cursor`,progressKey=`${prefix}:sync-progress`,holdKey=`${prefix}:pagination-hold`;const cursor=store.state(cursorKey);
  if(!cursor){await bootstrapGmail(store,client,config,signal);return 0;}
  if(store.state(`${prefix}:history-gap`)){store.setState(`${prefix}:health`,'history-gap');return 0;}
  if(store.state(holdKey)){store.setState(`${prefix}:health`,'pagination-hold');return 0;}
  const profile=account.includes('@')?await client.get<{emailAddress?:string;historyId:string}>('profile',{},signal):undefined;
  if(profile&&profile.emailAddress?.toLowerCase()!==account.toLowerCase())throw new GmailError(401);
  const policyHash=digest([config.policy.guild,config.gmail.query,[...config.gmail.senders].sort()]);
  let saved=store.state(progressKey)??'',progress:GmailSyncProgress;
  const checkCurrent=()=>{if(store.state(cursorKey)!==cursor||(store.state(progressKey)??'')!==saved)throw new GmailSyncConflict();};
  const pause=(reason:string)=>{store.transaction(()=>{checkCurrent();store.setState(holdKey,JSON.stringify({reason,observedAt:Date.now()}));store.setState(`${prefix}:health`,'pagination-hold');store.alert(config.policy.guild,'gmail-pagination-review',account);store.audit(config.policy.guild,'automation','gmail-pagination-review',account,{reason});});return 0;};
  const save=(next:GmailSyncProgress,admit?:()=>void)=>{
    const serialized=JSON.stringify(next);if(Buffer.byteLength(serialized)>syncLimits.stateBytes)throw new Error('Gmail pagination state exceeds its safe bound.');
    store.transaction(()=>{checkCurrent();admit?.();store.setState(progressKey,serialized);store.setState(`${prefix}:health`,'pagination-pending');});
    saved=serialized;progress=next;
  };
  try{
    if(saved){
      let parsed:unknown;try{if(Buffer.byteLength(saved)>syncLimits.stateBytes)return pause('Stored Gmail pagination progress exceeds the safe bound.');parsed=JSON.parse(saved);}catch{return pause('Stored Gmail pagination progress is invalid; retain the history cursor.');}
      if(!validSyncProgress(parsed)||parsed.cursor!==cursor)return pause('Stored Gmail pagination progress does not match the durable history cursor.');
      if(parsed.policyHash!==policyHash)return pause('Gmail admission policy changed during pagination; review the staged arrivals before resuming.');
      progress=parsed;
    }else save({version:1,cursor,nextCursor:cursor,policyHash,phase:'history',historyPage:null,queryPage:null,arrivals:[],allowed:[],admissionOffset:0,pages:0});
    let pages=0;
    while(progress!.phase!=='admission'&&pages<syncLimits.pagesPerTick){
      if(progress!.pages>=syncLimits.totalPages)return pause('Gmail pagination exceeded the bounded page budget; retain all staged arrivals for review.');
      if(progress!.phase==='history'){
        let data:{history?:{messagesAdded?:{message:{id:string}}[]}[];historyId:string;nextPageToken?:string};
        try{data=await client.get('history',{startHistoryId:cursor,historyTypes:'messageAdded',maxResults:'100',...(progress!.historyPage?{pageToken:progress!.historyPage}:{})},signal);}
        catch(error){if(!(error instanceof GmailError&&error.status===404))throw error;
          // A gap never becomes a search/backfill or a replacement bootstrap cursor.
          store.transaction(()=>{checkCurrent();store.setState(`${prefix}:history-gap`,JSON.stringify({cursor,observedAt:Date.now()}));store.setState(`${prefix}:health`,'history-gap');store.alert(config.policy.guild,'gmail-history-gap',cursor);store.audit(config.policy.guild,'automation','gmail-history-gap',account,{cursor});});return 0;
        }
        if(!data||!cursorValue(data.historyId)||!Array.isArray(data.history??[])||(data.history??[]).length>100||!pageToken(data.nextPageToken??null))return pause('Gmail history returned an invalid or oversized page.');
        if(BigInt(data.historyId)<BigInt(progress!.nextCursor))return pause('Gmail history cursor moved backwards; retain the durable boundary.');
        const arrivals=new Set(progress!.arrivals);let added=0;
        for(const row of data.history??[]){
          if(!row||!Array.isArray(row.messagesAdded??[])||(row.messagesAdded??[]).length>syncLimits.stagedIds)return pause('Gmail history additions exceeded the bounded staging capacity.');
          for(const item of row.messagesAdded??[]){if(!mailId(item?.message?.id))return pause('Gmail history returned an invalid message identity.');arrivals.add(item.message.id);if(++added>syncLimits.stagedIds||arrivals.size>syncLimits.stagedIds)return pause('Gmail history additions exceeded the bounded staging capacity.');}
        }
        const next=data.nextPageToken??null;if(next!==null&&next===progress!.historyPage)return pause('Gmail history pagination did not advance; retain the staged arrivals.');
        save({...progress!,nextCursor:data.historyId,historyPage:next,arrivals:[...arrivals],phase:next?'history':arrivals.size?'query':'admission',pages:progress!.pages+1});
      }else{
        const data=await client.get<{messages?:{id:string}[];nextPageToken?:string}>('messages',{q:config.gmail.query,maxResults:'100',...(progress!.queryPage?{pageToken:progress!.queryPage}:{})},signal);
        if(!data||!Array.isArray(data.messages??[])||(data.messages??[]).length>100||!pageToken(data.nextPageToken??null))return pause('Gmail restricted query returned an invalid or oversized page.');
        const arrivals=new Set(progress!.arrivals),allowed=new Set(progress!.allowed);
        // Search results can qualify a history-admitted ID, but cannot admit an ID.
        for(const message of data.messages??[]){if(!mailId(message?.id))return pause('Gmail restricted query returned an invalid message identity.');if(arrivals.has(message.id))allowed.add(message.id);}
        const next=data.nextPageToken??null;if(next!==null&&next===progress!.queryPage)return pause('Gmail restricted-query pagination did not advance; retain the staged arrivals.');
        save({...progress!,queryPage:next,allowed:[...allowed],phase:next?'query':'admission',pages:progress!.pages+1});
      }
      pages++;
    }
    if(progress!.phase!=='admission')return progress!.arrivals.length;
    for(let messages=0;progress!.admissionOffset<progress!.allowed.length&&messages<syncLimits.messagesPerTick;messages++){
      const id=progress!.allowed[progress!.admissionOffset]!,sourceId=digest([account,id]);
      const existing=store.db.prepare('SELECT id,guild FROM sources WHERE id=?').get(sourceId);
      if(existing){if(existing.guild!==config.policy.guild)return pause('A staged Gmail source belongs to a different guild; factual review is required.');save({...progress!,admissionOffset:progress!.admissionOffset+1});continue;}
      const message=await client.get<GmailMessage>(`messages/${encodeURIComponent(id)}`,{format:'full'},signal);
      if(message.id!==id)return pause('Gmail returned a different message identity; retain the staged arrival.');
      const source:Source={account,messageId:id,attachment:null,sha256:digest(message.payload??{}),locator:'organizer email; local redacted text/table evidence pending'};
      // Source admission and offset advancement are one durable transaction. The
      // store's admission barrier therefore precedes any cursor advancement.
      save({...progress!,admissionOffset:progress!.admissionOffset+1},organizer(message,config.gmail.senders)?()=>{store.source(config.policy.guild,source);}:undefined);
    }
    if(progress!.admissionOffset<progress!.allowed.length)return progress!.arrivals.length;
    // Freeze the history response cursor before query/admission work. Arrivals
    // during those later phases are still after this cursor on the next cycle.
    store.transaction(()=>{checkCurrent();store.setState(cursorKey,progress!.nextCursor);store.setState(progressKey,'');store.setState(`${prefix}:health`,'healthy');});
    return progress!.arrivals.length;
  }catch(error){if(error instanceof GmailSyncConflict)return 0;throw error;}
}
