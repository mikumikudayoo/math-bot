import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMail} from '../src/announcements/parsing.js';
import type {GmailPart} from '../src/announcements/gmail.js';

const part=(text:string,mimeType='text/plain'):GmailPart=>({mimeType,body:{data:Buffer.from(text).toString('base64url')}});
const parse=(payload:GmailPart)=>parseMail({id:'synthetic-message-never-a-location',payload},async()=>{throw new Error('Unexpected attachment retrieval.');});
function syntheticPdf(pages:string[][]):Buffer {
  const font=3+pages.length*2,objects:string[]=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_,i)=>`${3+i*2} 0 R`).join(' ')}] >>`];
  for(const [i,lines] of pages.entries()){
    const stream='BT /F1 12 Tf 50 750 Td '+lines.map((line,index)=>(index?'0 -20 Td ':'')+'('+line.replace(/[\\()]/gu,'\\$&')+') Tj').join('\n')+' ET';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4+i*2} 0 R >>`,`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf='%PDF-1.4\n';const offsets=[0];for(const [i,object] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test('late availability qualifiers survive bounded stable chunks with no silent clipping',async()=>{
  const text='VTAMPS V.30.0 public materials notice.\n'+'General public schedule information. '.repeat(550)+'\nThe folders are EMPTY. Materials will be uploaded tomorrow afternoon.';
  const result=await parse(part(text));assert.ok(result.evidence.length>1);assert.equal(result.evidence.map(e=>e.text).join(''),text);
  assert.ok(result.evidence.every(e=>e.text.length<=16000));assert.match(result.evidence.at(-1)!.text,/EMPTY[\s\S]*tomorrow afternoon/u);
  assert.deepEqual(result.evidence.map(e=>e.id),result.evidence.map((_,i)=>`body:chunk-${i+1}`));assert.equal(result.incomplete,undefined);
});

test('privacy redaction occurs before chunking even when a sensitive label crosses the former 16k boundary',async()=>{
  const text='Public schedule note. '.repeat(760)+'\nCandidate ID:\nTEST-CANDIDATE-12345\nPIN:\nTEST-PIN-9876\nTraining schedule\nSession 2: January 15, 2030, 1 PM Asia/Manila';
  const result=await parse(part(text)),serialized=JSON.stringify(result);
  assert.equal(serialized.includes('TEST-CANDIDATE-12345'),false);assert.equal(serialized.includes('TEST-PIN-9876'),false);assert.ok(serialized.includes('Session 2:'));assert.equal(result.sensitive,true);
});

test('equivalent MIME evidence deduplicates while retaining all host-generated provenance locations',async()=>{
  const text='VTAMPS V.30.0 schedule\nSession 1: January 2, 2030, 9 AM Asia/Manila';
  const result=await parse({mimeType:'multipart/alternative',parts:[part(text),part('<p>VTAMPS V.30.0 schedule</p><p>Session 1: January 2, 2030, 9 AM Asia/Manila</p>','text/html')]});
  assert.equal(result.evidence.length,1);assert.deepEqual(result.evidence[0]!.locations,['body.0','body.1']);assert.equal(JSON.stringify(result.evidence).includes('synthetic-message-never-a-location'),false);
});

test('HTML links retain safe destinations and withhold credential/path-token destinations under the shared URL policy',async()=>{
  const html='<p>VTAMPS V.30.0</p><a href="https://example.org/resources/vtamps">Register here</a><a href="https://example.invalid/candidate/TEST-CANDIDATE-12345">Private participant link</a><a href="https://example.org/resources?token=TEST-TOKEN-12345">Private token link</a><a href="javascript:alert(1)">Bad link</a>';
  const result=await parse(part(html,'text/html')),text=result.evidence.map(e=>e.text).join('\n');
  assert.ok(text.includes('Register here'));assert.ok(text.includes('https://example.org/resources/vtamps'));assert.ok(text.includes('private or unsafe link withheld'));
  for(const secret of ['TEST-CANDIDATE-12345','TEST-TOKEN-12345','javascript:alert'])assert.equal(text.includes(secret),false);
  assert.equal(result.sensitive,true);
});

test('encoded HTML hrefs follow identical public URL checks and hidden script content is excluded',async()=>{
  const result=await parse(part('<script>Candidate ID: TEST-CANDIDATE-12345</script><a href="https&#58;//example.org/resources/vtamps">Resource</a><a href="https://example.org/%63andidate/TEST-CANDIDATE-12345">Personal</a>','text/html'));
  const text=result.evidence.map(e=>e.text).join('\n');assert.ok(text.includes('https://example.org/resources/vtamps'));assert.equal(text.includes('TEST-CANDIDATE-12345'),false);
});

test('unclosed HTML anchors preserve following text and image/malformed evidence is explicitly incomplete',async()=>{
  const open=await parse(part('<a href="https://example.org/resources/vtamps">Register here<p>Materials are empty until tomorrow.</p>','text/html'));
  assert.ok(open.evidence[0]!.text.includes('Materials are empty until tomorrow.'));
  const incomplete=await parse(part('<p>VTAMPS V.30.0 replacement schedule</p><img src="https://example.org/schedule.png"><a href="broken>Timetable','text/html'));
  assert.equal(incomplete.incomplete,true);assert.ok(incomplete.blocked.some(issue=>issue.includes('image')));assert.ok(incomplete.blocked.some(issue=>issue.includes('malformed')));
});

test('PDF coordinates and page provenance survive while cross-page private values are redacted',async()=>{
  const bytes=syntheticPdf([['TIMO 2030 Heat Round schedule','Candidate ID:'],['TEST-CANDIDATE-12345','Exam start: 9 AM Asia/Manila']]);
  const result=await parse({mimeType:'application/pdf',body:{data:bytes.toString('base64url')}}),text=result.evidence.map(e=>e.text).join('\n');
  assert.equal(text.includes('TEST-CANDIDATE-12345'),false);assert.ok(text.includes('Exam start: 9 AM'));assert.match(text,/\[x=\d+ y=\d+ page=2\]/u);assert.deepEqual(result.evidence[0]!.locations,['body:page-1','body:page-2']);
});

test('scanned PDFs and images remain incomplete without vision or image attachment retrieval',async()=>{
  const bytes=syntheticPdf([[]]),pdf=await parse({mimeType:'application/pdf',body:{data:bytes.toString('base64url')}});
  assert.equal(pdf.incomplete,true);assert.ok(pdf.blocked.some(issue=>issue.includes('scanned/image-only')));
  const image=await parse({mimeType:'image/png',filename:'replacement.png',body:{attachmentId:'private-attachment-id'}});assert.equal(image.incomplete,true);assert.equal(JSON.stringify(image).includes('private-attachment-id'),false);
});

test('original MIME, attachment, PDF page, and evidence budgets still fail closed',async()=>{
  await assert.rejects(()=>parse(part('x'.repeat(50001))),/50 KB/u);
  await assert.rejects(()=>parse({mimeType:'multipart/mixed',parts:Array.from({length:50},()=>part('public schedule'))}),/MIME parts/u);
  const oversized=await parse({mimeType:'application/pdf',filename:'schedule.pdf',body:{size:5000001,attachmentId:'not-read'}});assert.equal(oversized.incomplete,true);assert.match(oversized.blocked[0]!,/5 MB/u);
  const bytes=syntheticPdf(Array.from({length:13},()=>['Public schedule']));await assert.rejects(()=>parse({mimeType:'application/pdf',body:{data:bytes.toString('base64url')}}),/12 pages/u);
  const missing=await parse({mimeType:'text/plain',body:{size:40}});assert.equal(missing.incomplete,true);assert.match(missing.blocked[0]!,/missing evidence/u);
});
