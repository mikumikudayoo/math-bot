import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnnouncementStore } from '../src/announcements/store.js';
import { recordSourceFailure,clearSourceFailure,reconcileExtractionIncident,staffAlertContent,incidentCooldownMs } from '../src/announcements/alerts.js';
const guild='111111111111111111';
function source(s:AnnouncementStore,i:number){return s.source(guild,{account:'test',messageId:String(i),sha256:'a'.repeat(64),attachment:null,locator:'test'});}
function alerts(s:AnnouncementStore,kind:string){return s.db.prepare('SELECT id,kind,target,state FROM staff_alerts WHERE kind=?').all(kind) as {id:string;kind:string;target:string;state:string}[];}
test('multiple Groq failures aggregate; repeated unchanged failures never create new posts',()=>{
 const s=new AnnouncementStore(':memory:');try{
 const ids=[1,2,3].map(i=>source(s,i));for(const id of ids){recordSourceFailure(s,id,'groq','http-429');s.alert(guild,'extraction-provider-unavailable',id);}
 reconcileExtractionIncident(s,guild,false,1000);for(let i=0;i<20;i++)reconcileExtractionIncident(s,guild,false,1000+i*incidentCooldownMs);
 assert.equal(alerts(s,'provider-outage').length,1);assert.ok(alerts(s,'extraction-provider-unavailable').every(a=>a.state==='superseded'));
 const content=staffAlertContent(s,guild,alerts(s,'provider-outage')[0]!);assert.ok(content.includes('3 organizer emails'));for(const id of ids)assert.ok(!content.includes(id));
 }finally{s.close();}
});
test('count changes obey cooldown and recovery is emitted once only after confirmed healthy queue clearance',()=>{
 const s=new AnnouncementStore(':memory:');try{
 const a=source(s,1),b=source(s,2);recordSourceFailure(s,a,'groq','transport');reconcileExtractionIncident(s,guild,false,1000);
 // Simulate Discord delivery of the first notification.
 s.db.prepare("UPDATE staff_alerts SET state='sent'").run();recordSourceFailure(s,b,'groq','transport');reconcileExtractionIncident(s,guild,false,1001);
 assert.equal(alerts(s,'provider-outage').length,1);reconcileExtractionIncident(s,guild,false,1000+incidentCooldownMs);assert.equal(alerts(s,'provider-outage').length,2);
 clearSourceFailure(s,a);clearSourceFailure(s,b);reconcileExtractionIncident(s,guild,false,2000+incidentCooldownMs);assert.equal(alerts(s,'provider-recovered').length,0);
 reconcileExtractionIncident(s,guild,true,2001+incidentCooldownMs);reconcileExtractionIncident(s,guild,true,2002+incidentCooldownMs);assert.equal(alerts(s,'provider-recovered').length,1);
 recordSourceFailure(s,a,'groq','transport');reconcileExtractionIncident(s,guild,false,2003+incidentCooldownMs);assert.equal(alerts(s,'provider-outage').length,3);
 }finally{s.close();}
});
test('incident survives database reopen and Gmail errors do not become Groq incidents',()=>{
 const dir=mkdtempSync(join(tmpdir(),'alerts-')),path=join(dir,'alerts.sqlite');let s=new AnnouncementStore(path);try{
 const a=source(s,1);recordSourceFailure(s,a,'gmail','Gmail attachment unavailable');reconcileExtractionIncident(s,guild,false,1000);assert.equal(alerts(s,'provider-outage').length,0);
 recordSourceFailure(s,a,'groq','http-503');reconcileExtractionIncident(s,guild,false,1001);s.close();s=new AnnouncementStore(path);reconcileExtractionIncident(s,guild,false,1002+incidentCooldownMs);assert.equal(alerts(s,'provider-outage').length,1);
 const message=staffAlertContent(s,guild,{id:'x',kind:'blocked-source',target:a});assert.ok(message.includes('Reason:'));assert.ok(!message.includes(a));
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('normal alerts deduplicate the same source/state without hiding audit IDs',()=>{
 const s=new AnnouncementStore(':memory:');try{const id=source(s,1);s.alert(guild,'blocked-source',id);s.alert(guild,'blocked-source',id);assert.equal(alerts(s,'blocked-source').length,1);assert.equal(alerts(s,'blocked-source')[0]!.target,id);}finally{s.close();}
});

test('pending outage updates its live count without accumulating posts; recovery with waiting sources stays recovered on idle ticks',()=>{
 const s=new AnnouncementStore(':memory:');try{
 const a=source(s,1),b=source(s,2);recordSourceFailure(s,a,'groq','http-429');reconcileExtractionIncident(s,guild,false,1000);
 recordSourceFailure(s,b,'groq','http-429');reconcileExtractionIncident(s,guild,false,1000+incidentCooldownMs);assert.equal(alerts(s,'provider-outage').length,1);assert.ok(staffAlertContent(s,guild,alerts(s,'provider-outage')[0]!).includes('2 organizer emails'));
 clearSourceFailure(s,a);reconcileExtractionIncident(s,guild,true,2000+incidentCooldownMs,false);assert.equal(alerts(s,'provider-recovered').length,1);
 reconcileExtractionIncident(s,guild,false,3000+incidentCooldownMs,false);assert.equal(alerts(s,'provider-outage').length,1);
 }finally{s.close();}
});
