/** Complete multipartite matching bound: min(floor(n/2), n - largest group). */
export function maximumDifferentPairs(counts:readonly number[]) {
  const total=counts.reduce((a,b)=>a+b,0);return Math.min(Math.floor(total/2),total-Math.max(0,...counts));
}
export function pairingCertificate(stock:readonly number[],pairs:number) {
  if(stock.length<2||stock.some(x=>!Number.isSafeInteger(x)||x<0)||!Number.isSafeInteger(pairs)||pairs<1||maximumDifferentPairs(stock)<pairs)throw new Error('Invalid or insufficient inventory.');
  const largest=Math.max(...stock),threshold=Math.max(2*pairs,largest+pairs);
  let remaining=threshold-1;
  const bad=stock.map(()=>0);
  for(const i of stock.map((_,i)=>i).sort((a,b)=>stock[b]!-stock[a]!)){bad[i]=Math.min(stock[i]!,remaining);remaining-=bad[i]!;}
  return {threshold,bad,largest,pairs,minimumOther:threshold-largest,minimumLargest:Math.ceil(threshold/stock.length)};
}
export function verifyPairingCertificate(stock:readonly number[],certificate:ReturnType<typeof pairingCertificate>) {
  const {threshold,bad,pairs}=certificate;
  return bad.length===stock.length&&bad.every((x,i)=>x>=0&&x<=stock[i]!)&&bad.reduce((a,b)=>a+b,0)===threshold-1&&
    maximumDifferentPairs(bad)<pairs&&Math.floor(threshold/2)>=pairs&&threshold-Math.max(...stock)>=pairs&&
    certificate.minimumOther===threshold-Math.max(...stock)&&certificate.largest===Math.max(...stock)&&
    certificate.minimumLargest===Math.ceil(threshold/stock.length);
}
/** Deliberately narrow grammar; unfamiliar variants go to the normal tutor, never a guessed formula. */
export function solvePairingPrompt(prompt:string):string|null {
  const match=prompt.match(/^There are (\d+) ([\p{L}-]+), (\d+) ([\p{L}-]+), and (\d+) ([\p{L}-]+) stuffed toys mixed together\. If you want to get (\d+) pairs of stuffed toys, with each pair consisting of two different characters, at least how many stuffed toys must be taken\?$/iu);
  if(!match)return null;
  const stock=[Number(match[1]),Number(match[3]),Number(match[5])],names=[match[2]!,match[4]!,match[6]!];
  const proof=pairingCertificate(stock,Number(match[7]));if(!verifyPairingCertificate(stock,proof))throw new Error('Pairing verification failed.');
  const bad=proof.bad.map((n,i)=>`${n} ${names[i]}`).join(', ');
  return `${proof.threshold} toys are necessary and sufficient.\n\n`+
    `${proof.threshold-1} can fail: select ${bad}. This selection permits only ${maximumDifferentPairs(proof.bad)} disjoint different-character pairs.\n\n`+
    `For any ${proof.threshold} selected toys, the largest selected character group has at most ${proof.largest}, leaving at least ${proof.minimumOther} outside it. `+
    (proof.minimumLargest>=proof.pairs?`The largest selected group has at least ceil(${proof.threshold}/${stock.length}) = ${proof.minimumLargest} toys, so pair ${proof.pairs} of its toys with ${proof.pairs} distinct toys outside it. `:
      `The maximum number of different-character pairs is min(floor(n/2), n − largest group), and both bounds are at least ${proof.pairs}. `)+
    `Thus ${proof.threshold} guarantees ${proof.pairs} disjoint pairs.`;
}
