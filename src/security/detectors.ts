import { domainToASCII } from 'node:url';
import { normalizeText } from './normalization.js';
import { compileSafeRegex } from './config.js';
import type { ModerationInput, SecurityConfig, Exemptions, Rule, Finding, Decision } from './types.js';

export function exempt(input:ModerationInput, exemptions:Exemptions):boolean {
  return exemptions.users.includes(input.author.id)||input.roles.some(id=>exemptions.roles.includes(id))||exemptions.channels.includes(input.channel.id)||Boolean(input.channel.parent&&exemptions.channels.includes(input.channel.parent))||Boolean(input.channel.category&&exemptions.categories.includes(input.channel.category));
}
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function compileDetectors(config:SecurityConfig) {
  const compiled=config.rules.filter(r=>r.enabled).map(rule=>({rule,patterns:rule.patterns.map(p=>rule.type==='regex'?compileSafeRegex(p):rule.type==='keyword'?new RegExp(`(?<![\\p{L}\\p{N}_])${escape(normalizeText(p).clean)}(?![\\p{L}\\p{N}_])`,'u'):p)}));
  return (input:ModerationInput):Finding[]=>{
    if(input.content.length>16000)throw new Error('Detection input exceeds 16000 characters.');
    if(input.author.bot||(config.exemptStaff&&input.author.staff)||exempt(input,config.exemptions))return [];
    const text=normalizeText(input.content), findings:Finding[]=[];
    for(const {rule,patterns} of compiled){
      if(rule.source!==input.source||exempt(input,rule.exemptions))continue;
      let finding:Finding|undefined;
      const variants=[{text:text.clean,name:'normalized',confidence:1},...(rule.obfuscation?[{text:text.skeleton,name:'confusable',confidence:0.85},{text:text.compact,name:'spacing',confidence:0.85}]:[])];
      for(const variant of variants){
        if(rule.type==='domain'){
          // Only literal URL/bare-host candidates; never fetch or follow links.
          const candidates=variant.text.match(/(?:https?:\/\/[^\s<>]+|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:\/[^\s<>]*)?)/gu)??[];
          for(const candidate of candidates){try{
            const host=domainToASCII(new URL(candidate.startsWith('http')?candidate:`https://${candidate}`).hostname).replace(/\.$/,'');
            const pattern=patterns.find(p=>typeof p==='string'&&(host===p||host.endsWith(`.${p}`)));
            if(pattern){finding=makeFinding(rule,variant.confidence,candidate,variant.name);break;}
          }catch{}}
        }else{
          for(const pattern of patterns){const match=(pattern as RegExp).exec(variant.text);if(match){finding=makeFinding(rule,variant.confidence,match[0],variant.name);break;}}
        }
        if(finding)break;
      }
      if(finding)findings.push(finding);
    }
    return findings;
  };
}
function makeFinding(rule:Rule,confidence:number,evidence:string,variant:string):Finding {
  return {ruleId:rule.id,category:rule.type,severity:rule.severity,policy:rule.policy,confidence,evidence:evidence.slice(0,160),variant};
}
export function decide(config:SecurityConfig, findings:Finding[], countFor:(policy:string,windowMs:number)=>number, source:ModerationInput['source']):Decision {
  const rank={review:0,reminder:1,warn:2,timeout:3};
  let result:Decision={findings,action:'review',delete:false,durationMs:0,policy:null,count:false,windowMs:0,warningExpiryMs:0};
  for(const finding of findings){
    const rule=config.rules.find(r=>r.id===finding.ruleId)!;
    // Profiles and confusable/spacing matches are review-only in phase 1.
    if(source==='profile'||finding.confidence<rule.minConfidence||finding.confidence<1)continue;
    const policy=config.policies.find(p=>p.id===rule.policy)!;
    const count=policy.count?countFor(policy.id,policy.windowMs)+1:1;
    const step=[...policy.steps].reverse().find(s=>count>=s.count)!;
    const deletion=result.delete||policy.delete;
    if(rank[step.action]>=rank[result.action])result={findings,action:step.action,delete:deletion,durationMs:step.durationMs,policy:policy.id,count:policy.count,windowMs:policy.windowMs,warningExpiryMs:policy.warningExpiryMs};
    else result.delete=deletion;
  }
  return result;
}
