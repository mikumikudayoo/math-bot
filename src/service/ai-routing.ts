import type { ServiceConfig } from './config.js';
import type { RouteDecision } from './router.js';
import { selectProvider } from './providers.js';

const demanding=/\b(?:prove|proof|derive|debug|coding|code|programming|algorithm|async|await|multi[- ]step|integer pairs?|diophantine|optimi[sz]e)\b/i;
export function localSafe(prompt:string,route:Pick<RouteDecision,'reasoning'|'knowledge'>){
  return route.reasoning==='fast'&&route.knowledge==='internal'&&prompt.length<=500&&!demanding.test(prompt);
}
export function aiProvider(config:ServiceConfig,prompt:string,route:Pick<RouteDecision,'reasoning'|'knowledge'>,options:{image:boolean;discord:boolean}){
  if(config.cognitiveRouting&&!options.image&&!options.discord&&localSafe(prompt,route))return config;
  if(config.cognitiveRouting&&demanding.test(prompt)&&!options.discord)return selectProvider(config,prompt,{...route,reasoning:'deep'},options);
  return selectProvider(config,prompt,route,options);
}
export function safeLocalFallback(prompt:string,reasoning:RouteDecision['reasoning'],grounded:boolean,image:boolean){
  // Local synthesis can only select verified source excerpts. Hard reasoning never downgrades.
  return grounded&&!image&&reasoning!=='deep'&&!demanding.test(prompt);
}
