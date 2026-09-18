import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { hash } from './parser.js';
import type { PdfSource, PdfPage } from './pdf.js';
import type { ParsedQuestion, QuestionCrop, CropImage } from './types.js';
const SCALE=3;
const forbidden=/\b(?:Answer\s*:|Solution\s*[:.]|ANSWER KEY|ANSWERS AND SOLUTIONS|EXPLANATION\s*:)/i;
const heading=/^(?:(?:VTAMPS|PHIMO).*\bSet\b|LOGICAL THINKING|ALGEBRA|NUMBER THEORY|GEOMETRY|COMBINATORICS|PART\s+\d+\s*:)/i;
const manualHeading=/^(?:VTAMPS|PHIMO).*\bSet\b/i;
const solutionTopic=/^(?:LOGICAL THINKING|ALGEBRA|NUMBER THEORY|GEOMETRY|COMBINATORICS|PART\s+\d+\s*:\s*.+)\s*$/i;
export const failedCrop=(reason:string):QuestionCrop=>({status:'failed',images:[],flags:[reason]});
export interface CropRegion {page:number;top:number;bottom:number}
export function cropRegions(q:ParsedQuestion,pages:PdfPage[]):CropRegion[] {
  const range=q.questionRange;
  if(!range?.separateListing || !range.end) throw new Error('crop:separate-question-listing-not-established');
  const start=range.start;const end=range.end;
  if(end.page<start.page || end.page-start.page>9) throw new Error('crop:invalid-page-range');
  const regions:CropRegion[]=[];
  for(let n=start.page;n<=end.page;n++) {
    const page=pages[n-1];if(!page || page.rotation!==0) throw new Error('crop:unsupported-page-geometry');
    const startLine=n===start.page?start.line:0;
    const stopLine=n===end.page?end.line:page.lines.length;
    if(stopLine<=startLine) continue;
    const first=page.lines[startLine];
    if(n===start.page && (!first || !new RegExp(`^\\s*${q.number}[.)]\\s`).test(first.text))) throw new Error('crop:question-anchor-mismatch');
    let top=n===start.page?Math.max(first!.top-3, ...page.lines.slice(0,startLine).filter(l=>l.bottom<=first!.top).map(l=>l.bottom+0.5)):0;
    let bottom=n===end.page?page.lines[end.line]!.top:page.height;
    // Headings before the next question, repeated footers, and solution markers
    // are hard stops. Never crop from a worked-solution listing.
    const span=page.lines.slice(startLine,stopLine);
    const stop=span.findIndex(l=>heading.test(l.text.trim())||forbidden.test(l.text));
    if(stop>=0) bottom=Math.min(bottom,span[stop]!.top);
    if(n!==start.page) {
      // A page ending the listing often starts a fresh section above the next
      // question. It contains no continuation and must not produce an image.
      const firstInk=span.find(l=>l.text.trim());
      if(!firstInk || heading.test(firstInk.text.trim()) || forbidden.test(firstInk.text)) continue;
    }
    const inside=page.lines.filter(l=>l.top<bottom && l.bottom>top && l.text.trim());
    if(inside.some(l=>forbidden.test(l.text))) throw new Error('crop:answer-marker-in-region');
    if(inside.some(l=>/^\s*\d{1,3}[.)]\s/.test(l.text) && !(n===start.page && l===first))) throw new Error('crop:ambiguous-numbered-content');
    if(!Number.isFinite(top)||!Number.isFinite(bottom)||bottom<=top) throw new Error('crop:empty-boundary');
    regions.push({page:n,top:Math.max(0,top),bottom:Math.min(page.height,bottom)});
  }
  if(!regions.length) throw new Error('crop:no-question-region');
  return regions;
}
export function solutionRegions(q:ParsedQuestion,pages:PdfPage[]):CropRegion[] {
  const range=q.solutionRange;
  if(!range || range.start.page!==q.solutionPage || !q.solutionEndPage) throw new Error('solution-crop:missing-or-inconsistent-anchors');
  const last=range.end?.page ?? q.solutionEndPage;
  if(last<range.start.page || last-range.start.page>9 || last>pages.length) throw new Error('solution-crop:invalid-page-range');
  const regions:CropRegion[]=[];
  for(let n=range.start.page;n<=last;n++) {
    const page=pages[n-1]!;
    if(page.rotation!==0) throw new Error('solution-crop:unsupported-page-geometry');
    const first=n===range.start.page ? page.lines[range.start.line] : undefined;
    if(n===range.start.page && (!first || !/^\s*Solution\s*[:.]/i.test(first.text))) throw new Error('solution-crop:marker-mismatch');
    let top=first ? Math.max(first.top-3,...page.lines.slice(0,range.start.line).filter(l=>l.bottom<=first.top).map(l=>l.bottom+0.5)) : 0;
    let bottom=range.end?.page===n ? page.lines[range.end.line]?.top : page.height;
    if(bottom===undefined) throw new Error('solution-crop:end-anchor-missing');
    // Repeated manual footers can precede a continuation. Trim only the footer,
    // never the last text line: vectors/formula descenders may extend below it.
    for(const line of page.lines) {
      if(!line.text.trim() || line.top<top || line.top>=bottom) continue;
      const trailingTopic=solutionTopic.test(line.text.trim()) && !page.lines.some(l=>l.top>line.top && l.top<bottom! && l.text.trim() && !manualHeading.test(l.text.trim()) && !solutionTopic.test(l.text.trim()));
      if(manualHeading.test(line.text.trim()) || trailingTopic) {
        if(!first && !page.lines.some(l=>l.text.trim() && l.top>=top && l.bottom<=line.top)) top=line.bottom+0.5;
        else { bottom=line.top; break; }
      }
    }
    if(bottom<=top) continue;
    if(!Number.isFinite(top)||!Number.isFinite(bottom)) throw new Error('solution-crop:invalid-boundary');
    const inside=page.lines.filter(l=>l.text.trim() && l.top>=top && l.top<bottom);
    if(inside.some(l=>/^\s*Answer\s*:/i.test(l.text))) throw new Error('solution-crop:unexpected-next-answer');
    // Numbered proof steps are allowed. A second Solution marker is not.
    if(inside.some(l=>l!==first && /^\s*Solution\s*[:.]/i.test(l.text))) throw new Error('solution-crop:multiple-solutions-in-region');
    // A continuation can contain only a diagram above the next question. Let
    // raster inspection decide whether it is empty instead of text extraction.
    regions.push({page:n,top,bottom});
  }
  if(!regions.length) throw new Error('solution-crop:empty-region');
  return regions;
}
// Raster ink bounds preserve diagrams/vectors that do not appear in text data.
// Text anchors establish hard exclusions; raster data trims whitespace within
// those exclusions and detects ink crossing a cut. Nothing outside is added.
export function inkBounds(canvas:Canvas,top:number,bottom:number):[number,number,number,number] {
  const y0=Math.max(0,Math.ceil(top)),y1=Math.min(canvas.height,Math.floor(bottom));
  if(y1<=y0) throw new Error('crop:empty-raster-region');
  const ctx=canvas.getContext('2d');const {data}=ctx.getImageData(0,y0,canvas.width,y1-y0);
  let minX=canvas.width,maxX=-1,minY=y1,maxY=-1;
  for(let y=0;y<y1-y0;y++)for(let x=0;x<canvas.width;x++) {
    const i=(y*canvas.width+x)*4;
    if(data[i+3]!>100 && Math.min(data[i]!,data[i+1]!,data[i+2]!)<225) {
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y+y0);maxY=Math.max(maxY,y+y0);
    }
  }
  if(maxX<0) throw new Error('crop:no-visible-content');
  if((y0>0 && minY<=y0+1)||(y1<canvas.height && maxY>=y1-2)) throw new Error('crop:ink-crosses-boundary:'+(minY<=y0+1?'top':'bottom'));
  const pad=18;
  const x=Math.max(0,minX-pad),y=Math.max(y0,minY-pad);
  return [x,y,Math.min(canvas.width,maxX+pad+1)-x,Math.min(y1,maxY+pad+1)-y];
}
export class QuestionRenderer {
  private cached:{page:number;canvas:Canvas}|undefined;
  constructor(private pdf:PdfSource,private directory:string){}
  private async render(n:number) {
    if(this.cached?.page===n)return this.cached.canvas;
    const page=await this.pdf.document.getPage(n);const viewport=page.getViewport({scale:SCALE});
    const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
    await page.render({canvas:null,canvasContext:canvas.getContext('2d') as unknown as CanvasRenderingContext2D,viewport,background:'white'}).promise;
    const reviewDir=resolve(dirname(this.directory),'rendered-pages');await mkdir(reviewDir,{recursive:true});
    await writeFile(resolve(reviewDir,`page-${n}.png`),canvas.toBuffer('image/png'));
    this.cached={page:n,canvas};return canvas;
  }
  async question(q:ParsedQuestion):Promise<QuestionCrop> {
    try {
      return await this.regions(cropRegions(q,this.pdf.pages),`q${q.number}`,['crop:human-completeness-and-answer-leak-review-required']);
    }catch(error){return failedCrop(error instanceof Error?error.message:'crop:render-failed');}
  }
  async solution(q:ParsedQuestion):Promise<QuestionCrop> {
    try {
      return await this.regions(solutionRegions(q,this.pdf.pages),`s${q.number}`,[],true);
    }catch(error){return failedCrop(error instanceof Error?error.message:'solution-crop:render-failed');}
  }
  private async regions(regions:CropRegion[],prefix:string,flags:string[],skipBlankContinuations=false):Promise<QuestionCrop> {
      const images:CropImage[]=[];
      await mkdir(this.directory,{recursive:true});
      for(const region of regions) {
        const canvas=await this.render(region.page);
        let bounds:[number,number,number,number];
        try { bounds=inkBounds(canvas,region.top*SCALE,region.bottom*SCALE); }
        catch(error) {
          if(skipBlankContinuations && images.length && error instanceof Error && error.message==='crop:no-visible-content') continue;
          throw error;
        }
        const [x,y,w,h]=bounds;
        const result=createCanvas(w,h);result.getContext('2d').drawImage(canvas,x,y,w,h,0,0,w,h);
        const bytes=result.toBuffer('image/png');if(bytes.length>8_000_000)throw new Error('crop:image-too-large');
        const sha256=hash(bytes);const path=resolve(this.directory,`${prefix}-${images.length+1}-${sha256.slice(0,16)}.png`);
        await writeFile(path,bytes);images.push({path,sha256,page:region.page,rect:[x/SCALE,y/SCALE,w/SCALE,h/SCALE],width:w,height:h});
      }
      return {status:'generated',images,flags};
  }
}
export function validateCrop(crop:QuestionCrop) {
  if(crop.status==='failed'||!crop.images.length||crop.images.length>10)throw new Error('A complete question crop (1–10 images) is required. Replace failed crops before approval.');
  for(const image of crop.images) {
    const bytes=readFileSync(image.path);
    if(bytes.length>8_000_000||hash(bytes)!==image.sha256)throw new Error('Crop missing, changed or oversized; replace it and review again.');
  }
}
export async function overrideImages(inputs:Uint8Array[],directory:string):Promise<QuestionCrop> {
  if(!inputs.length||inputs.length>10)throw new Error('Supply 1–10 ordered question-only images.');
  await mkdir(directory,{recursive:true});const images:CropImage[]=[];
  for(const input of inputs) {
    if(input.length>8_000_000)throw new Error('Each image must be under 8 MB.');
    const decoded=await loadImage(Buffer.from(input));
    if(decoded.width*decoded.height>30_000_000)throw new Error('Image dimensions are too large.');
    const canvas=createCanvas(decoded.width,decoded.height);canvas.getContext('2d').drawImage(decoded,0,0);
    const bytes=canvas.toBuffer('image/png');const sha256=hash(bytes);const path=resolve(directory,sha256+'.png');await writeFile(path,bytes);
    images.push({path,sha256,page:null,rect:null,width:canvas.width,height:canvas.height});
  }
  const crop:QuestionCrop={status:'override',images,flags:['crop:operator-replacement-requires-review']};validateCrop(crop);return crop;
}
