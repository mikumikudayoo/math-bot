import {automationConfig} from '../announcements/config.js';
import {extractionSchema,validateSchema} from '../announcements/extraction.js';
import {completeProvider,ProviderRequestRejected,ProviderBackoff,ProviderPayloadTooLarge} from '../service/providers.js';

// Synthetic API/schema diagnostic only. Never opens the database, reads Gmail,
// updates durable health, or sends Discord messages.
try{
  const config=automationConfig();
  const result=await completeProvider(config.provider,{
    messages:[{role:'user',content:'Synthetic diagnostic. Return disposition needs_review, dispositionReason synthetic diagnostic, correction false, catalog with empty competitions/rounds/programs arrays, empty events and issues arrays. No organizer facts are supplied.'}],
    response_format:{type:'json_schema',json_schema:{name:'mathematics_schedule',strict:true,schema:extractionSchema}},temperature:0,max_tokens:8000,
  },AbortSignal.timeout(45000),fetch) as {choices?:{message?:{content?:string}}[]};
  const output=JSON.parse(result.choices?.[0]?.message?.content??'null');validateSchema(output,extractionSchema);
  if(output.events.length||output.disposition!=='needs_review')throw new Error('Unexpected synthetic output.');
  console.log('Synthetic Groq API/schema check passed. This does not verify organizer facts, delivery, or persisted worker health.');
}catch(error){
  const reason=error instanceof ProviderRequestRejected?`HTTP ${error.status}: ${error.category}`:error instanceof ProviderBackoff?'temporarily unavailable':error instanceof ProviderPayloadTooLarge?'request too large':'configuration, transport, or output validation failed';
  console.error(`Synthetic Groq check failed: ${reason}. No durable state changed.`);process.exitCode=1;
}
