// This boundary is intentionally independent of the extraction/model and store
// schemas. Those schemas check shape; this module checks what may become public.
export const privateEvidenceMarker = '[private participant/account detail withheld] (credential content withheld)';

const privateValuePattern = /\b(?:[a-z\d]+[-_])?(?:candidate|pin|user(?:name)?|password|passcode|secret)[-_][a-z\d_-]*\d[a-z\d_-]*\b|\b(?:p\.?i\.?n\.?|candidate(?:id|number|no)|user(?:id|name)|loginid|password|passcode)\d{3,}\b|\bbearer\s+[a-z\d_.-]{8,}|\beyJ[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+\b/iu;
const privateLabel = '(?:password|pass[\\s_-]*code|p\\.?i\\.?n\\.?(?:[\\s_-]*(?:code|number|no\\.?))?|candidate[\\s_-]*(?:id|identifier|number|no\\.?|code|#)|(?:user|login|student|participant)[\\s_-]*(?:id|identifier|name|number|no\\.?|code)|username|access[\\s_-]*(?:code|token|key)|auth(?:entication|orization)?[\\s_-]*(?:code|token|key)|secret(?:[\\s_-]*key)?|(?:refresh|bearer|session)[\\s_-]*token|token|credentials?)';
const labelledPrivateValue = new RegExp('\\b' + privateLabel + '(?![\\p{L}\\p{N}_])(?=\\s*[:=|]|\\s+|$)', 'giu');
const identityValue = /\b(?:full\s+name|(?:student|participant|candidate)(?:'s)?\s+name|name\s+of\s+(?:student|participant|candidate)|name|school(?:\s+name)?)\s*[:=|]\s*([^\n]*)/iu;
const identityHeading = /\b(?:(?:full|student|participant|candidate)\s+name|name|school(?:\s+name)?)\s*$/iu;
const privateSection = /^\s*(?:\[x=[^\]]+\]\s*)?(?:(?:your|personal|individual|participant)\s+)?(?:login\s+(?:details|credentials|information)|credentials|participant\s+(?:details|information)|student\s+(?:details|information))\s*:?\s*$/iu;
const publicSection = /\b(?:session\s*\d+|(?:competition|exam|mock[ -]?test|training|registration|check[ -]?in)\s+(?:date|time|start|end|schedule|deadline|window)|schedule|timetable|venue|what\s+to\s+bring|dress\s+code|materials|guidebook|public\s+(?:resource|link))\b/iu;
const harmlessNotice = /^(?:content\s+(?:is\s+)?withheld\b|(?:will\s+be|were|was|are|has\s+been|have\s+been)\s+(?:sent|emailed|withheld)\b|(?:already\s+)?(?:sent|emailed|withheld)\b|not\s+(?:required|needed)\b)/iu;
const unresolvedEncoding = /%[\da-f]{2}|&#(?:\d+|x[\da-f]+)|\\u(?:\{|[\da-f])|\\x[\da-f]/iu;

/** Decode common source obfuscations before inspecting values, never after it. */
export function normalizePublicText(value:string):string {
  let result=value;
  for(let i=0;i<12;i++){
    const next=result.replace(/&(?:#(\d+);?|#x([\da-f]+);?|([a-z]+);)/gi,(match:string,decimal:string|undefined,hex:string|undefined,named:string|undefined)=>{
      if(decimal||hex){const point=Number.parseInt(decimal??hex!,hex?16:10);return Number.isFinite(point)&&point>=0&&point<=0x10ffff?String.fromCodePoint(point):match;}
      return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',colon:':',equals:'=',sol:'/',tab:'\t',newline:'\n',num:'#',percnt:'%'} as Record<string,string>)[named?.toLowerCase()??'']??match;
    }).replace(/\\u\{([\da-f]{1,6})\}|\\u([\da-f]{4})|\\x([\da-f]{2})/gi,(match:string,a:string|undefined,b:string|undefined,c:string|undefined)=>{
      const point=Number.parseInt(a??b??c!,16);return point<=0x10ffff?String.fromCodePoint(point):match;
    }).replace(/(?:%[\da-f]{2})+/gi,encoded=>{try{return decodeURIComponent(encoded);}catch{return encoded;}});
    result=next;if(next===value)break;value=next;
  }
  return result.normalize('NFKC').replace(/<\/?[a-z][a-z\d-]*(?:\s[^<>]*)?\s*\/?>/giu,'').replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'');
}

function sensitiveLabelMatch(value:string):RegExpExecArray|null {
  labelledPrivateValue.lastIndex=0;
  for(let strong=labelledPrivateValue.exec(value);strong;strong=labelledPrivateValue.exec(value)){
    const suffix=value.slice(strong.index+strong[0].length).replace(/^\s*[:=|]?\s*/u,'');
    if(!harmlessNotice.test(suffix)||/[:=|\d]/u.test(suffix))return strong;
  }
  const labelled=identityValue.exec(value);if(labelled)return labelled;
  const heading=identityHeading.exec(value);
  return heading&&(!value.slice(0,heading.index).trim()||/^\s*\[x=[^\]]+\]\s*$/u.test(value.slice(0,heading.index)))?heading:null;
}

