import { getDocument, Util, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFile } from 'node:fs/promises';
export interface PdfLine { text: string; top: number; bottom: number; left: number; right: number }
export interface PdfPage { text: string; lines: PdfLine[]; width: number; height: number; rotation: number }
export interface PdfSource { document: PDFDocumentProxy; pages: PdfPage[]; close(): Promise<void> }
export async function openPdf(path: string): Promise<PdfSource> {
  const task = getDocument({data:new Uint8Array(await readFile(path)),useSystemFonts:true});
  try {
    const document=await task.promise; const pages: PdfPage[]=[];
    for(let n=1;n<=document.numPages;n++) {
      const page=await document.getPage(n); const viewport=page.getViewport({scale:1});
      const content=await page.getTextContent(); const lines:PdfLine[]=[];
      let line:PdfLine={text:'',top:Infinity,bottom:0,left:Infinity,right:0};
      for(const item of content.items) if('str' in item) {
        const t=Util.transform(viewport.transform,item.transform);
        const height=Math.hypot(t[2]!,t[3]!);
        line.text+=item.str+(item.hasEOL?'':' ');
        if(item.str.trim()) {line.top=Math.min(line.top,t[5]!-height);line.bottom=Math.max(line.bottom,t[5]!+height*0.2);line.left=Math.min(line.left,t[4]!);line.right=Math.max(line.right,t[4]!+item.width);}
        if(item.hasEOL) {lines.push(line);line={text:'',top:Infinity,bottom:0,left:Infinity,right:0};}
      }
      lines.push(line);
      pages.push({text:lines.map(l=>l.text).join('\n'),lines,width:viewport.width,height:viewport.height,rotation:page.rotate});
    }
    return {document,pages,close:()=>task.destroy()};
  } catch(error) {await task.destroy();throw error;}
}
export async function extractPages(path:string) {const pdf=await openPdf(path);try{return pdf.pages.map(p=>p.text);}finally{await pdf.close();}}
