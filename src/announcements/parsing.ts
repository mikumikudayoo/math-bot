import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { GmailMessage,GmailPart } from './gmail.js';
export interface Evidence {id:string;text:string}
export interface ParsedMail {evidence:Evidence[];blocked:string[];sensitive:boolean}
const decode=(text:string)=>Buffer.from(text,'base64url').toString('utf8');
export function redact(text:string){
  const sensitive=/\b(?:password|passcode|credential|access token|secret|login id|username)\b|https?:\/\/\S*[?&](?:token|key|code|auth|password)=/i.test(text);
  if(sensitive){const competition=text.match(/\b(TIMO|HKIMO|BBB|PhIMO)\b/i)?.[1]??'mathematics competition';const year=text.match(/\b20\d\d\b/)?.[0]??'';const round=text.match(/\b(?:heat|final) round\b/i)?.[0]??'';return {text:`${competition} ${year} ${round}: login-details notice; credential content withheld; participants should check their own email`,sensitive:true};}
  return {text:text.replace(/https?:\/\/[^\s<>"']+/g,url=>{try{const u=new URL(url);return u.search||u.username||u.password?'[private or parameterized link withheld]':url;}catch{return '[invalid link]';}}),sensitive:false};
}
function htmlText(html:string){
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<\/(?:td|th)>/gi,' | ').replace(/<\/(?:tr|p|div|h[1-6])>/gi,'\n').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n:string)=>String.fromCodePoint(Math.min(Number(n),0x10ffff)));
}
export async function parseMail(message:GmailMessage,attachment:(id:string,mime:string)=>Promise<Buffer>):Promise<ParsedMail>{
  const result:ParsedMail={evidence:[],blocked:[],sensitive:false};let nodes=0,total=0;
  const add=(id:string,text:string)=>{total+=Buffer.byteLength(text);if(total>50000)throw new Error('Mail evidence exceeds 50 KB.');const safe=redact(text);result.sensitive ||=safe.sensitive;if(safe.text.trim())result.evidence.push({id,text:safe.text.slice(0,16000)});};
  const subject=message.payload?.headers?.find(h=>h.name.toLowerCase()==='subject')?.value??'';add('subject',subject);
  async function walk(part:GmailPart,path:string){
    if(++nodes>50)throw new Error('Too many MIME parts.');
    for(const [i,child] of (part.parts??[]).entries())await walk(child,`${path}.${i}`);
    const mime=part.mimeType??'',size=part.body?.size??0;if(size>5_000_000){result.blocked.push(`${path}: attachment exceeds 5 MB`);return;}
    if(mime.startsWith('image/')){result.blocked.push(`${path}: image schedule requires manual factual review; vision is not enabled`);return;}
    if(!['text/plain','text/html','application/pdf'].includes(mime)){if(part.filename)result.blocked.push(`${path}: unsupported attachment type`);return;}
    let data:Buffer;if(part.body?.data)data=Buffer.from(part.body.data,'base64url');else if(part.body?.attachmentId)data=await attachment(part.body.attachmentId,mime);else return;
    if(data.length>5_000_000)throw new Error('Attachment exceeds 5 MB.');
    if(mime==='application/pdf'){
      const task=getDocument({data:new Uint8Array(data),useSystemFonts:true});
      try{const pdf=await task.promise;if(pdf.numPages>12)throw new Error('PDF exceeds 12 pages.');
        for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n);const content=await page.getTextContent();const items=content.items.filter((i):i is typeof i & {str:string;transform:number[]}=>'str' in i);if(!items.some(i=>i.str.trim())){result.blocked.push(`${path}: page ${n} is scanned/image-only`);continue;}
          // Explicit coordinates preserve row/column association rather than flattening tables.
          add(`${path}:page-${n}`,items.map(i=>`[x=${Math.round(i.transform[4]??0)} y=${Math.round(i.transform[5]??0)}] ${i.str}`).join('\n'));
        }
      }finally{await task.destroy();}
    }else add(path,mime==='text/html'?htmlText(data.toString('utf8')):decode(data.toString('base64url')));
  }
  if(message.payload)await walk(message.payload,'body');return result;
}
