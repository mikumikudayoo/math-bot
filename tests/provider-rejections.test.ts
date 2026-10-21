import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completeProvider,providerHealth,ProviderRequestRejected} from '../src/service/providers.js';
const provider={backend:'https://example.invalid',model:'synthetic-rejection',backendKey:'synthetic',vision:false,nativeTools:false};
test('bounded provider errors distinguish output validation, request rejection and authentication without leaking bodies',async()=>{
  for(const [status,body,category,health] of [
    [400,JSON.stringify({error:{code:'json_validate_failed',message:'PRIVATE-SENTINEL',failed_generation:'SECRET'}}),'output-validation','request-rejected'],
    [400,JSON.stringify({error:{code:'invalid_request_error',message:'PRIVATE-SENTINEL'}}),'request-rejected','request-rejected'],
    [401,'PRIVATE-SENTINEL','authentication','misconfigured'],
    [403,'PRIVATE-SENTINEL','authentication','misconfigured'],
    [400,'x'.repeat(17000),'request-rejected','request-rejected'],
    [400,'not json','request-rejected','request-rejected'],
  ] as const){
    providerHealth.clear();let calls=0;
    await assert.rejects(()=>completeProvider(provider,{},AbortSignal.timeout(1000),async()=>{calls++;return new Response(body,{status});}),error=>{
      assert.ok(error instanceof ProviderRequestRejected);assert.equal(error.category,category);assert.equal(error.status,status);
      assert.ok(!JSON.stringify(error).includes('PRIVATE-SENTINEL'));assert.ok(!String(error).includes('SECRET'));return true;
    });
    assert.equal(calls,1);assert.equal(providerHealth.get(provider.backend+':'+provider.model)?.state,health);
  }
});
