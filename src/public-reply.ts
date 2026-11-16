/** Hide implementation diagnostics, preserving ordinary numbers and evidence links. */
export function publicReply(text:string,internalIds:readonly string[]=[],preserveLayout=false):string{
  const removed=preserveLayout?' ':'';
  let clean=text.replace(/\b(?:request|job|queue|correlation|provider[ _-]?request|trace|database)[ _-]*id\s*[:=]\s*[\w.-]{1,128}/gi,removed).replace(/\b(?:request|job|queue|correlation|provider[ _-]?request|trace|database)[ _-]*(?:id|number|no\.)?\s*(?:[#: =-]\s*)?(?:\d+|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|[a-f\d]{24,64})(?![\w-])/gi,removed);
  for(const id of internalIds)if(id.length>=6)clean=clean.split(id).join(removed);
  if(!preserveLayout)clean=clean.replace(/[ \t]{2,}/g,' ').replace(/^\s*[·:=-]\s*/gm,'');
  clean=clean.trim();
  return !clean||/^(?:failed|error)[.!]*$/i.test(clean)?"couldn't get that right now, try again in a bit":clean;
}
