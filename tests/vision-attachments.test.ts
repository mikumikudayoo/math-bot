import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {prepareImage,imageAttachments} from '../src/service/vision.js';
import {Store} from '../src/service/store.js';
import {runner} from '../src/service/inference.js';
import type {ServiceConfig} from '../src/service/config.js';
const c:ServiceConfig={mode:'development',secret:'fixture',port:8787,database:':memory:',concurrency:1,reserved:0,borrow:false,timeoutMs:10000,maxQueue:20,backend:'http://127.0.0.1:8082/v1',model:'phi',backendKey:'',vision:false,nativeTools:false,python:'python3',searchKey:'',sandbox:false,sandboxImage:'unused',visionProvider:{backend:'https://api.groq.com/openai/v1',model:'qwen/qwen3.8-27b',backendKey:'fixture',nativeTools:true,vision:true}};
const generated=spawnSync('python3',['-c',`from PIL import Image,ImageDraw
import io,base64,json
im=Image.new('RGB',(200,120),'white');d=ImageDraw.Draw(im);d.polygon([(20,100),(180,100),(100,10)],outline='black');d.ellipse((90,65,110,85),fill='blue');d.text((20,5),'x + 2 = 5',fill='black')
out={}
for fmt in ['PNG','JPEG','WEBP']:
 b=io.BytesIO();im.save(b,format=fmt);out[fmt]=base64.b64encode(b.getvalue()).decode()
print(json.dumps(out))`],{encoding:'utf8'});
assert.equal(generated.status,0,generated.stderr);
const fixtures=JSON.parse(generated.stdout) as Record<string,string>;
const url='https://cdn.discordapp.com/attachments/123456789012345678/223456789012345678/misleading-filename.jpeg';
for(const [format,mime] of [['PNG','image/png'],['JPEG','image/jpeg'],['WEBP','image/webp']] as const)test(`real ${format} bytes survive bounded decoder and reach vision with text`,async()=>{
 const body=Buffer.from(fixtures[format]!,'base64');const image={url,mime,size:body.length};const s=new Store(':memory:');let inspected=0;try{const j=s.admit({id:'1',guild:'g',channel:'c',user:'u',kind:'ask',coach:false,prompt:'solve the equation beside the triangle',images:JSON.stringify(imageAttachments([image]))},20);
 const r=await runner(c,s,{route:async()=>({reasoning:'fast',knowledge:'internal',tool:'none'}),prepareImage:async(config,a,signal)=>prepareImage(config,a,signal,async()=>({body,type:mime,url})),complete:async(_u,init)=>{const request=JSON.parse(String(init.body));assert.equal(request.model,'qwen/qwen3.8-27b');const message=request.messages.find((m:any)=>Array.isArray(m.content));assert.equal(message.content[0].text,j.prompt);const pixels=message.content[1].image_url.url;assert.ok(pixels.startsWith('data:image/jpeg;base64,/9j/'));assert.ok(Buffer.from(pixels.split(',')[1],'base64').length>500);inspected++;return Response.json({choices:[{message:{content:'x = 3; the blue dot is inside the triangle.'}}]});}})(j,AbortSignal.timeout(10000),()=>{});assert.equal(inspected,1);assert.match(r.answer,/x = 3/);
 }finally{s.close();}
});
test('Discord WebP metadata with CDN PNG transcode is accepted after actual MIME/magic validation',async()=>{
 const body=Buffer.from(fixtures.PNG!,'base64');const pixels=await prepareImage(c,{url,mime:'image/webp',size:16472},AbortSignal.timeout(10000),async()=>({url,type:'image/png',body}));assert.ok(pixels.image_url.url.startsWith('data:image/jpeg;base64,/9j/'));
});
test('filename does not establish format; false served MIME and invalid pixels still fail',async()=>{
 const body=Buffer.from(fixtures.PNG!,'base64'),image={url,mime:'image/png',size:body.length};await assert.rejects(prepareImage(c,image,AbortSignal.timeout(1000),async()=>({url,type:'image/jpeg',body})));await assert.rejects(prepareImage(c,image,AbortSignal.timeout(1000),async()=>({url,type:'text/html',body})));await assert.rejects(prepareImage(c,image,AbortSignal.timeout(1000),async()=>({url,type:'image/png',body:Buffer.from('not an image')})));assert.throws(()=>imageAttachments([{...image,size:2_000_001}]));await assert.rejects(prepareImage(c,image,AbortSignal.timeout(1000),async()=>({url,type:'image/png',body:Buffer.alloc(2_000_001)})));
});
