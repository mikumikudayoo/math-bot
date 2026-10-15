import {UserError} from './types.js';

const failure=()=>new UserError("couldn't share that reply safely. try again without a link.");
interface Address {start:number;end:number;value:string;explicit:boolean}
const fixedCodeIdentifiers=new Set(['math.sin']);

// Discovery is deliberately broader than clickable Discord URLs. Parsing and the
// exact host ledger authorize a target; discovery never grants authorization.
function addresses(text:string):Address[]{
  const found:Address[]=[];
  // A Markdown target's closing delimiter is a token boundary. Otherwise a
  // greedy URL match could hide an adjacent, unapproved address behind a
  // permitted link when the target is trimmed for authorization.
  const markdownEnds:number[]=[];
  for(const match of text.matchAll(/\]\(\s*<?([^\s<>]+)/g)){
    const value=match[1]!,target=markdownTarget(value);
    if(target.length<value.length)markdownEnds.push(match.index!+match[0].indexOf(value)+target.length);
  }
  const add=(pattern:RegExp,explicit:boolean)=>{
    let match:RegExpExecArray|null;
    while((match=pattern.exec(text))){
      const start=match.index,limit=markdownEnds.find(end=>end>start&&end<start+match![0].length);
      const value=limit===undefined?match[0]:match[0].slice(0,limit-start);
      found.push({start,end:start+value.length,value,explicit});
      // Continue scanning the suffix after a Markdown destination, including
      // addresses placed immediately after ')' without intervening whitespace.
      if(limit!==undefined)pattern.lastIndex=limit;
    }
  };
  add(/\b(?:[a-z][a-z\d+.-]*:\s*[/\\]|(?:https?|ftp|ftps|file|mailto|tel|sms|data|javascript|vbscript|discord|tg|magnet):(?=\S))[^\s<>"`]+/gi,true);
  add(/\/\/[^\s<>"`]+|\bwww\.[^\s<>"`]+/gi,false);
  add(/\b(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}(?::\d{1,5})?[/?#][^\s<>"`]*/gi,false);
  add(/\b(?:\d{1,3}\.){3}\d{1,3}\b(?::\d{1,5})?[^\s<>"`]*|\[[\da-f]*:[\da-f:]+\](?::\d{1,5})?[^\s<>"`]*/gi,false);
  // Obvious bare domains/emails count too, without classifying every dotted
  // programming identifier (e.g. math.sin) as an address.
  add(/\b(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+(?:com|org|net|io|dev|app|xyz|info|biz|edu|gov|ph|uk|me|co|ai|invalid|example|test|local|internal)\b[^\s<>"`]*/gi,false);
  // Sensitive data can be encoded in a subdomain under any TLD. Catch bare
  // multi-label/IDN hostnames without mistaking math.sin for an address.
  add(/(?<![\p{L}\p{N}])(?:[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}])?\.){2,}[\p{L}]{2,63}(?![\p{L}\p{N}])[^\s<>"`]*/giu,false);
  // One-dot hosts under unfamiliar TLDs are addressable too. This deliberately
  // errs toward blocking dotted identifiers in private replies; the narrow
  // fixed-code exception below cannot carry a path, query, fragment or suffix.
  add(/(?<![\p{L}\p{N}_])(?:[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])(?![\p{L}\p{N}_.-])(?::\d{1,5})?(?:[/?#][^\s<>"`]*)?/giu,false);
  add(/\b[a-z\d.!#$%&'*+\/=?^_{|}~-]+@(?:[a-z\d-]+\.)+[a-z]{2,63}\b/gi,false);
  // Markdown/autolink destinations can use a non-hierarchical scheme or an
  // unfamiliar bare domain. Parenthesized destinations need no network lookup.
  for(const match of text.matchAll(/\]\(\s*<?([^\s<>]+)|<([^\s<>]+)>/g)){
    const value=match[1]?markdownTarget(match[1]):match[2]!;
    if(!/^[a-z][a-z\d+.-]*:|^(?:\/\/|www\.)|^[a-z\d-]+(?:\.[a-z\d-]+)+(?:[/?#:]|$)/i.test(withoutDelimiters(value)))continue;
    const start=match.index!+match[0].indexOf(value);
    found.push({start,end:start+value.length,value,explicit:/^[a-z][a-z\d+.-]*:/i.test(value)});
  }
  // A containing full URL owns its domain/query matches. Otherwise an approved
  // full URL would be rejected again as a separately discovered bare hostname.
  let covered=-1;
  return found.sort((a,b)=>a.start-b.start||b.end-a.end).filter(entry=>{
    if(entry.end<=covered)return false;covered=entry.end;return true;
  });
}

function withoutDelimiters(value:string){
  let result=value;
  for(const [open,close] of [['(',')'],['[',']'],['{','}']] as const){
    while(result.endsWith(close)&&result.split(close).length>result.split(open).length)result=result.slice(0,-1);
  }
  return result;
}

function markdownTarget(value:string){
  let depth=0;
  for(let i=0;i<value.length;i++){
    if(value[i]==='(')depth++;
    else if(value[i]===')'){
      if(!depth)return value.slice(0,i);
      depth--;
    }
  }
  return value;
}

function authorized(value:string,permits:(url:string)=>boolean){
  try{
    const url=new URL(value);
    // Userinfo and alternate schemes must not smuggle data to another target.
    if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return false;
    return permits(url.href);
  }catch{return false;}
}

function normalized(text:string){
  return text.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'')
    .replace(/[\u3002\uff0e\uff61]/g,'.')
    .replace(/\\([!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-])/g,'$1')
    .replace(/&#(?:x([\da-f]+)|(\d+));?/gi,(all,hex:string|undefined,decimal:string|undefined)=>{
      const code=Number.parseInt(hex??decimal!,hex?16:10);return code>=0&&code<=0x7f?String.fromCharCode(code):all;
    })
    .replace(/&(amp|colon|sol|bsol|period|commat|quest|num);/gi,(_all,name:string)=>({amp:'&',colon:':',sol:'/',bsol:'\\',period:'.',commat:'@',quest:'?',num:'#'}[name.toLowerCase()]!))
    .replace(/%([\da-f]{2})/gi,(all,hex:string)=>{const code=Number.parseInt(hex,16);return code<=0x7f?String.fromCharCode(code):all;});
}

/** No network I/O. The caller applies this only to host-classified private finals. */
export function assertPrivateOutputURLs(text:string,permits:(url:string)=>boolean):void{
  let view=text;
  for(let pass=0;pass<8;pass++){
    const candidates=addresses(view);
    for(const address of candidates){
      let candidate=address.value;
      if(/\]\(\s*$/.test(view.slice(0,address.start)))candidate=markdownTarget(candidate);
      else if(!/[?#]/.test(candidate))candidate=withoutDelimiters(candidate);
      if(!address.explicit){
        const prefix=view.slice(0,address.start),suffix=view.slice(address.end);
        if(fixedCodeIdentifiers.has(address.value)&&!/(?:\]\(\s*<?|<)\s*$/.test(prefix)&&(!suffix||/^[\s(),;]$/.test(suffix[0]!)))continue;
        throw failure();
      }
      if(authorized(candidate,permits))continue;
      // Sentence punctuation is ambiguous in a URL with a query/fragment: never
      // trim those fields to make an unauthorized private addition look trusted.
      if(!/[?#]/.test(candidate))candidate=withoutDelimiters(candidate.replace(/[.,!;:]+$/,''));
      if(!authorized(candidate,permits))throw failure();
    }
    // Mask already-authorized URLs before decoding surrounding presentation.
    // An encoded query inside an exact approved URL must not create extra links.
    for(const address of [...candidates].reverse())view=view.slice(0,address.start)+' '.repeat(address.end-address.start)+view.slice(address.end);
    const next=normalized(view);
    if(next===view)return;
    view=next;
  }
  // Excessive layers are ambiguous presentation, not permission. Fail closed
  // without echoing the original text or claiming arbitrary cipher detection.
  if(normalized(view)!==view||addresses(view).length)throw failure();
}


/** Remove directly discoverable unauthorized addresses. The caller MUST run assertPrivateOutputURLs again. */
export function sanitizePrivateOutputURLs(text:string,permits:(url:string)=>boolean):string{
  try{assertPrivateOutputURLs(text,permits);return text;}catch{}
  const candidates=addresses(text);if(!candidates.length)return text;
  let output=text;
  for(const address of [...candidates].reverse()){
    let candidate=address.value;
    if(/\]\(\s*$/.test(text.slice(0,address.start)))candidate=markdownTarget(candidate);
    else if(!/[?#]/.test(candidate))candidate=withoutDelimiters(candidate);
    let keep=false;
    if(!address.explicit){
      const prefix=text.slice(0,address.start),suffix=text.slice(address.end);
      keep=fixedCodeIdentifiers.has(address.value)&&!/(?:\]\(\s*<?|<)\s*$/.test(prefix)&&(!suffix||/^[\s(),;]$/.test(suffix[0]!));
    }else{
      keep=authorized(candidate,permits);
      if(!keep&&!/[?#]/.test(candidate))keep=authorized(withoutDelimiters(candidate.replace(/[.,!;:]+$/,'')),permits);
    }
    if(!keep)output=output.slice(0,address.start)+'[external address omitted]'+output.slice(address.end);
  }
  return output;
}
