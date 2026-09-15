import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nextOccurrence,validate,type Reminder,type ReminderInput } from './types.js';
export class ReminderStore {
  readonly db:DatabaseSync;
  constructor(path:string){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,guild TEXT NOT NULL,channel TEXT NOT NULL,role TEXT,template TEXT NOT NULL,details TEXT NOT NULL,due INTEGER NOT NULL,anchor INTEGER NOT NULL,recurrence TEXT NOT NULL,interval INTEGER NOT NULL,state TEXT NOT NULL,creator TEXT NOT NULL,editor TEXT NOT NULL,message TEXT);
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(state,due);
      CREATE TABLE IF NOT EXISTS reminder_deliveries(reminder TEXT NOT NULL,due INTEGER NOT NULL,state TEXT NOT NULL,message TEXT,PRIMARY KEY(reminder,due));`);
  }
  get(guild:string,id:string){return this.db.prepare('SELECT * FROM reminders WHERE guild=? AND id=?').get(guild,id) as unknown as Reminder|undefined;}
  list(guild:string){return this.db.prepare('SELECT * FROM reminders WHERE guild=? ORDER BY due,id LIMIT 50').all(guild) as unknown as Reminder[];}
  create(input:ReminderInput,actor:string,now=Date.now()){
    validate(input,now);const id=randomUUID();
    this.db.prepare("INSERT INTO reminders VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,NULL)").run(id,input.guild,input.channel,input.role,input.template,input.details,input.due,input.due,input.recurrence,input.interval,actor,actor);
    return this.get(input.guild,id)!;
  }
  edit(guild:string,id:string,input:ReminderInput,actor:string,now=Date.now()){
    validate(input,now);if(input.guild!==guild)throw new Error('Wrong server.');
    const result=this.db.prepare("UPDATE reminders SET channel=?,role=?,template=?,details=?,due=?,anchor=?,recurrence=?,interval=?,editor=? WHERE guild=? AND id=? AND state='pending'").run(input.channel,input.role,input.template,input.details,input.due,input.due,input.recurrence,input.interval,actor,guild,id);
    if(!result.changes)throw new Error('Only pending reminders can be edited.');
  }
  cancel(guild:string,id:string,actor:string){
    const result=this.db.prepare("UPDATE reminders SET state='cancelled',editor=? WHERE guild=? AND id=? AND state IN ('pending','uncertain')").run(actor,guild,id);
    if(!result.changes)throw new Error('Reminder not found or already delivering/finished.');
  }
  due(now:number,guild?:string){return this.db.prepare(`SELECT * FROM reminders WHERE state='pending' AND due<=? ${guild?'AND guild=?':''} ORDER BY due LIMIT 25`).all(...(guild?[now,guild]:[now])) as unknown as Reminder[];}
  claim(r:Reminder){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const updated=this.db.prepare("UPDATE reminders SET state='delivering' WHERE id=? AND state='pending' AND due=?").run(r.id,r.due);
      if(!updated.changes){this.db.exec('COMMIT');return false;}
      this.db.prepare("INSERT INTO reminder_deliveries VALUES(?,?,'reserved',NULL)").run(r.id,r.due);
      const claimed=this.get(r.guild,r.id)!;
      this.db.exec('COMMIT');return claimed;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  finish(r:Reminder,message:string|null,now:number){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const next=message?nextOccurrence(r,now):null;
      this.db.prepare('UPDATE reminder_deliveries SET state=?,message=? WHERE reminder=? AND due=?').run(message?'sent':'uncertain',message,r.id,r.due);
      this.db.prepare("UPDATE reminders SET state=?,due=?,message=? WHERE id=? AND state='delivering'").run(message?(next?'pending':'sent'):'uncertain',next??r.due,message,r.id);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  close(){this.db.close();}
}
