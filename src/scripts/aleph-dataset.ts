import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generate, jsonl, splitReviewed, validateJSONL, type Scenario } from '../training/aleph.js';

const root=resolve('training/aleph');
async function main() {
  const action=process.argv[2];
  if(action==='generate') {
    const scenarios=JSON.parse(await readFile(resolve(root,'scenarios.json'),'utf8')) as Scenario[];
    const text=jsonl(generate(scenarios)),checked=validateJSONL(text);
    if(checked.errors.length)throw new Error(checked.errors.join('\n'));
    await writeFile(resolve(root,'generated.jsonl'),text);
    console.log(`wrote ${checked.rows.length} synthetic candidates; none are human-reviewed. reviewed.jsonl was not modified.`);
  } else if(action==='validate') {
    const path=resolve(process.argv[3]??resolve(root,'reviewed.jsonl'));
    const checked=validateJSONL(await readFile(path,'utf8'),!process.argv.includes('--candidates'));
    if(!checked.rows.length)throw new Error('Dataset is empty. Review candidates first.');
    if(checked.errors.length)throw new Error(checked.errors.join('\n'));
    console.log(`${checked.rows.length} examples pass structural/heuristic validation; human semantic review is still required.`);
  } else if(action==='split') {
    const result=splitReviewed(await readFile(resolve(root,'reviewed.jsonl'),'utf8'));
    // Complete validation before writing either partition. Never use these files without the manifest.
    await mkdir(root,{recursive:true});
    await writeFile(resolve(root,'train.jsonl'),jsonl(result.train));
    await writeFile(resolve(root,'holdout.jsonl'),jsonl(result.holdout));
    await writeFile(resolve(root,'split-manifest.json'),JSON.stringify(result.manifest,null,2)+'\n');
    console.log(`${result.train.length} train / ${result.holdout.length} holdout. No training was run.`);
  } else throw new Error('Use generate, validate [file] [--candidates], or split.');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Dataset task failed.');process.exitCode=1;});
