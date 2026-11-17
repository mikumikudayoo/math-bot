import { randomUUID } from 'node:crypto';
import type { DiscordTask,DiscordTool } from '../discord-context.js';
import type { Job } from './types.js';
import { UserError } from './types.js';
type BrokerState='requested'|'completed'|'unavailable'|'invalid_result'|'cancelled'|'timed_out'|'closed';
/** Metadata only: never arguments, results or content. `outcome` is the host decision for authorization tools. */
interface BrokerTelemetry {requestId:string;tool:string;state:BrokerState;latencyMs?:number;outcome?:'allowed'|'denied'}
const loggedTools=new Set(['discord_search','discord_member','discord_audience','competition_reference']);
const resultTypes=new Set(['DISCORD_SEARCH_DATA','DISCORD_MEMBER_DATA','DISCORD_AUDIENCE_DATA','COMPETITION_REFERENCE_DATA']);
/** Same user-facing text as before; `state` lets host diagnostics tell a timeout from a closed or cancelled broker. */
export class DiscordBrokerError extends UserError {
  constructor(readonly state:'cancelled'|'timed_out'|'closed'|'busy',message='Discord lookup unavailable or cancelled.'){super(message);}
}
export class DiscordBroker {
  private tasks=new Map<string,{task:DiscordTask;started:number;claimed:boolean;resolve:(value:unknown)=>void;reject:(error:Error)=>void;clean:()=>void}>();
  constructor(private readonly log:(event:BrokerTelemetry)=>void=event=>console.log('[discord-broker]',event)){}
  private report(id:string,tool:DiscordTool,state:BrokerState,started?:number,outcome?:'allowed'|'denied'){
    this.log({requestId:id,tool:loggedTools.has(tool)?tool:'unsupported',state,...(started===undefined?{}:{latencyMs:Math.max(0,Math.min(30000,Date.now()-started))}),...(outcome?{outcome}:{})});
  }
  request(job:Job,tool:DiscordTool,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
    signal.throwIfAborted();if(this.tasks.size>=64)throw new DiscordBrokerError('busy','Discord lookup is busy.');
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),started=Date.now();
      const fail=(state:'cancelled'|'timed_out')=>{const pending=this.tasks.get(id);if(!pending)return;pending.clean();this.report(id,tool,state,started);reject(new DiscordBrokerError(state));};
      const abort=()=>fail('cancelled');
      const timer=setTimeout(()=>fail('timed_out'),30000);
      const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);this.tasks.delete(id);};
      this.tasks.set(id,{task:{id,job:job.id,user:job.user,guild:job.guild,channel:job.channel,...(job.sourceMessageId?{sourceMessageId:job.sourceMessageId}:{}),tool,args},started,claimed:false,resolve,reject,clean});
      this.report(id,tool,'requested');
      signal.addEventListener('abort',abort,{once:true});
    });
  }
  take(){const tasks=[...this.tasks.values()].filter(t=>!t.claimed).slice(0,4);for(const t of tasks)t.claimed=true;return tasks.map(t=>t.task);}
  finish(id:string,value:unknown){const pending=this.tasks.get(id);if(!pending?.claimed)return false;
    const r=value&&typeof value==='object'?value as {type?:unknown;error?:unknown;allowed?:unknown}:undefined;
    const state:BrokerState=typeof r?.type==='string'&&resultTypes.has(r.type)?'completed':r?.error!==undefined?'unavailable':'invalid_result';
    const authorization=r?.type==='DISCORD_AUDIENCE_DATA'||r?.type==='COMPETITION_REFERENCE_DATA';
    this.report(id,pending.task.tool,state,pending.started,authorization?(r?.allowed===true?'allowed':'denied'):undefined);
    pending.clean();pending.resolve(value);return true;}
  close(){for(const p of [...this.tasks.values()]){p.clean();this.report(p.task.id,p.task.tool,'closed',p.started);p.reject(new DiscordBrokerError('closed','Discord lookup unavailable.'));}}
}
