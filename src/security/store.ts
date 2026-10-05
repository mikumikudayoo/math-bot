import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { validateSecurityConfig } from './config.js';
import { compileDetectors, decide } from './detectors.js';
import { defaultSecurityConfig, type SecurityConfig, type ModerationInput, type CaseRecord } from './types.js';

export class SecurityStore {
  readonly db:DatabaseSync;
  private cache=new Map<string,{revision:number;config:SecurityConfig;detect:ReturnType<typeof compileDetectors>}>();
  constructor(path:string,readonly clock:()=>number=Date.now){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    const tables=this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if(tables.some(t=>!String(t.name).startsWith('security_'))||Number(this.db.prepare('PRAGMA user_version').get()?.user_version)>1){this.db.close();throw new Error('Use a separate supported moderation database.');}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS security_config(guild TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_config_versions(guild TEXT NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(guild,revision));
      CREATE TABLE IF NOT EXISTS security_cases(id INTEGER PRIMARY KEY,guild TEXT NOT NULL,event TEXT NOT NULL,eventId TEXT NOT NULL,user TEXT NOT NULL,source TEXT NOT NULL,created INTEGER NOT NULL,mode TEXT NOT NULL,origin TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,findings TEXT NOT NULL,decision TEXT NOT NULL,configVersion INTEGER NOT NULL,UNIQUE(guild,event));
      CREATE INDEX IF NOT EXISTS security_cases_member ON security_cases(guild,user,created);
      CREATE TABLE IF NOT EXISTS security_infractions(caseId INTEGER PRIMARY KEY,guild TEXT NOT NULL,user TEXT NOT NULL,source TEXT NOT NULL,eventId TEXT NOT NULL,policy TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,UNIQUE(guild,user,source,eventId));
      CREATE INDEX IF NOT EXISTS security_infractions_window ON security_infractions(guild,user,policy,created);
      CREATE TABLE IF NOT EXISTS security_case_events(id INTEGER PRIMARY KEY,caseId INTEGER NOT NULL,created INTEGER NOT NULL,phase TEXT NOT NULL,details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_actions(caseId INTEGER NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,details TEXT NOT NULL,PRIMARY KEY(caseId,kind));
      CREATE TRIGGER IF NOT EXISTS security_cases_immutable_update BEFORE UPDATE ON security_cases BEGIN SELECT RAISE(ABORT,'Cases are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS security_cases_immutable_delete BEFORE DELETE ON security_cases BEGIN SELECT RAISE(ABORT,'Cases are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS security_events_immutable_update BEFORE UPDATE ON security_case_events BEGIN SELECT RAISE(ABORT,'Audit events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS security_events_immutable_delete BEFORE DELETE ON security_case_events BEGIN SELECT RAISE(ABORT,'Audit events are immutable'); END;
      PRAGMA user_version=1; COMMIT;`);
  }
  config(guild:string){
    const row=this.db.prepare('SELECT revision,payload FROM security_config WHERE guild=?').get(guild);
    const revision=Number(row?.revision??0), cached=this.cache.get(guild);
    if(cached?.revision===revision)return cached;
    const config=row?validateSecurityConfig(JSON.parse(String(row.payload))):defaultSecurityConfig();
    const value={revision,config,detect:compileDetectors(config)};
    if(this.cache.size>=100)this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(guild,value);return value;
  }
  saveConfig(guild:string,value:unknown,actor:string,expectedRevision:number){
    const config=validateSecurityConfig(value);
    return this.transaction(()=>{
      const previous=this.config(guild);if(previous.revision!==expectedRevision)throw new Error('Configuration changed. Reload and try again.');
      const revision=previous.revision+1,payload=JSON.stringify(config),now=this.clock();
      this.db.prepare('INSERT INTO security_config_versions VALUES(?,?,?,?,?)').run(guild,revision,actor,now,payload);
      this.db.prepare('INSERT INTO security_config VALUES(?,?,?) ON CONFLICT(guild) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(guild,revision,payload);
      this.cache.delete(guild);return revision;
    });
  }
  private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.cache.clear();this.db.exec('ROLLBACK');throw error;}}
  count(guild:string,user:string,policy:string,windowMs:number,now=this.clock()){
    return Number(this.db.prepare('SELECT count(*) AS n FROM security_infractions WHERE guild=? AND user=? AND policy=? AND created>? AND created<=? AND expires>?').get(guild,user,policy,now-windowMs,now,now)?.n??0);
  }
  process(input:ModerationInput,actor:string):{record:CaseRecord;fresh:boolean}|null {
    const cached=this.config(input.guild);if(cached.config.mode==='disabled')return null;
    const findings=cached.detect(input);if(!findings.length)return null;
    const event=createHash('sha256').update(JSON.stringify([input.source,input.eventId,input.content])).digest('hex');
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT * FROM security_cases WHERE guild=? AND event=?').get(input.guild,event);
      if(old)return {record:this.decode(old),fresh:false};
      // Re-read under the write lock so configuration and counts agree.
      const current=this.config(input.guild), liveFindings=current.detect(input);
      if(current.config.mode==='disabled'||!liveFindings.length)return null;
      const now=this.clock();
      const prior=this.db.prepare('SELECT 1 FROM security_infractions WHERE guild=? AND user=? AND source=? AND eventId=?').get(input.guild,input.author.id,input.source,input.eventId);
      const decision=decide(current.config,liveFindings,(p,w)=>Math.max(0,this.count(input.guild,input.author.id,p,w,now)-(prior?1:0)),input.source);
      if(prior){decision.count=false;decision.action='review';decision.durationMs=0;}
      const result=this.db.prepare('INSERT INTO security_cases(guild,event,eventId,user,source,created,mode,origin,actor,reason,findings,decision,configVersion) VALUES(?,?,?,?,?,?,?,\'automatic\',?,?,?,?,?)')
        .run(input.guild,event,input.eventId,input.author.id,input.source,now,current.config.mode,actor,liveFindings.map(f=>f.ruleId).join(', '),JSON.stringify(liveFindings),JSON.stringify(decision),current.revision);
      const id=Number(result.lastInsertRowid);
      if(current.config.mode==='enforce'&&decision.count)this.db.prepare('INSERT INTO security_infractions VALUES(?,?,?,?,?,?,?,?)').run(id,input.guild,input.author.id,input.source,input.eventId,decision.policy!,now,now+decision.warningExpiryMs);
      this.audit(id,'detected',{mode:current.config.mode,configVersion:current.revision});
      return {record:this.get(input.guild,id)!,fresh:true};
    });
  }
  get(guild:string,id:number):CaseRecord|undefined{const row=this.db.prepare('SELECT * FROM security_cases WHERE guild=? AND id=?').get(guild,id);return row?this.decode(row):undefined;}
  recent(guild:string,user?:string){return this.db.prepare(`SELECT * FROM security_cases WHERE guild=? ${user?'AND user=?':''} ORDER BY id DESC LIMIT 20`).all(...(user?[guild,user]:[guild])).map(r=>this.decode(r));}
  events(guild:string,id:number){if(!this.get(guild,id))return [];return this.db.prepare('SELECT created,phase,details FROM security_case_events WHERE caseId=? ORDER BY id').all(id);}
  audit(id:number,phase:string,details:unknown){this.db.prepare('INSERT INTO security_case_events(caseId,created,phase,details) VALUES(?,?,?,?)').run(id,this.clock(),phase,JSON.stringify(details));}
  claim(record:CaseRecord,kind:string):boolean {
    return this.transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM security_actions WHERE caseId=? AND kind=?').get(record.id,kind))return false;
      const n=Number(this.db.prepare("SELECT count(*) AS n FROM security_actions a JOIN security_cases c ON c.id=a.caseId WHERE c.guild=? AND c.user=? AND a.kind='dispatch' AND a.created>?").get(record.guild,record.user,this.clock()-60000)?.n??0);
      const limited=kind==='dispatch'&&n>=this.config(record.guild).config.maxActionsPerMinute;
      this.db.prepare('INSERT INTO security_actions VALUES(?,?,?,?,?)').run(record.id,kind,limited?'rate-limited':'reserved',this.clock(),'{}');
      this.audit(record.id,limited?'rate-limited':`${kind}.reserved`,{});return !limited;
    });
  }
  outcome(id:number,kind:string,state:string,details:unknown){this.db.prepare('UPDATE security_actions SET state=?,details=? WHERE caseId=? AND kind=?').run(state,JSON.stringify(details),id,kind);this.audit(id,`${kind}.${state}`,details);}
  private decode(row:Record<string,unknown>):CaseRecord{return {...row,findings:JSON.parse(String(row.findings)),decision:JSON.parse(String(row.decision))} as unknown as CaseRecord;}
  close(){this.cache.clear();this.db.close();}
}
