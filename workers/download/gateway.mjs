const paths = /^(?:apk\/arcaea\/(\d+\.\d+\.\d+[a-z]?)\/[a-f0-9]{64}\/Arcaea_\1\.apk|objects\/[a-f0-9]{64}\/(?:jpg|jpeg|png|webp))$/;
const reject = (status, extra = {}) => new Response(null,{status,headers:{'Cache-Control':'no-store',...extra}});
function byteRange(raw,size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m || !(m[1] || m[2])) return null;
  const a=Number(m[1]), b=Number(m[2]);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  const offset=m[1]?a:Math.max(0,size-b), end=m[1]&&m[2]?Math.min(b,size-1):size-1;
  return offset<=end?{offset,length:end-offset+1}:null;
}
export default {async fetch(req,env) {
  const url=new URL(req.url), key=url.pathname.slice(1);
  if(url.origin!=='https://dl.rhythmarchive.top'||url.search||!paths.test(key)) return reject(404);
  if(!['HEAD','GET'].includes(req.method)) return reject(405,{Allow:'HEAD, GET'});
  try {
    // Reserve worst-case R2 reads atomically; never refund failed or partial requests.
    const cost=req.method==='HEAD'?1:2;
    const q=await env.BUDGET.prepare("UPDATE download_read_budget SET remaining=remaining-?1 WHERE utc_month=strftime('%Y-%m','now') AND remaining>=?1").bind(cost).run();
    if(q.meta.changes!==1) return reject(503);
    const obj=await env.FILES.head(key);
    if(!obj) return reject(404);
    const headers=new Headers(); obj.writeHttpMetadata(headers);
    headers.set('Content-Length',String(obj.size)); headers.set('Accept-Ranges','bytes'); headers.set('ETag',obj.httpEtag);
    headers.set('Cache-Control','public, max-age=31536000, immutable');headers.set('X-Content-Type-Options','nosniff');
    if(req.method==='HEAD') return new Response(null,{headers});
    let range; const raw=req.headers.get('Range'), tag=req.headers.get('If-Range');
    if(raw!==null&&(!tag||tag===obj.httpEtag)) {
      range=byteRange(raw,obj.size);
      if(!range) return reject(416,{'Content-Range':`bytes */${obj.size}`});
      headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${obj.size}`); headers.set('Content-Length',String(range.length));
    }
    const data=await env.FILES.get(key,{onlyIf:{etagMatches:obj.etag},...(range?{range}:{})});
    if(!data?.body) return reject(503);
    return new Response(data.body,{status:range?206:200,headers});
  } catch {return reject(503);}
}};
