import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import { UserError } from './types.js';

export function publicAddress(address: string) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function publicURL(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password) throw new UserError('Only public HTTPS URLs on port 443 are allowed.');
  return url;
}
export async function safeFetch(value: string, signal: AbortSignal, maxBytes = 1_000_000, redirects = 0): Promise<{body:Buffer;type:string;url:string}> {
  signal=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
  const url = publicURL(value);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g,''), {all:true});
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(x => !publicAddress(x.address))) throw new UserError('Local, private, and reserved network addresses are blocked.');
  const chosen = addresses[0]!;
  // The connection uses the validated address; DNS cannot change between check and connect.
  return new Promise((resolve,reject) => {
    const req = request(url, {signal, method:'GET', family:chosen.family, headers:{'User-Agent':'MathBot/0.1','Accept-Encoding':'identity'},
      lookup:(_host,_options,callback) => callback(null,chosen.address,chosen.family)}, response => {
      const code = response.statusCode ?? 500;
      if ([301,302,303,307,308].includes(code)) {
        response.resume();
        if (redirects >= 3 || !response.headers.location) { reject(new UserError('Too many redirects.')); return; }
        safeFetch(new URL(response.headers.location,url).href,signal,maxBytes,redirects+1).then(resolve,reject); return;
      }
      if (code !== 200) { response.resume(); reject(new UserError(`Web source returned HTTP ${code}.`)); return; }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); reject(new UserError('Compressed web responses are not supported.')); return; }
      const chunks:Buffer[]=[]; let bytes=0;
      response.on('data', (chunk:Buffer) => {
        bytes += chunk.length;
        if (bytes>maxBytes) { response.destroy(); reject(new UserError('Web content exceeds the size limit.')); }
        else chunks.push(chunk);
      });
      response.on('error',reject);
      response.on('end',()=>resolve({body:Buffer.concat(chunks),type:response.headers['content-type'] ?? '',url:url.href}));
    });
    req.setTimeout(15000,()=>req.destroy(new Error('Network timeout')));
    req.on('error',reject);req.end();
  });
}
export async function fetchText(url:string,signal:AbortSignal) {
  const response = await safeFetch(url,signal);
  if (!/^(text\/|application\/json)/i.test(response.type)) throw new UserError('This source is not a text page.');
  const text = response.body.toString('utf8').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,12000);
  return {url:response.url,text};
}
