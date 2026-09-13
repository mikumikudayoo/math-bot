import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFile } from 'node:fs/promises';

export async function extractPages(path: string): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: true });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
      pages.push(text); page.cleanup();
    }
    return pages;
  } finally { await task.destroy(); }
}
