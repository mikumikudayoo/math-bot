import { randomUUID } from 'node:crypto';
import type { DiscordTask,DiscordTool } from '../discord-context.js';
import type { Job } from './types.js';
import { UserError } from './types.js';
type BrokerState='requested'|'completed'|'unavailable'|'invalid_result'|'cancelled'|'timed_out'|'closed';
interface BrokerTelemetry {requestId:string;tool:string;state:BrokerState;latencyMs?:number}
const loggedTools=new Set(['discord_search','discord_member','discord_audience']);
export class DiscordBroker {
  private tasks=new Map<string,{task:DiscordTask;started:number;claimed:boolean;resolve:(value:unknown)=>void;reject:(error:Error)=>void;clean:()=>void}>();
  constructor(private readonly log:(event:BrokerTelemetry)=>void=event=>console.log('[discord-broker]',event)){}
  private report(id:string,tool:DiscordTool,state:BrokerState,started?:number){
    this.log({requestId:id,tool:loggedTools.has(tool)?tool:'unsupported',state,...(started===undefined?{}:{latencyMs:Math.max(0,Math.min(30000,Date.now()-started))})});
  }
  request(job:Job,tool:DiscordTool,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
    signal.throwIfAborted();if(this.tasks.size>=64)throw new UserError('Discord lookup is busy.');
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),started=Date.now();
      const fail=(state:'cancelled'|'timed_out')=>{const pending=this.tasks.get(id);if(!pending)return;pending.clean();this.report(id,tool,state,started);reject(new UserError('Discord lookup unavailable or cancelled.'));};
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
    const r=value&&typeof value==='object'?value as {type?:unknown;error?:unknown}:undefined;
    const state:BrokerState=r?.type==='DISCORD_SEARCH_DATA'||r?.type==='DISCORD_MEMBER_DATA'||r?.type==='DISCORD_AUDIENCE_DATA'?'completed':r?.error!==undefined?'unavailable':'invalid_result';
    this.report(id,pending.task.tool,state,pending.started);
    pending.clean();pending.resolve(value);return true;}
  close(){for(const p of [...this.tasks.values()]){p.clean();this.report(p.task.id,p.task.tool,'closed',p.started);p.reject(new UserError('Discord lookup unavailable.'));}}
}
