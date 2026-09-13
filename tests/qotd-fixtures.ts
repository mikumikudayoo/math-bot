// Original synthetic examples, intentionally not copied from the source manuals.
export const phimo = [
`PART 1: MULTIPLE CHOICE
1. A robot chooses one of three doors. Which door is marked green?
a. Red door b. Green door c. Blue door
PART 2: OPEN-ENDED
2. A bag holds 12 cubes. Two are removed. How many remain?
VTAMPS PHIMO FRR 26 Secondary 3 Set 7`,
`PART 1: MULTIPLE CHOICE
1. A robot chooses one of three doors. Which door is marked green?
a. Red door b. Green door c. Blue door
Answer: B
Solution: The second door is green.
PART 2: OPEN-ENDED
2. A bag holds 12 cubes. Two are removed. How many remain?
Answer:  10${'  '}
Solution:  Subtract the two removed cubes.
1. First count all cubes.
2. Then remove two cubes.
VTAMPS PHIMO FRR 26 Secondary 3 Set 7`,
`The result remains 10.
VTAMPS PHIMO FRR 26 Secondary 3 Set 7`,
];
export const vtamps = (edition = '24') => [
`LOGICAL THINKING
1. A clock advances by three hours from noon. What hour is shown?
ALGEBRA
2. Find x when x + 7 = 12.
VTAMPS ${edition} Senior Secondary Set 9`,
`LOGICAL THINKING
1. A clock advances by three hours from noon. What hour is shown?
Answer: 3
Solution. Advance three hours.
ALGEBRA
2. Find x when x + 7 = 12.
Answer: 99
Solution. Official synthetic text: deliberately inconsistent; do not correct.
VTAMPS ${edition} Senior Secondary Set 9`,
];

// Minimal, valid, text-only PDFs created from our own fixture strings at test time.
export function syntheticPdf(pages: string[], decorations: string[] = []): Buffer {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const [pageIndex,text] of pages.entries()) {
    const page = objects.length + 1; kids.push(page);
    const stream = 'BT /F1 11 Tf 14 TL 30 760 Td ' + text.split('\n').map((line,i)=>(i?'T* ':'')+'('+line.replace(/[\\()]/g,'\\$&')+') Tj').join('\n')+' ET\n'+(decorations[pageIndex]??'');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page+1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map(n=>`${n} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [i,object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i+1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n` + offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
