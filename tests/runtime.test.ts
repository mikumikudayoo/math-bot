import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:https';

test('HTTPS honors the custom DNS lookup used by public-address pinning',async()=>{
  let called=false;
  await new Promise<void>((resolve,reject)=>{
    const blocked=new Error('lookup intentionally refused');
    const req=request('https://must-not-resolve.invalid/',{
      family:4,
      signal:AbortSignal.timeout(2000),
      lookup:(_host,_options,callback)=>{called=true;callback(blocked,'',4);},
    },response=>{response.destroy();reject(new Error('Custom lookup was bypassed.'));});
    req.once('error',error=>{
      try{assert.ok(called,'runtime must call the supplied DNS lookup');assert.match(error.message,/lookup intentionally refused/);resolve();}
      catch(failure){reject(failure);}
    });
    req.end();
  });
});
