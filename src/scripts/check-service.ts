import { loadConfig } from '../config.js';
const config=loadConfig();
const response=await fetch(`${config.serviceURL}/health`,{headers:{Authorization:`Bearer ${config.serviceToken}`},signal:AbortSignal.timeout(5000)});
if(!response.ok)throw new Error(`Health check HTTP ${response.status}`);
const result=await response.json();console.log(result);
