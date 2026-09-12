import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serviceConfig, type ServiceConfig } from './config.js';
import { Store } from './store.js';
import { Scheduler, type Runner } from './scheduler.js';
import { runner } from './inference.js';
import { UserError, type Submission, type JobKind } from './types.js';

function text(value:unknown,name:string,max=100):string {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new UserError(`Invalid ${name}.`);return value;
}
function id(value:unknown,name:string){const s=text(value,name);if(!/^\d{17,20}$/.test(s))throw new UserError(`Invalid ${name}.`);return s;}
export function createService(config:ServiceConfig, injected?:Runner) {
  mkdirSync(dirname(config.database),{recursive:true});
  const store=new Store(config.database);
  const scheduler=new Scheduler(store,config,injected??runner(config,store));
  const server=createServer(async(req,res)=>{
    const send=(code:number,body:unknown)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    const provided=Buffer.from(req.headers.authorization??'');const expected=Buffer.from(`Bearer ${config.secret}`);
    if(provided.length!==expected.length||!timingSafeEqual(provided,expected)){send(401,{error:'Unauthorized'});return;}
    try{
      const url=new URL(req.url??'/','http://localhost');
      if(req.method==='GET'&&url.pathname==='/health'){send(200,{ok:true,modelConfigured:!!(config.backend&&config.model),vision:config.vision,sandbox:config.sandbox});return;}
      if(req.method==='GET'&&url.pathname==='/pending'){
        const order=store.queued().map(x=>x.id);
        send(200,store.pending().map(job=>job.state==='queued'?{...job,status:`queued · priority position ${order.indexOf(job.id)+1}`} :job));return;
      }
      if(req.method==='GET'&&url.pathname==='/queue'){
        const guild=id(url.searchParams.get('guild'),'guild');const user=id(url.searchParams.get('user'),'user');
        const rows=store.db.prepare("SELECT id,state,status FROM jobs WHERE guild=? AND user=? AND state IN ('queued','running') ORDER BY created").all(guild,user);
        send(200,rows);return;
      }
      if(req.method==='GET'&&url.pathname==='/reaction-roles'){send(200,store.reactionRoles());return;}
      if(req.method==='GET'&&url.pathname==='/role-grants'){send(200,store.grants(id(url.searchParams.get('message'),'message')));return;}
      if(req.method==='GET'&&url.pathname==='/parent'){
        const job=store.byMessage(id(url.searchParams.get('guild'),'guild'),id(url.searchParams.get('channel'),'channel'),id(url.searchParams.get('message'),'message'));
        send(200,job??null);return;
      }
      if(req.method==='GET'&&url.pathname==='/settings'){
        const guild=id(url.searchParams.get('guild'),'guild');send(200,{enabled:store.enabled(guild),rules:store.rules(guild)});return;
      }
      if(req.method!=='POST'){send(404,{error:'Not found'});return;}
      const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>20000)throw new UserError('Request too large.');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
      switch(url.pathname){
        case '/reaction-roles':{
          if(body.moderator!==true)throw new UserError('Moderator permission required.');
          const guild=id(body.guild,'guild');const message=id(body.message,'message');
          if(body.remove===true)store.removeReactionRole(guild,message);
          else store.setReactionRole({guild,channel:id(body.channel,'channel'),message,role:id(body.role,'role'),emoji:text(body.emoji,'emoji',100)});
          store.audit(guild,id(body.user,'user'),'reaction role mapping changed');send(200,{ok:true});break;
        }
        case '/role-grants':{
          const message=id(body.message,'message');
          if(!store.reactionRoles().some(x=>x.message===message))throw new UserError('Reaction role mapping no longer exists.');
          store.grant(message,id(body.user,'user'),body.owned===true);send(200,{ok:true});break;
        }
        case '/jobs':{
          const kind=text(body.kind,'kind') as JobKind;
          if(!['ask','calculate','plot','python'].includes(kind))throw new UserError('Unknown request kind.');
          if(kind==='ask'&&(!config.backend||!config.model)&&!injected)throw new UserError('No AI model is connected yet. /calculate and /plot can still work.');
          if(kind==='python'&&!config.sandbox)throw new UserError('Sandboxed Python is not enabled.');
          const input:Submission={id:id(body.id,'id'),guild:id(body.guild,'guild'),channel:id(body.channel,'channel'),user:id(body.user,'user'),
            coach:body.coach===true,kind,prompt:text(body.prompt,'prompt',8000),
            ...(body.parent?{parent:id(body.parent,'parent')}:{}),...(body.image?{image:text(body.image,'image',2000)}:{})};
          const job=store.admit(input,config.maxQueue);scheduler.tick();send(200,job);break;
        }
        case '/bind':store.bind(id(body.id,'id'),id(body.message,'message'));send(200,{ok:true});break;
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
  server.once('listening',()=>{store.recover();scheduler.tick();});
  return {server,store,scheduler,async close(){scheduler.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));while(scheduler.active.size)await new Promise(r=>setTimeout(r,20));store.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const config=serviceConfig();const service=createService(config);
    service.server.listen(config.port,'127.0.0.1',()=>console.log(`AI service listening on 127.0.0.1:${config.port}; model ${config.model?'configured':'not configured'}.`));
    service.server.on('error',()=>{console.error('AI service could not listen. Check its port.');process.exitCode=1;});
    for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void service.close());
  }catch(error){console.error(error instanceof Error?error.message:'AI service startup failed.');process.exitCode=1;}
}
