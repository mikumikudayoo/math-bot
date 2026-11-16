export interface NormalizedText { original: string; clean: string; skeleton: string; compact: string; changed: boolean }
// Deliberately small, auditable Latin-lookalike map. Other scripts remain text.
const confusables: Record<string,string> = { 'а':'a','е':'e','о':'o','р':'p','с':'c','х':'x','у':'y','і':'i','ј':'j','Α':'a','Β':'b','Ε':'e','Ι':'i','Κ':'k','Μ':'m','Ν':'n','Ο':'o','Ρ':'p','Τ':'t','Χ':'x','ο':'o','ρ':'p','ι':'i' };
export function normalizeText(original: string): NormalizedText {
  const clean=original.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').toLowerCase().replace(/\s+/gu,' ').trim();
  const skeleton=[...clean].map(c=>confusables[c]??c).join('');
  // Used only by an explicitly obfuscation-enabled rule, at reduced confidence.
  const compact=skeleton.replace(/(?<=[a-z])(?:[\s._-])(?=[a-z])/g,'').replace(/(?<=[a-z])(?:[\s._-])(?=[a-z])/g,'');
  return {original,clean,skeleton,compact,changed:clean!==original};
}
