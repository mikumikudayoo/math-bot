import { randomUUID } from 'node:crypto';
import type { DiscordTask,DiscordTool } from '../discord-context.js';
import type { Job } from './types.js';
import { UserError } from './types.js';
export class DiscordBroker {
  private tasks=new Map<string,{task:DiscordTask;claimed:boolean;resolve:(value:unknown)=>void;reject:(error:Error)=>void;clean:()=>void}>();
  request(job:Job,tool:DiscordTool,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
    signal.throwIfAborted();if(this.tasks.size>=64)throw new UserError('Discord lookup is busy.');
    console.log("[discord-broker] request",tool,"user",job.user,"args",args);
    return new Promise((resolve,reject)=>{
      const id=randomUUID();const fail=()=>{this.tasks.get(id)?.clean();reject(new UserError('Discord lookup unavailable or cancelled.'));};
      const timer=setTimeout(fail,30000);
      const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',fail);this.tasks.delete(id);};
      this.tasks.set(id,{task:{id,job:job.id,user:job.user,guild:job.guild,channel:job.channel,...(job.sourceMessageId?{sourceMessageId:job.sourceMessageId}:{}),tool,args},claimed:false,resolve,reject,clean});
      signal.addEventListener('abort',fail,{once:true});
    });
  }
  take(){const tasks=[...this.tasks.values()].filter(t=>!t.claimed).slice(0,4);for(const t of tasks)t.claimed=true;return tasks.map(t=>t.task);}
  finish(id:string,value:unknown){const pending=this.tasks.get(id);if(!pending?.claimed)return false;const r=value as {type?:string;results?:{author?:{id?:string}}[]};
    console.log('[discord-broker] result',{type:r?.type,matches:r?.results?.length,requesterMatches:r?.results?.filter(x=>x.author?.id===pending.task.user).length});
    pending.clean();pending.resolve(value);return true;}
  close(){for(const p of [...this.tasks.values()]){p.clean();p.reject(new UserError('Discord lookup unavailable.'));}}
}
