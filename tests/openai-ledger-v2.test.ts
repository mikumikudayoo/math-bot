import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseOpenAIConfig } from '../src/service/openai-config.js';
import { UsageLedger, costMicros } from '../src/service/openai-budget.js';

const settings=parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:'sk-test'+'x'.repeat(32),OPENAI_TOTAL_BUDGET_USD:'0.0011'})!;

test('reservations from independent SQLite writers cannot claim the same remaining dollars',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aleph-ledger-'));
  const path=join(dir,'ledger.sqlite');
  const db=new DatabaseSync(path);
  const ledger=new UsageLedger(db,settings);
  try {
    // The production transaction is synchronous. Interleave outstanding calls on two independent connections.
    const otherDB=new DatabaseSync(path);
    try {
      const second=new UsageLedger(otherDB,settings);
      const reserve=(l:UsageLedger,job:string)=>l.reserve({job,user:'system',model:settings.models.luna,
        tier:'system',effort:'low',inputTokens:2,maxOutputTokens:2000});
      const results=await Promise.allSettled([Promise.resolve().then(()=>reserve(ledger,'a')),Promise.resolve().then(()=>reserve(second,'b'))]);
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(results.filter(x=>x.status==='rejected').length,1);
      assert.ok(ledger.summary().totalUsd<=settings.totalBudgetUsd);
      const first=results.find(x=>x.status==='fulfilled')!;
      if(first.status==='fulfilled') ledger.settle(first.value.id,{status:'error',billed:false,latencyMs:1});
      assert.equal(second.summary().totalUsd,0);
      const last=reserve(second,'c');
      second.settle(last.id,{usage:{inputTokens:1,cachedTokens:1,write30mTokens:1,outputTokens:1,reasoningTokens:0},status:'ok',latencyMs:1});
      assert.equal(second.jobSpentMicros('c'),last.worst);
      ledger.settle(last.id,{status:'error',billed:false,latencyMs:2});
      assert.equal(second.jobSpentMicros('c'),last.worst);
    } finally {otherDB.close();}
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('an existing job cannot be escalated or charged under another user',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const ledger=new UsageLedger(db,settings);
    ledger.admitJob({job:'j',guild:'g',user:'a'});
    assert.equal(ledger.authorizeEscalation('j','b','sol').ok,false);
    assert.throws(()=>ledger.admitJob({job:'j',guild:'g',user:'b'}));
    assert.throws(()=>ledger.reserve({job:'j',user:'b',model:settings.models.luna,tier:'consult',effort:'low',inputTokens:1,maxOutputTokens:3}));
    assert.throws(()=>ledger.reserve({job:'orphan',user:'a',model:settings.models.luna,tier:'system',effort:'low',inputTokens:1,maxOutputTokens:3}));
  } finally {db.close();}
});

test('cache reads and writes each replace ordinary input while reasoning remains part of output',()=>{
  const spec={...settings.pricing[settings.models.terra]!,input:1,cachedInput:0.05,output:5};
  assert.equal(costMicros(spec,{inputTokens:100,cachedTokens:10,write30mTokens:8,write12hTokens:20,outputTokens:10,reasoningTokens:9}),173);
});
