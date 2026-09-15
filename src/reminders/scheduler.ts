import type { Client } from 'discord.js';
import { createHash } from 'node:crypto';
import { ChannelType } from 'discord.js';
import { ReminderStore } from './store.js';
import { renderReminder } from './templates.js';
import type { Reminder } from './types.js';
export async function deliverDue(store:ReminderStore,send:(r:Reminder,payload:ReturnType<typeof renderReminder>)=>Promise<{id:string}>,now=Date.now(),guild?:string){
  for(const candidate of store.due(now,guild)){
    const r=store.claim(candidate);if(!r)continue;
    let message:string|null=null;
    try{message=(await send(r,renderReminder(r))).id;}catch{/* Uncertain sends must never be retried automatically. */}
    store.finish(r,message,Math.max(now,Date.now()));
  }
}
let shared:ReminderStore|undefined;
export function reminderStore(path:string){return shared??=new ReminderStore(path);}
export function startReminders(client:Client,path:string,guild?:string){
  const store=reminderStore(path);let busy=false,stopped=false;
  const tick=async()=>{
    if(busy||stopped)return;busy=true;
    try{await deliverDue(store,async(r,payload)=>{
      if(stopped)throw new Error('Stopping.');
      const channel=await client.channels.fetch(r.channel);
      if(!channel||channel.type!==ChannelType.GuildText||channel.guildId!==r.guild)throw new Error('Reminder channel unavailable.');
      return channel.send({...payload,nonce:createHash('sha256').update(`${r.id}:${r.due}`).digest('hex').slice(0,25),enforceNonce:true});
    },Date.now(),guild);}catch{console.error('Reminder scheduler failed; inspect reminder state.');}finally{busy=false;}
  };
  const timer=setInterval(()=>void tick(),15000);void tick();
  return ()=>{stopped=true;clearInterval(timer);};
}
