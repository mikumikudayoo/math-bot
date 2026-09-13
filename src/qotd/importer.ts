import { readdir, mkdir, readFile, writeFile, copyFile, realpath } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { parseManual, hash } from './parser.js';
import { openPdf } from './pdf.js';
import { QuestionRenderer } from './crops.js';
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
  const total = { scanned: files.length, skippedFiles: 0, added: 0, duplicates: 0, near: 0, conflicts: 0, mcq: 0, open: 0, failed: 0, needsManualExtraction: 0, crops: 0, cropFailures: 0, cropImages: 0 };
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
      const pdf = await openPdf(path);
      const pages = pdf.pages.map(p=>p.text);
      const parsed = parseManual(pages);
      const renderer = new QuestionRenderer(pdf, resolve(directory,'crops'));
      try {
        for (const question of parsed.questions) {
          question.crop = await renderer.question(question);
          if (question.crop.status === 'generated') { total.crops++; total.cropImages+=question.crop.images.length; }
          else { total.cropFailures++; log(`${basename(path)} #${question.number}: CROP REVIEW ${question.crop.flags.join('; ')}`); }
        }
      } finally { await pdf.close(); }
      await mkdir(directory, { recursive: true });
      await copyFile(path, sourcePath);
      await writeFile(join(directory, 'pages.json'), JSON.stringify(pages));
      // Full pages remain private; only reviewed question crops can be posted.
      await writeFile(join(directory, 'review.json'), JSON.stringify({ source, originalFilename: basename(path), metadata: parsed.metadata,
        warnings: parsed.warnings, questions: parsed.questions.map(q => ({ number: q.number, questionPages: [q.questionPage,q.questionEndPage], solutionPages: [q.solutionPage,q.solutionEndPage], flags:q.flags,
          crop: q.crop })) }, null, 2));
      const result = store.import(source, resolve(path), sourcePath, pages.length, parsed);
      for (const key of ['added','duplicates','near','conflicts'] as const) total[key] += result[key];
      total.mcq += parsed.questions.filter(q=>q.kind==='mcq').length;
      total.open += parsed.questions.filter(q=>q.kind==='open').length;
      if (!parsed.questions.length) total.needsManualExtraction++;
      log(`${basename(path)}: ${parsed.metadata.title}; ${parsed.questions.length} questions (${parsed.questions.filter(q=>q.kind==='mcq').length} MCQ), ${result.added} new pending, ${result.duplicates} duplicates, ${result.near} near matches`);
      for (const warning of parsed.warnings) log(`  REVIEW: ${warning}`);
    } catch (error) { total.failed++; log(`${basename(path)}: FAILED: ${error instanceof Error ? error.message : error}`); }
  }
  const bank=store.list('pending',1_000_000).concat(store.list('approved',1_000_000),store.list('rejected',1_000_000));
  const result={...total,pending:bank.filter(q=>q.state==='pending').length,bankQuestions:bank.length,bankMcq:bank.filter(q=>q.kind==='mcq').length,bankOpen:bank.filter(q=>q.kind==='open').length,bankCrops:bank.filter(q=>q.crop.status!=='failed').length,bankCropFailures:bank.filter(q=>q.crop.status==='failed').length};
  log(`Summary: ${JSON.stringify(result)}. New questions require source review and approval.`);
  return result;
}
