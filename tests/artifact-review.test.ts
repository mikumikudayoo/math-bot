import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { inspectPlotPng, reviewArtifact } from '../src/service/artifact-review.js';
import { fixturePlot as plot, fixturePlotArgs as args } from './fixtures/review-plot.js';

function verdict(approved:boolean) {
  return {choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[
    {id:'r',type:'function',function:{name:'review_plot',arguments:JSON.stringify({approved,feedback:approved?'consistent':'the axis labels are missing'})}}]}}]};
}
test('validated pixels and the worker data are both supplied for an explicit review of the exact png',async()=>{
  const artifact=plot();let seen=0;
  for(const approved of [true,false]){
    const result=await reviewArtifact(artifact,args,async(chat,tools)=>{
      seen++;assert.equal(tools?.[0]?.function.name,'review_plot');
      assert.deepEqual((chat[1]!.content as any[])[1],{type:'image_url',image_url:{url:'data:image/png;base64,'+artifact}});
      assert.deepEqual(JSON.parse((chat[1]!.content as any[])[0].text).samples,[[-2,4],[0,0],[2,4]]);
      return verdict(approved);
    });assert.equal(result.approved,approved);
  }
  assert.equal(seen,2);
});
test('bad dimensions, corrupt pixels, missing or inconsistent receipts and blank plots never reach the model',async()=>{
  const original=Buffer.from(plot(),'base64'),oversize=Buffer.from(original),corrupt=Buffer.from(original);
  oversize.writeUInt32BE(1_000_000,16);corrupt[corrupt.length-16]!^=1;
  const bare=createCanvas(50,50).toBuffer('image/png').toString('base64');
  for (const artifact of ['',bare,plot(true),plot(false,{...args,finite:1,samples:[]}),
    plot(false,{...args,finite:301,samples:[[-2,4],[.72/17,0],[2,4]]}),
    oversize.toString('base64'),corrupt.toString('base64'),original.subarray(0,original.length-1).toString('base64')]){
    await assert.rejects(inspectPlotPng(artifact,args));
    let called=false;assert.equal((await reviewArtifact(artifact,args,async()=>{called=true})).approved,false);assert.equal(called,false);
  }
  await assert.rejects(inspectPlotPng(plot(),{expression:'x+1',min:-2,max:2}));
});
test('text-only approval, broken review protocol and provider failures cannot publish a plot',async()=>{
  const artifact=plot();
  for (const reply of [{choices:[{finish_reason:'stop',message:{role:'assistant',content:'approved!'}}]}, {}, undefined]){
    assert.equal((await reviewArtifact(artifact,args,async()=>reply)).approved,false);
  }
  assert.equal((await reviewArtifact(artifact,args,async()=>{throw new Error('timeout')})).approved,false);
});
test('generated pixels reach the embargo checker only after format and sample validation',async()=>{
  let screened=0,reviews=0;
  const review=async()=>{reviews++;return verdict(true);};
  const screen=async()=>{screened++;throw new Error('competition guard denied this image');};
  assert.equal((await reviewArtifact('invalid',args,review,screen)).approved,false);
  assert.equal(screened,0);
  await assert.rejects(reviewArtifact(plot(),args,review,screen),/competition guard denied/);
  assert.equal(screened,1);assert.equal(reviews,0);
});
