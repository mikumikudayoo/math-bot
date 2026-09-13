import { readdir, mkdir, readFile, writeFile, copyFile, realpath } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { parseManual, hash } from './parser.js';
import { extractPages } from './pdf.js';
import { QotdStore } from './store.js';

export async function pdfFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) files.push(...await pdfFiles(join(root, entry.name)));
    else if (entry.isFile() && /\.pdf$/i.test(entry.name)) files.push(join(root, entry.name));
  }
  return files;
}
export async function importFolder(store: QotdStore, root: string, assets: string, log: (line: string) => void = console.log) {
  const files = await pdfFiles(resolve(root));
  const total = { scanned: files.length, skippedFiles: 0, added: 0, duplicates: 0, near: 0, conflicts: 0, mcq: 0, open: 0, failed: 0, needsManualExtraction: 0 };
  await mkdir(assets, { recursive: true });
  assets = await realpath(assets); // Resolve shared-data symlinks so assets survive release cleanup.
  for (const path of files) {
    try {
      const bytes = await readFile(path); const source = hash(bytes);
      const directory = resolve(assets, source);
      const sourcePath = join(directory, 'source.pdf');
      if (store.source(source)) {
        // Restore retained assets if an operator moved/deleted them; never alter bank/history.
        await mkdir(directory, { recursive: true });
        await writeFile(sourcePath, bytes);
        store.addFilename(source, resolve(path)); total.skippedFiles++;
        log(`${basename(path)}: identical PDF skipped`); continue;
      }
      const pages = await extractPages(path);
      const parsed = parseManual(pages);
      await mkdir(directory, { recursive: true });
      await copyFile(path, sourcePath);
      await writeFile(join(directory, 'pages.json'), JSON.stringify(pages));
      // Full pages are private review fallbacks, never automatically posted to Discord.
      await writeFile(join(directory, 'review.json'), JSON.stringify({ source, originalFilename: basename(path), metadata: parsed.metadata,
        warnings: parsed.warnings, questions: parsed.questions.map(q => ({ number: q.number, questionPages: [q.questionPage,q.questionEndPage], solutionPages: [q.solutionPage,q.solutionEndPage], flags:q.flags,
          fallback: { type:'source-pdf-pages', asset:'source.pdf', crop:null, requiresModeratorCrop:true } })) }, null, 2));
      const result = store.import(source, resolve(path), sourcePath, pages.length, parsed);
      for (const key of ['added','duplicates','near','conflicts'] as const) total[key] += result[key];
      total.mcq += parsed.questions.filter(q=>q.kind==='mcq').length;
      total.open += parsed.questions.filter(q=>q.kind==='open').length;
      if (!parsed.questions.length) total.needsManualExtraction++;
      log(`${basename(path)}: ${parsed.metadata.title}; ${parsed.questions.length} questions (${parsed.questions.filter(q=>q.kind==='mcq').length} MCQ), ${result.added} new pending, ${result.duplicates} duplicates, ${result.near} near matches`);
      for (const warning of parsed.warnings) log(`  REVIEW: ${warning}`);
    } catch (error) { total.failed++; log(`${basename(path)}: FAILED: ${error instanceof Error ? error.message : error}`); }
  }
  log(`Summary: ${JSON.stringify(total)}. New questions require source review and approval.`);
  return total;
}
