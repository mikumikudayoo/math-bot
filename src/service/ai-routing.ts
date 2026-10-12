import type { ServiceConfig } from './config.js';
import type { RouteDecision } from './router.js';
import { selectProvider } from './providers.js';
import {UserError} from './types.js';

const demanding=/\b(?:prove|proof|derive|debug|coding|code|programming|algorithm|async|await|multi[- ]step|integer pairs?|diophantine|optimi[sz]e)\b/i;

const explicitDeterministicTool=(prompt:string)=>
  /\b(?:use|with|via)\s+(?:python|(?:the\s+)?calculator)\b/i.test(prompt)&&
  /\b(?:calculate|compute|evaluate|find|remainder|mod(?:ulo)?|divided by|power|gcd|lcm)\b|[0-9][^\n]{0,80}[+\-*/^]/i.test(prompt);

const nontrivialSymbolicMath=(prompt:string)=>{
  const p=prompt.trim();
  const variableRefs=(p.match(/\b[a-z]\b/gi)??[]).length;
  const symbolicOps=(p.match(/[+\-*/^=]/g)??[]).length;
  const divisions=(p.match(/\//g)??[]).length;
  const exactNumberTheory=/\b(?:remainder|mod(?:ulo)?|congru(?:ence|ent)|divisib(?:le|ility)|gcd|lcm|prime factors?|factorial|permutations?|combinations?|binomial)\b/i.test(p);
  const largePower=/(?:\^|\*\*)\s*\d{3,}/.test(p);
  const poweredDivision=/(?:\^|\*\*)/.test(p)&&/\bdivided by\b/i.test(p);
  return (
    (
      /\b(?:find|solve|evaluate|simplify|determine|compute)\b/i.test(p) &&
      variableRefs>=2 &&
      /=/.test(p) &&
      ((/\^|\*\*/.test(p)&&divisions>=1)||symbolicOps>=5)
    ) ||
    /\b(?:recurrence|sequence|diophantine|polynomial|congruence|modulo|combinatorics?)\b/i.test(p) ||
    exactNumberTheory ||
    largePower ||
    poweredDivision
  );
};

export function localSafe(prompt:string,route:Pick<RouteDecision,'reasoning'|'knowledge'>){
  return route.reasoning==='fast'&&route.knowledge==='internal'&&prompt.length<=500&&!demanding.test(prompt)&&!nontrivialSymbolicMath(prompt);
}

export function aiProvider(config:ServiceConfig,prompt:string,route:Pick<RouteDecision,'reasoning'|'knowledge'>,options:{image:boolean;discord:boolean}){
  if(options.image){
    if(!config.visionProvider)throw new (UserError)('image understanding is not configured right now. i cannot inspect that attachment yet.');
    return config.visionProvider;
  }
  const hard=demanding.test(prompt)||nontrivialSymbolicMath(prompt);
  if(config.cognitiveRouting&&!options.image&&!options.discord&&route.knowledge==='internal'&&explicitDeterministicTool(prompt))return config;
  if(config.cognitiveRouting&&!options.image&&!options.discord&&localSafe(prompt,route))return config;
  if(config.cognitiveRouting&&hard&&!options.discord)return selectProvider(config,prompt,{...route,reasoning:'deep'},options);
  return selectProvider(config,prompt,route,options);
}

export function safeLocalFallback(prompt:string,reasoning:RouteDecision['reasoning'],grounded:boolean,image:boolean){
  // Local synthesis can only select verified source excerpts. Hard reasoning never downgrades.
  return grounded&&!image&&reasoning!=='deep'&&!demanding.test(prompt)&&!nontrivialSymbolicMath(prompt);
}
