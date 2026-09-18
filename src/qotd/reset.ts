import { DatabaseSync } from 'node:sqlite';
import { existsSync, realpathSync, unlinkSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, dirname, relative, resolve, isAbsolute } from 'node:path';
export function resetDevelopmentQotd(path:string,localRoot:string,mode:string,confirmed:boolean) {
  if(mode!=='development'||!confirmed)throw new Error('Development-only reset requires --discard-qotd-state.');
  const root=realpathSync(localRoot);const target=resolve(realpathSync(dirname(path)),basename(path));
  const rel=relative(root,target);
  if(!rel||rel.startsWith('..')||isAbsolute(rel)||basename(target)!=='qotd.sqlite')throw new Error('Reset is restricted to local qotd.sqlite inside this checkout.');
  if(!existsSync(target))return {reset:false,questions:0,approved:0,history:0};
  if(realpathSync(target)!==target)throw new Error('Refusing to reset a symlinked database.');
  // A server holding the old inode could keep writing discarded state after an
  // unlink. Refuse while another process has the target DB/WAL open on Linux.
  if(process.platform==='linux')for(const pid of readdirSync('/proc').filter(p=>/^\d+$/.test(p)&&Number(p)!==process.pid)) {
    let descriptors:string[];try{descriptors=readdirSync(`/proc/${pid}/fd`);}catch{continue;}
    for(const fd of descriptors){let file:string;try{file=readlinkSync(`/proc/${pid}/fd/${fd}`);}catch{continue;}
      if([target,target+'-wal',target+'-shm'].includes(file))throw new Error(`Close local MPoTD process ${pid} before resetting.`);
    }
  }
  const db=new DatabaseSync(target);
  let result;
  try {
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>String(r.name));
    if(!names.includes('qotd_questions')||names.some(n=>!n.startsWith('qotd_')))throw new Error('This is not an isolated MPoTD database; nothing deleted.');
    result={reset:true,questions:Number(db.prepare('SELECT count(*) n FROM qotd_questions').get()!.n),approved:Number(db.prepare("SELECT count(*) n FROM qotd_questions WHERE state='approved'").get()!.n),history:Number(db.prepare('SELECT count(*) n FROM qotd_history').get()!.n)};
    const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if(checkpoint?.busy)throw new Error('MPoTD database is busy; close local bot/review processes first.');
  }finally{db.close();}
  for(const file of [target,target+'-wal',target+'-shm'])if(existsSync(file))unlinkSync(file);
  return result;
}
