import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runToolCalls, LoopGuard } from '../src/service/tool-pool.js';
import { regexTool, REGEX_MAX_TEXT_CHARS } from '../src/service/regex-tool.js';

test('tool pool queues dependent groups, preserves call order, and isolates individual timeouts',async()=>{
  const order:string[]=[];
  const call=(name:string,ms:number)=>({id:name,name,run:async(s:AbortSignal)=>{
    order.push(name);
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(resolve,ms);
      s.addEventListener('abort',()=>{clearTimeout(timer);reject(s.reason);},{once:true});
    });
    return name;
  }});
  const out=await runToolCalls([call('a1',12),call('a2',0),call('independent',1),call('timeout',2000)],AbortSignal.timeout(3000),{
    concurrency:3,exclusiveGroup:n=>n.startsWith('a')?'a':undefined,timeoutMs:n=>n==='timeout'?3:undefined});
  assert.deepEqual(order,['a1','independent','timeout','a2']);
  assert.deepEqual(out.map(v=>v.id),['a1','a2','independent','timeout']);assert.ok(!out[3]!.ok&&out[3]!.timedOut);
  assert.throws(()=>runToolCalls([call('d',1),call('d',1)],new AbortController().signal,{concurrency:1}),/Duplicate/);
});
test('loop guard assesses once, returns hard stop at configured round, and counts reordered arguments as repeats',()=>{
  const loop=new LoopGuard({softRounds:2,hardRounds:3,maxRepeatedCall:1});
  assert.deepEqual([loop.beginRound(),loop.beginRound(),loop.beginRound(),loop.beginRound()],['ok','soft','ok','hard']);
  loop.recordCall('x','{"x":1,"y":2}',{ok:true,outputDigest:'ok'});
  loop.recordCall('x','{"y":2,"x":1}',{ok:true,outputDigest:'ok'});assert.equal(loop.stalled,true);
});
test('RE2 rejects unsupported constructs and oversized inputs; bounded matches handle Unicode and cap returned rows',()=>{
  assert.throws(()=>regexTool({pattern:'(a)\\1',text:'aa'}),/regex|backreference/i);
  assert.throws(()=>regexTool({pattern:'(?=a)',text:'a'}),/lookahead/i);
  assert.throws(()=>regexTool({pattern:'a',text:'a'.repeat(REGEX_MAX_TEXT_CHARS+1)}));
  const result=regexTool({pattern:'\\p{L}+',text:'猫 ねこ dog',operation:'extract',limit:2});
  assert.equal(result.operation,'extract');if(result.operation==='extract'){assert.equal(result.matches.length,2);assert.equal(result.truncated,true);}
  assert.deepEqual(regexTool({pattern:'^alpha$',text:'ALPHA',operation:'test',flags:'i'}),{operation:'test',matched:true});
});
