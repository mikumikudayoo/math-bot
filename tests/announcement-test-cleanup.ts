import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute,relative,resolve,sep } from 'node:path';

/** Call only after every store using this temporary directory has been closed. */
export function removeAnnouncementTestDirectory(directory:string){
  const target=resolve(directory),child=relative(resolve(tmpdir()),target);
  if(!child||child==='..'||child.startsWith(`..${sep}`)||isAbsolute(child))throw new Error('Announcement test cleanup requires a temporary child directory.');
  // Bun's Windows node:sqlite statements can retain file handles after close()
  // until collection. Reclaim them before removing the isolated fixture files.
  if(process.platform==='win32')Bun.gc(true);
  rmSync(target,{recursive:true,force:true});
}
