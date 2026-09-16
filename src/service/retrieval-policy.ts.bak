/** Host policy: model output cannot relax these requirements. */
export interface RetrievalPolicy { required: boolean; exhaustive: boolean; entities: string[]; query: string; reason: string }
const questionWords = new Set(['What','Who','When','Where','Why','How','Which','Describe','Explain','Tell','List','Give','Find','Search','Verify','Please','Is','Are','Does','Do','Can','Could','Would','The','A','An','I']);
const timeless = /^(?:(?:please\s+)?(?:explain|define|what (?:is|are))\s+(?:the\s+)?(?:photosynthesis|gravity|a prime number|prime numbers|a noun|a verb|the pythagorean theorem|pythagoras'? theorem|fractions|quadratic equations|a triangle|an atom|water cycle)[?.!]*|(?:hi|hello|hey|thanks|thank you|good morning|good evening)[!. ]*|(?:who (?:are you|made you|created you)|what(?:'s| is) your (?:name|dream)|tell me about yourself)[?.!]*|[\d\s()+*/.^%=-]+)$/i;

export function namedEntities(prompt: string): string[] {
  const names = [...prompt.matchAll(/["“]([^"”\n]{2,120})["”]/g)].map(m=>m[1]!);
  for(const match of prompt.matchAll(/\b[A-Z][\p{L}\d'-]*(?:\s+(?:(?:of|the|and|de|van)\s+)?[A-Z][\p{L}\d'-]*)*/gu)) {
    const words=match[0].split(/\s+/);while(words.length&&questionWords.has(words[0]!))words.shift();
    const name=words.join(' ').replace(/['’]s$/,'');if(name&&name.length>1)names.push(name);
  }
  // Preserve lowercase unfamiliar entities too, without spelling correction.
  const subject=prompt.match(/^(?:what is|who is|tell me about|describe)\s+(.+?)(?:\s+(?:situation|currently|today|in the|in)\b|[?.!]|$)/i)?.[1]?.trim();
  if(subject&&!/^(?:all|every|a |an |the |your |my |this |that )/i.test(subject)&&!names.some(n=>subject.includes(n)))names.push(subject);
  return [...new Set(names)].slice(0,6);
}
export function retrievalPolicy(prompt:string):RetrievalPolicy {
  const exhaustive=/\b(all|every|complete list|exhaustive|including non[- ]?canon|non[- ]?canonical)\b/i.test(prompt);
  const math=/\b(solve|calculate|equation|integer|polynomial|prove|proof|pairs|pigeonhole|stuffed toys|differentiate|integrate)\b/i.test(prompt);
  const explicit=/\b(search|look up|verify|sources?|citations?|fact[- ]?check)\b/i.test(prompt);
  const current=/\b(latest|today|currently|current|recent|news|situation|now|this (?:week|month|year)|price|weather|schedule|election|president|CEO)\b/i.test(prompt);
  const factual=/\b(who|when|where|which|voice|creator|founded|released|statistics|population|difficulties|lore|noncanon|location)\b/i.test(prompt)||/^(?:what (?:is|are)|tell me about|describe|list)\b/i.test(prompt);
  const entities=namedEntities(prompt);
  const safe=timeless.test(prompt.trim());
  const required=explicit||(!safe&&(current||(!math&&(exhaustive||factual||entities.length>0))));
  const protectedNames=entities;
  // Include exact quoted names first so query truncation never loses them.
  const exact=protectedNames.map(name=>`"${name.replace(/"/g,'')}"`).join(' ');
  const query=(exact?`${exact} `:'')+prompt.slice(0,Math.max(0,499-exact.length));
  return {required,exhaustive:exhaustive&&!math,entities:protectedNames,query,reason:explicit?'explicit verification':current?'time-sensitive facts':exhaustive&&!math?'exhaustive factual request':required?'specific or unfamiliar factual subject':'timeless/conversation/math'};
}
export function expressesUncertainty(answer:string) {
  return /\b(not sure|uncertain|unfamiliar|might (?:be|refer)|may refer|perhaps|I (?:think|believe|guess)|cannot confirm|can't confirm|don't know|do not know)\b/i.test(answer);
}
export interface Evidence { id:number; url:string; text:string }
export function establishesEntities(evidence:Evidence[],entities:string[]) {
  const normalize=(text:string)=>text.toLocaleLowerCase().replace(/\s+/g,' ').trim();
  return entities.every(entity=>evidence.some(e=>normalize(e.text).includes(normalize(entity))));
}
export const UNVERIFIED = "I couldn't verify this from the available sources, so I won't guess. Please share a reliable source or clarify the exact name.";

/** Render only exact, traceable evidence selections. Free model prose/URLs cannot escape this boundary. */
export function groundedAnswer(value:unknown,evidence:Evidence[],policy:RetrievalPolicy):string|null {
  if(!value||typeof value!=='object')return null;
  const result=value as {insufficient?:unknown;claims?:unknown};
  if(result.insufficient===true)return UNVERIFIED;
  if(!Array.isArray(result.claims)||!result.claims.length||result.claims.length>6)return null;
  const lines:string[]=[];const excerpts:Evidence[]=[];
  for(const claim of result.claims){
    if(!claim||typeof claim!=='object')return null;
    const {source,quote}=claim as {source:unknown;quote:unknown};
    const item=evidence.find(e=>e.id===source);
    if(!item||typeof quote!=='string'||quote.length<15||quote.length>600||!item.text.includes(quote))return null;
    // URLs come from the host ledger only, never from the model's quoted text.
    if(/https?:\/\/|www\./i.test(quote))return null;
    excerpts.push({id:item.id,url:item.url,text:quote});
    lines.push(`> ${quote.replace(/\n/g,' ').replace(/[<>]/g,'')}\n[Source ${item.id}](<${item.url}>)`);
  }
  if(!establishesEntities(excerpts,policy.entities))return null;
  return `Here's what I could verify in the retrieved sources:\n\n${[...new Set(lines)].join('\n\n')}`+
    (policy.exhaustive?"\n\nThis is a verified subset, not a guaranteed complete list—especially for unofficial or noncanon entries.":'')+
    '\n\nThese are source excerpts; gaps or disagreements remain unresolved.';
}