/** Context-free detection is conservative; participant associations need labels. */
export function hasSensitivePublicContent(value:string):boolean {
  const normalized=normalizePublicText(value);
  return privateValuePattern.test(normalized)||sensitiveLabelMatch(normalized)!==null;
}

function urlError():never {throw new Error('Public URL is unsafe or requires review.');}
/** Only demonstrably general HTTPS resource locations cross the public boundary. */
export function validatePublicUrl(value:unknown):void {
  if(typeof value!=='string'||value.length>2048||!value||value.trim()!==value||/[\s\\\u0000-\u001f\u007f]/u.test(value))urlError();
  const normalized=normalizePublicText(value);
  let url:URL;try{url=new URL(normalized);}catch{urlError();}
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.search)urlError();
  if(!url.hostname.includes('.')||/^\[|^[\d.]+$/.test(url.hostname)||/(?:^|\.)(?:localhost|local|internal|lan)$/i.test(url.hostname))urlError();
  const path=normalizePublicText(url.pathname).toLowerCase();
  if(/[;=]/u.test(path)||/(?:^|[/_.-])(?:candidates?(?:id|number|no|code)?|users?(?:id|name)?|participants?|students?|accounts?|auth(?:entication|orization)?|oauth\d*|log[ -]?in|signin|sign-in|callback|session(?:id|token)?|tokens?|password|passcode|pin|credentials?|access[-_]?key|reset|verify|verification|invites?|download|private|personal|profiles?|recipients?|delivery)(?:$|[/_.-])/i.test(path)||/(?:^|\/)(?:u|me|members?)(?:\/|$)/iu.test(path))urlError();
  if(/(?:^|\.)zoom\.(?:us|com)$/i.test(url.hostname)&&/^\/(?:j|s|w|my|join|rec|wc)(?:\/|$)/i.test(path))urlError();
  if(privateValuePattern.test(normalized)||hasSensitivePublicContent(path))urlError();
  if(url.hash&&(!/^#[a-z][a-z\d-]{0,60}$/i.test(url.hash)||/(?:auth|token|candidate|user|password|secret|pin)/i.test(url.hash)||/session/i.test(url.hash)&&!/^#session-\d+$/i.test(url.hash)))urlError();
  // Encoded separators must not introduce hidden authority, query, or fragments.
  if(/[\s\u0000-\u001f\u007f]/u.test(normalized)||unresolvedEncoding.test(normalized)||normalizePublicText(url.pathname).includes('?')||normalizePublicText(url.pathname).includes('#'))urlError();
}

const urlPattern = /\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/giu;
const publicFieldLabel = /^(?:session|set|date|time|start|end|deadline|timezone|venue|competition|training|round|registration|check-in|materials|resources?|guidebook|reminder|name|school)$/iu;
const privateFieldLabel = new RegExp('^'+privateLabel+'$','iu');
function inspectUrls(value:string,replaceUnsafe:boolean):{text:string;sensitive:boolean}{
  let sensitive=false;
  for(const match of value.matchAll(/\b([a-z][a-z\d+.-]{1,31}):(?=\S)/giu)){
    const scheme=match[1]!,after=value.slice(match.index+match[0].length);
    if(scheme.toLowerCase()==='https'&&after.startsWith('//'))continue;
    if(!after.startsWith('//')&&(publicFieldLabel.test(scheme)||privateFieldLabel.test(scheme)))continue;
    if(!replaceUnsafe)throw new Error('Public fact contains an unsafe URL.');return {text:'[private or unsafe link withheld]',sensitive:true};
  }
  if(/(?:^|[\s(<])\/\/[^\s<>"']+/u.test(value)){if(!replaceUnsafe)throw new Error('Public fact contains an unsafe URL.');return {text:'[private or unsafe link withheld]',sensitive:true};}
  const text=value.replace(urlPattern,raw=>{
    // Sentence punctuation is outside a URL; do not discard a public sentence.
    const url=raw.replace(/[),.;!?]+$/u,'');
    try{validatePublicUrl(url);return raw;}catch{if(!replaceUnsafe)throw new Error('Public fact contains an unsafe URL.');sensitive=true;return '[private or unsafe link withheld]'+raw.slice(url.length);}
  });
  return {text,sensitive};
}

/** Preserve public lines and table cells while withholding private values. */
export function sanitizeOrganizerEvidence(value:string):{text:string;sensitive:boolean}{
  let sensitive=false,withholdNextLine=false,inPrivateSection=false;
  const normalized=normalizePublicText(value);
  const lines=normalized.split(/\r?\n/u).map(line=>{
    if(privateSection.test(line)){sensitive=true;inPrivateSection=true;return privateEvidenceMarker;}
    if(inPrivateSection){if(publicSection.test(line))inPrivateSection=false;else if(line.trim()){sensitive=true;return privateEvidenceMarker;}}
    if(withholdNextLine){withholdNextLine=false;if(line.trim()&&!publicSection.test(line)){sensitive=true;return privateEvidenceMarker;}}
    const links=inspectUrls(line,true);sensitive||=links.sensitive;
    let withholdNextCell=false,privateHeaders=0;
    const result=links.text.split(/([;|])/u).map(segment=>{
      if(segment===';'||segment==='|')return segment;
      if(withholdNextCell&&segment.trim()&&!sensitiveLabelMatch(segment)){withholdNextCell=false;sensitive=true;return privateEvidenceMarker;}
      const match=sensitiveLabelMatch(segment);
      if(match){
        sensitive=true;
        const suffix=segment.slice(match.index).replace(/^\[x=[^\]]+\]\s*/u,'');
        if(!suffix.replace(new RegExp('^(?:'+privateLabel+'|name|school(?:\\s+name)?)\\s*[:=]?\\s*','iu'),'').trim()){privateHeaders++;withholdNextLine=true;withholdNextCell=true;}
        return segment.slice(0,match.index)+privateEvidenceMarker;
      }
      if(privateValuePattern.test(segment)||unresolvedEncoding.test(segment)){sensitive=true;return privateEvidenceMarker;}
      return segment;
    }).join('');
    if(privateHeaders>1){withholdNextLine=true;inPrivateSection=true;}else if(!withholdNextCell)withholdNextLine=false;
    return result;
  });
  return {text:lines.join('\n'),sensitive};
}

export function validatePublicText(value:unknown,_field='public text'):void {
  if(typeof value!=='string'||hasSensitivePublicContent(value)||unresolvedEncoding.test(normalizePublicText(value)))throw new Error('Public fact contains private participant or authentication content.');
  const normalized=normalizePublicText(value);
  if(/@(?:everyone|here)\b|<@!?\d+>|<@&\d+>|<#\d+>/iu.test(normalized))throw new Error('Public fact contains untrusted Discord mention metadata.');
  inspectUrls(normalized,false);
}

function validateProjection(value:unknown,depth=0):void {
  if(depth>12)throw new Error('Public projection is too deeply nested.');
  if(typeof value==='string'){validatePublicText(value);return;}
  if(Array.isArray(value)){for(const item of value)validateProjection(item,depth+1);return;}
  if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){if(key==='url'&&item!==null)validatePublicUrl(item);else validateProjection(item,depth+1);}
}
export function validatePublicCatalog(catalog:unknown):void {validateProjection(catalog);}
export function validatePublicEvent(event:unknown):void {validateProjection(event);}

export interface PublicDiscordScope {role?:string|null;channel?:string}
/** Validate the exact persisted Discord projection, including mention policy. */
export function validatePublicDiscordPayload(payload:unknown,scope:PublicDiscordScope={}):void {
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Invalid public Discord payload.');
  const object=payload as Record<string,unknown>;
  if(Object.keys(object).some(key=>!['content','allowedMentions'].includes(key))||typeof object.content!=='string'||!object.content.trim()||object.content.length>2000)throw new Error('Invalid public Discord payload.');
  const mentions=object.allowedMentions as Record<string,unknown>|undefined;
  if(!mentions||typeof mentions!=='object'||Array.isArray(mentions)||Object.keys(mentions).some(key=>!['parse','roles','users','repliedUser'].includes(key))||!Array.isArray(mentions.parse)||mentions.parse.length||!Array.isArray(mentions.users)||mentions.users.length||mentions.repliedUser!==false||!Array.isArray(mentions.roles)||mentions.roles.length>1||mentions.roles.some(role=>typeof role!=='string'||role!==scope.role))throw new Error('Invalid public Discord mention policy.');
  const content=normalizePublicText(object.content).replace(/<@&\d+>|<#\d+>/gu,mention=>{
    if(scope.role&&mention===`<@&${scope.role}>`||scope.channel&&mention===`<#${scope.channel}>`)return '';
    throw new Error('Public Discord payload contains untrusted mention metadata.');
  });
  validatePublicText(content);
}
