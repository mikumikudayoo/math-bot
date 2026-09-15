export const templates=['session','pretest','deadline','update-roles','generic'] as const;
export type Template=typeof templates[number];
export type Recurrence='none'|'days'|'months';
export interface ReminderInput {guild:string;channel:string;role:string|null;template:Template;details:string;due:number;recurrence:Recurrence;interval:number}
export interface Reminder extends ReminderInput {id:string;anchor:number;state:'pending'|'delivering'|'sent'|'uncertain'|'cancelled';creator:string;editor:string;message:string|null}

export function parseTime(value:string):number {
  if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value))throw new Error('Use YYYY-MM-DD HH:mm in Asia/Manila (24-hour time).');
  const n=Date.parse(value.replace(' ','T')+':00+08:00');
  if(!Number.isFinite(n)||new Date(n+8*3600000).toISOString().slice(0,16).replace('T',' ')!==value)throw new Error('Invalid calendar date/time.');
  return n;
}
export function validate(input:ReminderInput,now:number) {
  if(![input.guild,input.channel,...(input.role?[input.role]:[])].every(id=>/^\d{17,20}$/.test(id)))throw new Error('Use valid Discord IDs.');
  if(input.role===input.guild)throw new Error('The everyone role cannot be mentioned.');
  if(!templates.includes(input.template)||!input.details.trim()||input.details.length>1200)throw new Error('Choose a template and provide 1–1200 characters of details.');
  if(!Number.isSafeInteger(input.due)||input.due<=now||input.due>now+100*366*86400000)throw new Error('Choose a future time within 100 years.');
  if(!['none','days','months'].includes(input.recurrence)||!Number.isInteger(input.interval)||input.interval<1||input.interval>120)throw new Error('Recurrence interval must be 1–120 days or months.');
}
export function nextOccurrence(r:Pick<Reminder,'anchor'|'due'|'recurrence'|'interval'>,now:number):number|null {
  if(r.recurrence==='none')return null;
  const after=Math.max(now,r.due);
  if(r.recurrence==='days')return r.anchor+(Math.floor((after-r.anchor)/(r.interval*86400000))+1)*r.interval*86400000;
  const original=new Date(r.anchor+8*3600000);
  const current=new Date(after+8*3600000);
  const elapsed=(current.getUTCFullYear()-original.getUTCFullYear())*12+current.getUTCMonth()-original.getUTCMonth();
  for(let step=Math.max(1,Math.floor(elapsed/r.interval));;step++){
    const month=original.getUTCMonth()+step*r.interval;
    const last=new Date(Date.UTC(original.getUTCFullYear(),month+1,0)).getUTCDate();
    const candidate=Date.UTC(original.getUTCFullYear(),month,Math.min(original.getUTCDate(),last),original.getUTCHours(),original.getUTCMinutes())-8*3600000;
    if(candidate>after)return candidate;
  }
}
