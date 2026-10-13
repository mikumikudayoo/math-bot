import {publicURL} from './network.js';

// Authorization is exact canonical URL provenance, separate from network/SSRF validation.
export class TurnWebBoundary {
  private urls=new Set<string>();
  privateContextSeen=false;
  constructor(prompt:string){
    for(const match of prompt.matchAll(/https:\/\/[^\s<>"`]+/gi)){
      let candidate=match[0].replace(/[.,!?;:]+$/,'');
      // Strip only unmatched closing delimiters from prose/Markdown links.
      for(const [open,close] of [['(',')'],['[',']']] as const){
        while(candidate.endsWith(close)&&candidate.split(close).length>candidate.split(open).length)candidate=candidate.slice(0,-1);
      }
      this.trust(candidate);
    }
  }
  get private(){return this.privateContextSeen;}
  observeDiscord(value:unknown){
    if(!value||typeof value!=='object')return;
    const data=value as {type?:unknown;results?:unknown};
    if(data.type==='DISCORD_SEARCH_DATA'&&Array.isArray(data.results)&&data.results.some(row=>row&&typeof row==='object'&&typeof row.content==='string'&&row.content.length>0))this.privateContextSeen=true;
  }
  observeHistory(context:string|undefined){
    try{if(context&&JSON.parse(context).kind==='discord')this.privateContextSeen=true;}catch{}
  }
  trust(value:string){try{this.urls.add(publicURL(value).href);}catch{}}
  permits(value:string){try{return !this.private&&this.urls.has(publicURL(value).href);}catch{return false;}}
}
