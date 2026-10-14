import {publicURL} from './network.js';
import {mergeProvenance,publicProvenance,readProvenance,rowProvenance,type Provenance} from './provenance.js';

// Authorization is exact canonical URL provenance, separate from network/SSRF validation.
export class TurnWebBoundary {
  private urls=new Set<string>();
  private provenanceState=publicProvenance();
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
  get private(){return this.provenanceState.classification==='private-discord';}
  get provenance():Provenance{return this.provenanceState;}
  observeProvenance(value:Provenance){this.provenanceState=mergeProvenance(this.provenanceState,value);}
  observeDiscord(value:unknown,guildId?:string){
    if(!value||typeof value!=='object')return;
    const data=value as {type?:unknown;results?:unknown};
    if(data.type==='DISCORD_SEARCH_DATA'&&Array.isArray(data.results)){
      const content=data.results.filter(row=>row&&typeof row==='object'&&typeof row.content==='string'&&row.content.length>0);
      if(content.length)this.observeProvenance(readProvenance({classification:'private-discord',discordSources:content.map(row=>({guildId,channelId:row.channelId}))}));
    }
  }
  observeHistory(context:string|undefined){
    this.observeProvenance(rowProvenance({guild:'',...(context?{retrievalContext:context}:{})}));
  }
  trust(value:string){try{this.urls.add(publicURL(value).href);}catch{}}
  permits(value:string){try{return !this.private&&this.urls.has(publicURL(value).href);}catch{return false;}}
}
