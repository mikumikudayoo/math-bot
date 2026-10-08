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
export async function syncGmail(store:AnnouncementStore,client:Pick<GmailClient,'get'>,config:AutomationConfig,signal:AbortSignal){
  const account=config.gmail.account,cursorKey=`gmail:${account}:cursor`;let cursor=store.state(cursorKey);
  const profile=account.includes('@')?await client.get<{emailAddress?:string;historyId:string}>('profile',{},signal):undefined;
  if(profile&&profile.emailAddress?.toLowerCase()!==account.toLowerCase())throw new GmailError(401);
  const ids=new Set<string>();let nextCursor=cursor;let initial=!cursor;
  if(cursor){
    try{let page='';let pages=0;do{
      const data=await client.get<{history?:{messagesAdded?:{message:{id:string}}[]}[];historyId:string;nextPageToken?:string}>('history',{startHistoryId:cursor,historyTypes:'messageAdded',maxResults:'100',...(page?{pageToken:page}:{})},signal);
      for(const row of data.history??[])for(const item of row.messagesAdded??[])ids.add(item.message.id);page=data.nextPageToken??'';nextCursor=data.historyId;if(++pages>=5&&page)throw new Error('History too large: retain cursor for bounded retry.');
    }while(page);}catch(error){if(error instanceof GmailError&&error.status===404)initial=true;else throw error;}
  }
  if(initial){
    // Capture cursor BEFORE listing: arrivals during the bounded listing are replayed safely.
    nextCursor=(profile??await client.get<{historyId:string}>('profile',{},signal)).historyId;
    const data=await client.get<{messages?:{id:string}[]}>('messages',{q:config.gmail.query,maxResults:'100'},signal);for(const m of data.messages??[])ids.add(m.id);
  }
  let permitted:Set<string>|undefined;
  if(!initial && ids.size){
    permitted=new Set<string>();let page='',pages=0;do{
      const data=await client.get<{messages?:{id:string}[];nextPageToken?:string}>('messages',{q:config.gmail.query,maxResults:'100',...(page?{pageToken:page}:{})},signal);
      for(const m of data.messages??[])permitted.add(m.id);page=data.nextPageToken??'';if(++pages>=5&&page)throw new Error('Restricted query exceeds bounded sync; narrow it before advancing cursor.');
    }while(page);
  }
  for(const id of ids){
    if(permitted && !permitted.has(id))continue;
    const sourceId=digest([account,id]);if(store.db.prepare('SELECT id FROM sources WHERE id=?').get(sourceId))continue;
    // Apply the restricted query to history arrivals as well, then check sender independently.
    const message=await client.get<GmailMessage>(`messages/${encodeURIComponent(id)}`,{format:'full'},signal);if(!organizer(message,config.gmail.senders))continue;
    // Persist only provenance. Bodies are fetched again for bounded parsing, never saved here.
    const source:Source={account,messageId:id,attachment:null,sha256:digest(message.payload??{}),locator:'organizer email; local redacted text/table evidence pending'};store.source(config.policy.guild,source);
  }
  if(nextCursor)store.setState(cursorKey,nextCursor);store.setState(`gmail:${account}:health`,'healthy');return ids.size;
}
