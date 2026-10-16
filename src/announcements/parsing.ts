import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { GmailMessage,GmailPart } from './gmail.js';
import {sanitizeOrganizerEvidence,normalizePublicText,validatePublicUrl} from './public-facts.js';
import {sourceTimeAnchor} from './semantics.js';
export interface Evidence {id:string;text:string;locations?:string[]}
export interface ParsedMail {evidence:Evidence[];blocked:string[];sensitive:boolean;sourceTime?:number|null;incomplete?:boolean}
const decode=(text:string)=>Buffer.from(text,'base64url').toString('utf8');
export function redact(text:string){
  return sanitizeOrganizerEvidence(text);
}
function htmlText(html:string){
  let sensitive=false;
  let text=html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<!--[\s\S]*?-->/gu,'');
  const images=/<img\b/iu.test(text);
  // Process opening tags independently: an unclosed anchor must not consume later schedule text.
  text=text.replace(/<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu,tag=>{
    const href=tag.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu);
    if(!href)return ' ';
    const destination=normalizePublicText(href[1]??href[2]??href[3]??'');
    try{validatePublicUrl(destination);return ` [public link: ${destination} ] `;}
    catch{sensitive=true;return ' [private or unsafe link withheld] ';}
  });
  const malformed=/<a\b/iu.test(text);
  text=text.replace(/<\/(?:td|th)>/gi,' | ').replace(/<\/(?:tr|p|div|h[1-6])>/gi,'\n').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'');
  return {text,sensitive,images,malformed};
}
export async function parseMail(message:GmailMessage,attachment:(id:string,mime:string)=>Promise<Buffer>):Promise<ParsedMail>{
  const result:ParsedMail={evidence:[],blocked:[],sensitive:false,sourceTime:sourceTimeAnchor(message)};let nodes=0,total=0;
  const completeEvidence=new Map<string,Evidence[]>();
  const budget=(text:string)=>{total+=Buffer.byteLength(text);if(total>50000)throw new Error('Mail evidence exceeds 50 KB.');};
  const appendSafe=(id:string,text:string,locations=[id])=>{
    const normalized=text.trim().replace(/\s+/g,' ');if(!normalized)return;
    const prior=completeEvidence.get(normalized);
    if(prior){for(const [index,e] of prior.entries()){const additional=prior.length===1?locations:locations.map(location=>`${location}:chunk-${index+1}`);e.locations=[...new Set([...(e.locations??[e.id]),...additional])];}return;}
    const chunks:string[]=[];let offset=0;
    while(offset<text.length){let end=Math.min(offset+16000,text.length);
      if(end<text.length){const boundary=Math.max(text.lastIndexOf('\n',end-1),text.lastIndexOf(' ',end-1));if(boundary>offset+8000)end=boundary+1;if(end>offset&&/[\uD800-\uDBFF]/u.test(text[end-1]!))end--;}
      chunks.push(text.slice(offset,end));offset=end;
    }
    const records=chunks.map((chunk,index)=>{const suffix=chunks.length===1?'':`:chunk-${index+1}`;return {id:id+suffix,text:chunk,locations:locations.map(location=>location+suffix)};});
    result.evidence.push(...records);completeEvidence.set(normalized,records);
  };
  const add=(id:string,text:string)=>{budget(text);const safe=redact(text);result.sensitive ||=safe.sensitive;appendSafe(id,safe.text);};
  const block=(issue:string)=>{result.blocked.push(issue);result.incomplete=true;};
  const subject=message.payload?.headers?.find(h=>h.name.toLowerCase()==='subject')?.value??'';add('subject',subject);
  async function walk(part:GmailPart,path:string){
    if(++nodes>50)throw new Error('Too many MIME parts.');
    for(const [i,child] of (part.parts??[]).entries())await walk(child,`${path}.${i}`);
    const mime=part.mimeType??'',size=part.body?.size??0;if(size>5_000_000){block(`${path}: attachment exceeds 5 MB`);return;}
    if(mime.startsWith('image/')){block(`${path}: image schedule requires manual factual review; vision is not enabled`);return;}
    if(!['text/plain','text/html','application/pdf'].includes(mime)){if(part.filename)block(`${path}: unsupported attachment type`);return;}
    let data:Buffer;if(part.body?.data)data=Buffer.from(part.body.data,'base64url');else if(part.body?.attachmentId)data=await attachment(part.body.attachmentId,mime);else {if(size||part.filename)block(`${path}: missing evidence content requires manual factual review`);return;}
    if(data.length>5_000_000)throw new Error('Attachment exceeds 5 MB.');
    if(mime==='application/pdf'){
      const task=getDocument({data:new Uint8Array(data),useSystemFonts:true});
      try{const pdf=await task.promise;if(pdf.numPages>12)throw new Error('PDF exceeds 12 pages.');
        const pages:string[]=[],locations:string[]=[];
        for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n);const content=await page.getTextContent();const items=content.items.filter((i):i is typeof i & {str:string;transform:number[]}=>'str' in i);if(!items.some(i=>i.str.trim())){block(`${path}: page ${n} is scanned/image-only`);continue;}
          // Coordinates are provenance for human review, not a deterministic table interpretation.
          const text=items.map(i=>`[x=${Math.round(i.transform[4]??0)} y=${Math.round(i.transform[5]??0)} page=${n}] ${i.str}`).join('\n');budget(text+'\n');pages.push(text);locations.push(`${path}:page-${n}`);
        }
        // Redact the complete document before any chunking. A private label at a page boundary
        // still controls the value on the next page. Page locations conservatively cover the document.
        const safe=redact(pages.join('\n'));result.sensitive ||=safe.sensitive;appendSafe(`${path}:pdf`,safe.text,locations);
      }finally{await task.destroy();}
    }else if(mime==='text/html'){
      const html=htmlText(data.toString('utf8'));result.sensitive ||=html.sensitive;
      if(html.images)block(`${path}: HTML image content requires manual factual review; vision is not enabled`);
      if(html.malformed)block(`${path}: malformed hyperlink requires manual factual review`);
      add(path,html.text);
    }else add(path,decode(data.toString('base64url')));
  }
  if(message.payload)await walk(message.payload,'body');return result;
}
