import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync,writeFileSync,chmodSync,mkdirSync } from 'node:fs';
import { automationConfig } from '../announcements/config.js';

// Run locally with an OAuth Desktop client. Saves the refresh token privately;
// never emits tokens, OAuth client values, callback queries or response bodies.
const mode=process.env.BOT_ENV??'development';const cfg=automationConfig(mode),state=randomBytes(24).toString('hex');
if(!cfg.gmail.clientId||!cfg.gmail.clientSecret)throw new Error(`Paste the desktop OAuth client settings privately into .env.automation.${mode} first.`);
const redirect='http://127.0.0.1:8765/oauth/callback';
const server=createServer(async(req,res)=>{
  try{const url=new URL(req.url??'/','http://127.0.0.1:8765');if(url.pathname!=='/oauth/callback'||url.searchParams.get('state')!==state||!url.searchParams.get('code'))throw new Error('Invalid callback.');
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:url.searchParams.get('code')!,client_id:cfg.gmail.clientId,client_secret:cfg.gmail.clientSecret,redirect_uri:redirect,grant_type:'authorization_code'})});
    if(!response.ok){await response.body?.cancel();throw new Error('OAuth exchange failed.');}
    const data=await response.json() as {refresh_token?:string;scope?:string};if(!data.refresh_token||data.scope!=='https://www.googleapis.com/auth/gmail.readonly')throw new Error('A fresh read-only consent is required.');
    const path=`.env.automation.${mode}`;let env=readFileSync(path,'utf8');const line=`GMAIL_REFRESH_TOKEN=${data.refresh_token}`;env=/^GMAIL_REFRESH_TOKEN=.*$/m.test(env)?env.replace(/^GMAIL_REFRESH_TOKEN=.*$/m,line):env+'\n'+line+'\n';writeFileSync(path,env,{mode:0o600});chmodSync(path,0o600);
    res.end('Read-only Gmail authorization saved privately. You may close this tab.');console.log(`Read-only refresh token saved to ${path}; token was not printed.`);server.close();
  }catch{res.writeHead(400);res.end('Authorization failed. No token was printed. Restart and try again.');}
});
server.listen(8765,'127.0.0.1',()=>{
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');Object.entries({client_id:cfg.gmail.clientId,redirect_uri:redirect,response_type:'code',scope:'https://www.googleapis.com/auth/gmail.readonly',access_type:'offline',prompt:'consent',state}).forEach(([k,v])=>url.searchParams.set(k,v));
  // The authorization URL includes a client identifier. Save it privately instead of logging it.
  mkdirSync('.cache',{recursive:true,mode:0o700});writeFileSync('.cache/gmail-authorization-url.txt',url.toString(),{mode:0o600});console.log('Open the URL in .cache/gmail-authorization-url.txt in your browser. Callback listens only on 127.0.0.1:8765.');
});setTimeout(()=>server.close(),600000).unref();
