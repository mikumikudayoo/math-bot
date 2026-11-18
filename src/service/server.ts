import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serviceConfig, type ServiceConfig } from './config.js';
import { Store } from './store.js';
import { Scheduler, type Runner } from './scheduler.js';
import { runner } from './inference.js';
import { DiscordBroker } from './discord-broker.js';
import { currentUser } from '../discord-context.js';
import { UserError, type Submission, type JobKind } from './types.js';
import { providerHealth } from './providers.js';
import {imageAttachments} from './vision.js';
import { UsageLedger } from './openai-budget.js';
import { describeOpenAIConfig } from './openai-config.js';
import { JobEvents } from './events.js';
import { rowProvenance } from './provenance.js';
import { contextSnapshot } from './context-snapshot.js';
import { loadProtectedProblems, protectedDatabasePath, guardPublication, isRefusal, type ProtectedProblem } from './mpotd-guard.js';
import { stripInvisible } from './invisible.js';

function text(value:unknown,name:string,max=100):string {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new UserError(`Invalid ${name}.`);return value;
}
function id(value:unknown,name:string){const s=text(value,name);if(!/^\d{17,20}$/.test(s))throw new UserError(`Invalid ${name}.`);return s;}
export function createService(config:ServiceConfig, injected?:Runner, protectedProblems: (guild: string) => ProtectedProblem[] =
  guild => loadProtectedProblems(guild, protectedDatabasePath(config.mode))) {
  mkdirSync(dirname(config.database),{recursive:true});
  const store=new Store(config.database);
  const discord=new DiscordBroker();
  const events = new JobEvents(store.db);
  const ledger = config.openai ? new UsageLedger(store.db, config.openai) : undefined;
  const scheduler=new Scheduler(store,config,injected??runner(config,store,{events,protectedProblems,discord:(job,tool,args,signal)=>discord.request(job,tool,args,signal)}),events);
  const prune = setInterval(() => events.prune(), 3_600_000);
  prune.unref();
  const server=createServer(async(req,res)=>{
    const send=(code:number,body:unknown)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    const provided=Buffer.from(req.headers.authorization??'');const expected=Buffer.from(`Bearer ${config.secret}`);
    if(provided.length!==expected.length||!timingSafeEqual(provided,expected)){send(401,{error:'Unauthorized'});return;}
    try{
      const url=new URL(req.url??'/','http://localhost');
      if(req.method==='GET'&&url.pathname==='/discord-tools'){send(200,discord.take());return;}
      if(req.method==='GET'&&url.pathname==='/health'){send(200,{ok:true,provider:config.openai?'openai':'legacy',modelConfigured:!!(config.backend&&config.model),vision:!!config.visionProvider,sandbox:config.sandbox,externalConfigured:!!config.external?.backendKey,providers:[...providerHealth.values()]});return;}
      // Estimated spend only; the ledger stores no prompt or answer text.
      if(req.method==='GET'&&url.pathname==='/usage'){send(200,ledger?.summary() ?? {provider:'legacy'});return;}
      if(req.method==='GET'&&url.pathname==='/events'){
        const job=id(url.searchParams.get('job'),'job');
        const after=Number(url.searchParams.get('after') ?? 0);
        if(!Number.isSafeInteger(after)||after<0)throw new UserError('Invalid event cursor.');
        if(!store.get(job)){send(404,{error:'Job not found'});return;}
        send(200,events.since(job,after));return;
      }
      if(req.method==='GET'&&url.pathname==='/unbound'){send(200,store.unbound());return;}
      if(req.method==='GET'&&url.pathname==='/pending'){
        const order=store.queued().map(x=>x.id);
        send(200,store.pending().map(job=>{
          const progress=events.progress(job.id);
          const terminal=['completed','failed','cancelled'].includes(job.state);
          return {...job,...(job.state==='queued'&&order.includes(job.id)?{status:`queued · priority position ${order.indexOf(job.id)+1}`}:{}),
            ...(progress?{progress}:{}),...(terminal?{deliveryParts:store.deliveryParts(job.id)}:{})};
        }));return;
      }
      if(req.method==='GET'&&url.pathname==='/queue'){
        const guild=id(url.searchParams.get('guild'),'guild');const user=id(url.searchParams.get('user'),'user');
        const rows=store.db.prepare("SELECT id,state,status FROM jobs WHERE guild=? AND user=? AND state IN ('queued','running') ORDER BY created").all(guild,user);
        send(200,rows);return;
      }
      if(req.method==='GET'&&url.pathname==='/parent'){
        const job=store.byMessage(id(url.searchParams.get('guild'),'guild'),id(url.searchParams.get('channel'),'channel'),id(url.searchParams.get('message'),'message'));
        send(200,job??null);return;
      }
      if(req.method==='GET'&&url.pathname==='/settings'){
        const guild=id(url.searchParams.get('guild'),'guild');send(200,{enabled:store.enabled(guild),rules:store.rules(guild)});return;
      }
      if(req.method!=='POST'){send(404,{error:'Not found'});return;}
      const maxBytes=url.pathname==='/jobs'?131072:url.pathname==='/discord-tools'?65536:20000;
      const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>maxBytes)throw new UserError('Request too large.');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
      switch(url.pathname){
        case '/discord-tools':send(200,{ok:discord.finish(text(body.id,'id'),body.result)});break;
        case '/jobs':{
          const kind=text(body.kind,'kind') as JobKind;
          if(!['ask','calculate','plot','python'].includes(kind))throw new UserError('Unknown request kind.');
          if(kind==='ask'&&(!config.backend||!config.model)&&!injected)throw new UserError('No AI model is connected yet. /calculate and /plot can still work.');
          if(kind==='python'&&!config.sandbox)throw new UserError('Sandboxed Python is not enabled.');
          const input:Submission={id:id(body.id,'id'),guild:id(body.guild,'guild'),channel:id(body.channel,'channel'),user:id(body.user,'user'),
            coach:body.coach===true,kind,prompt:text(typeof body.prompt==='string'?stripInvisible(body.prompt):body.prompt,'prompt',8000),
            ...(body.parent?{parent:id(body.parent,'parent')}:{}),...(body.image?{image:text(body.image,'image',2000)}:{})};
          input.discordContext=JSON.stringify({...currentUser(input.user,input.guild,body.discordContext),channelId:input.channel});
          if(body.sourceMessageId)input.sourceMessageId=id(body.sourceMessageId,'sourceMessageId');
          if(body.images!==undefined)input.images=JSON.stringify(imageAttachments(body.images));
          const snapshot=contextSnapshot(body.context,{channel:input.channel,sourceMessageId:input.sourceMessageId??input.id});
          if(config.openai && snapshot && (snapshot.reply || snapshot.chain.length || snapshot.recent.length))input.context=JSON.stringify(snapshot);
          const job=store.admit(input,config.maxQueue);scheduler.tick();send(200,job);break;
        }
        case '/bind':send(200,store.bind(id(body.id,'id'),id(body.message,'message')));break;
        case '/delivery-part':{
          store.bindDeliveryPart(id(body.id,'job'),Number(body.index),id(body.message,'message'),body.previous===undefined?undefined:id(body.previous,'previous'));
          send(200,{ok:true});break;
        }
        case '/publication':{
          const job=store.get(id(body.id,'job'));
          const content=text(body.content,'content',2000);
          let allowed=false;
          if (body.streamSeq!==undefined || body.streamUpdated!==undefined) {
            const progress=job && events.progress(job.id);
            if (!job || job.state!=='running' || rowProvenance(job).classification!=='public' || progress?.phase!=='output_delta' ||
                !progress.stream || progress.seq!==body.streamSeq || progress.updated!==body.streamUpdated) {
              send(200,{allowed:false});break;
            }
          }
          if(job?.state==='failed' && !job.artifact && isRefusal(job.answer) && content===job.answer) allowed=true;
          else if(job){
            try {
              const problems=protectedProblems(job.guild);
              guardPublication(problems,job,job.protectionVersion);
              guardPublication(problems,{...job,answer:content},job.protectionVersion);
              allowed=true;
            } catch { /* Withhold content when the release state cannot be verified. */ }
          }
          send(200,{allowed});break;
        }
        case '/delivered':store.delivered(id(body.id,'id'));send(200,{ok:true});break;
        case '/cancel':{
          const job=store.get(id(body.id,'id'));
          if(!job||job.guild!==body.guild||job.user!==body.user)throw new UserError('You can only cancel your own request in this server.');
          scheduler.cancel(job.id);send(200,{ok:true});break;
        }
        case '/settings':{
          if(body.moderator!==true)throw new UserError('Moderator permission required.');
          if(typeof body.enabled!=='boolean')throw new UserError('Invalid enabled state.');
          store.setEnabled(id(body.guild,'guild'),body.enabled,id(body.user,'user'));send(200,{ok:true});break;
        }
        case '/rules':{
          if(body.moderator!==true)throw new UserError('Moderator permission required.');
          const guild=id(body.guild,'guild');const user=id(body.user,'user');
          if(body.remove!==undefined){if(!Number.isSafeInteger(body.remove))throw new UserError('Invalid rule ID.');store.removeRule(guild,body.remove as number);}
          else {const term=text(body.term,'term',100).normalize('NFKC').toLowerCase().trim();if(!['flag','delete'].includes(String(body.action)))throw new UserError('Invalid action.');store.addRule(guild,term,String(body.action));}
          store.audit(guild,user,'filter rule changed');send(200,{ok:true});break;
        }
        case '/audit':store.audit(id(body.guild,'guild'),id(body.user,'user'),text(body.event,'event',1000));send(200,{ok:true});break;
        default:send(404,{error:'Not found'});
      }
    }catch(error){send(error instanceof UserError?400:500,{error:error instanceof UserError?error.message:'Service request failed.'});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.once('listening',()=>{store.recover();events.recover();scheduler.tick();});
  return {server,store,scheduler,events,async close(){clearInterval(prune);scheduler.stop();discord.close();await new Promise<void>(resolve=>server.close(()=>resolve()));while(scheduler.active.size)await new Promise(r=>setTimeout(r,20));store.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const config=serviceConfig();const service=createService(config);
    service.server.listen(config.port,'127.0.0.1',()=>{console.log(`AI service listening on 127.0.0.1:${config.port}; model ${config.model?'configured':'not configured'}.`);if(config.openai)console.log('OpenAI provider enabled',describeOpenAIConfig(config.openai));});
    service.server.on('error',()=>{console.error('AI service could not listen. Check its port.');process.exitCode=1;});
    for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void service.close());
  }catch(error){console.error(error instanceof Error?error.message:'AI service startup failed.');process.exitCode=1;}
}
