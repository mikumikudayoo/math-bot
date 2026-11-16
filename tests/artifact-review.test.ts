import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { crc32 } from 'node:zlib';
import { inspectPlotPng, reviewArtifact } from '../src/service/artifact-review.js';

const args={expression:'x^2',min:-2,max:2};
function plot(blank=false, metadata:unknown={...args,finite:301,samples:[[-2,4],[0,0],[2,4]]}) {
  const canvas=createCanvas(100,100),ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,100,100);
  if (!blank) {
    ctx.beginPath();ctx.moveTo(0,0);
    for(let i=0;i<100;i++)ctx.lineTo(i,90-80*((i-50)/50)**2);
    ctx.stroke();
  }
  const png=canvas.toBuffer('image/png');
  const type=Buffer.from('tEXt'),value=Buffer.from('AlephPlot\0'+JSON.stringify(metadata)), chunk=Buffer.alloc(12+value.length);
  chunk.writeUInt32BE(value.length);type.copy(chunk,4);value.copy(chunk,8);chunk.writeUInt32BE(crc32(Buffer.concat([type,value])),chunk.length-4);
  return Buffer.concat([png.subarray(0,33),chunk,png.subarray(33)]).toString('base64');
}
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
