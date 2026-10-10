import {publicURL,safeFetch} from './network.js';
import {subprocess} from './tools.js';
import {resolve} from 'node:path';
import {UserError,type ImageAttachment} from './types.js';
import type {ServiceConfig} from './config.js';

export const MAX_IMAGES=3,MAX_IMAGE_BYTES=2_000_000;
const mimes=new Set(['image/png','image/jpeg','image/webp']);
export function imageAttachments(value:unknown):ImageAttachment[]{
  if(!Array.isArray(value)||value.length>MAX_IMAGES)throw new UserError('i can inspect up to 3 images per request.');
  return value.map(item=>{
    if(!item||typeof item!=='object')throw new UserError('that attachment is not a supported image.');
    const {url,mime,size}=item as Record<string,unknown>;
    if(typeof url!=='string'||url.length>2000)throw new UserError('invalid image attachment URL.');
    const parsed=publicURL(url);
    if(!['cdn.discordapp.com','media.discordapp.net'].includes(parsed.hostname)||!parsed.pathname.startsWith('/attachments/'))throw new UserError('please attach the image through Discord.');
    if(typeof mime!=='string'||!mimes.has(mime))throw new UserError('please attach a PNG, JPEG, or WebP image.');
    if(typeof size!=='number'||!Number.isInteger(size)||size<1||size>MAX_IMAGE_BYTES)throw new UserError('each image needs to be under 2 MB.');
    return {url,mime,size};
  });
}
export async function prepareImage(config:ServiceConfig,image:ImageAttachment,signal:AbortSignal,download= safeFetch,decode=subprocess){
  imageAttachments([image]);
  const response=await download(image.url,AbortSignal.any([signal,AbortSignal.timeout(15000)]),MAX_IMAGE_BYTES,0,false);
  const type=response.type.split(';')[0]!.toLowerCase();
  const png=response.body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg=response.body[0]===255&&response.body[1]===216&&response.body[2]===255;
  const webp=response.body.subarray(0,4).toString()==='RIFF'&&response.body.subarray(8,12).toString()==='WEBP';
  if(response.body.length>MAX_IMAGE_BYTES||!mimes.has(type)||type!==image.mime||!(png&&type==='image/png'||jpeg&&type==='image/jpeg'||webp&&type==='image/webp'))throw new UserError('that file does not contain a supported image under 2 MB.');
  const result=JSON.parse(await decode(config.python,[resolve('python/image_worker.py')],response.body.toString('base64'),signal,10000)) as {image?:unknown};
  if(typeof result.image!=='string'||!result.image||result.image.length>2_700_000)throw new UserError('could not decode that image safely. try a smaller PNG or JPEG.');
  return {type:'image_url',image_url:{url:`data:image/jpeg;base64,${result.image}`}};
}
