import { createCanvas } from '@napi-rs/canvas';
import { crc32 } from 'node:zlib';

export const fixturePlotArgs = {expression:'x^2',min:-2,max:2};
export function fixturePlot(blank=false, metadata:unknown={...fixturePlotArgs,finite:301,samples:[[-2,4],[0,0],[2,4]]}) {
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
