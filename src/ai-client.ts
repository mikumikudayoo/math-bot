import { loadConfig } from './config.js';
export class ServiceError extends Error {}
export async function service<T>(path:string,body?:unknown):Promise<T> {
  const config=loadConfig();
  if(!config.serviceToken)throw new ServiceError('AI service is not set up yet. Run bun run setup:local.');
  let response:Response;
  try{response=await fetch(`${config.serviceURL}${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${config.serviceToken}`,'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000),redirect:'error'});}
  catch{throw new ServiceError('The study service is offline. Please try again shortly.');}
  const result=await response.json() as T & {error?:string};
  if(!response.ok)throw new ServiceError(result.error??'Service request failed.');return result;
}
