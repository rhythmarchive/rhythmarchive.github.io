import copies from '../../catalog/r2-downloads.json' with { type: 'json' };
const site = 'https://rhythmarchive.github.io';
const origin = 'https://dl.rhythmarchive.top';
const paths = /^(?:apk\/arcaea\/(\d+\.\d+\.\d+[a-z]?)\/[a-f0-9]{64}\/Arcaea_\1\.apk|objects\/[a-f0-9]{64}\/(?:jpg|jpeg|png|webp|mp4))$/;
const reject = (status, extra = {}) => new Response(null,{status,headers:{'Cache-Control':'no-store',...extra}});
function byteRange(raw,size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m || !(m[1] || m[2])) return null;
  const a=Number(m[1]), b=Number(m[2]);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  const offset=m[1]?a:Math.max(0,size-b), end=m[1]&&m[2]?Math.min(b,size-1):size-1;
  return offset<=end?{offset,length:end-offset+1}:null;
}
export default {async fetch(req,env,ctx) {
  const url=new URL(req.url), key=url.pathname.slice(1);
  // Older Pages clients still call this before falling back. It validates the caller and key without reserving bytes.
  if (url.origin === origin && key.startsWith('fallback/') && !url.search) {
    if (req.method !== 'POST' || req.headers.get('Origin') !== site || !Object.hasOwn(copies, key.slice(9))) return reject(403);
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': site, 'Cache-Control': 'no-store' } });
  }
  if (url.origin !== origin || url.search || (!paths.test(key) && key !== 'apk/arcaea/latest.json')) return reject(404);
  const asset = key.startsWith('objects/');
  if (asset && !Object.hasOwn(copies, key)) return reject(404, { 'Access-Control-Allow-Origin': site });
  if (req.method === 'OPTIONS' && req.headers.get('Origin') === site) {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': site, 'Access-Control-Allow-Methods': 'GET, HEAD',
      'Access-Control-Allow-Headers': 'Range, If-Range', 'Access-Control-Max-Age': '600', 'Vary': 'Origin',
    } });
  }
  if (!['HEAD', 'GET'].includes(req.method)) return reject(405, { Allow: 'HEAD, GET, OPTIONS' });
  try {
    // Only immutable catalog objects have a shared cache key. Never cache APKs, partial responses, permits or failures.
    const full=asset && !req.headers.has('Range');
    const cache=full?globalThis.caches?.default:undefined;
    const cached=cache?await cache.match(url.href):undefined;
    if(cached){const headers=new Headers(cached.headers);headers.set('X-Archive-Cache','HIT');return new Response(req.method==='HEAD'?null:cached.body,{headers});}
    // Limit bursts against one object per client. Cache hits and unrelated objects are independent.
    const ip = req.headers.get('CF-Connecting-IP');
    if (ip && env.RATE_LIMITER) {
      const limit = await env.RATE_LIMITER.limit({ key: `${ip}:${key}` }).catch(() => null);
      if (limit?.success === false) return reject(429, { 'Retry-After': '60', 'Access-Control-Allow-Origin': site });
    }
    const direct=full&&req.method==='GET';
    const obj=direct?await env.FILES.get(key):await env.FILES.head(key);
    if (!obj) return reject(404, { 'Access-Control-Allow-Origin': site });
    if (asset && obj.size !== copies[key]) return reject(503, { 'Access-Control-Allow-Origin': site });
    const headers=new Headers(); obj.writeHttpMetadata(headers);
    headers.set('Access-Control-Allow-Origin',site); headers.set('Access-Control-Expose-Headers','ETag, Content-Range');
    headers.set('Content-Length',String(obj.size)); headers.set('Accept-Ranges','bytes'); headers.set('ETag',obj.httpEtag);
    headers.set('Cache-Control',key==='apk/arcaea/latest.json'?'public, max-age=60':'public, max-age=31536000, immutable');headers.set('X-Content-Type-Options','nosniff');
    if(req.method==='HEAD') return new Response(null,{headers});
    if(direct){
      if (!obj.body) return reject(503, { 'Access-Control-Allow-Origin': site });
      headers.set('X-Archive-Cache','MISS');const response=new Response(obj.body,{headers});
      if(cache && ctx && obj.size<=8_000_000)ctx.waitUntil(cache.put(url.href,response.clone()).catch(()=>{}));
      return response;
    }
    let range; const raw=req.headers.get('Range'), tag=req.headers.get('If-Range');
    if(raw!==null&&(!tag||tag===obj.httpEtag)) {
      range=byteRange(raw,obj.size);
      if(!range) return reject(416, { 'Content-Range': `bytes */${obj.size}`, 'Access-Control-Allow-Origin': site, 'Access-Control-Expose-Headers': 'Content-Range' });
      headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${obj.size}`); headers.set('Content-Length',String(range.length));
    }
    const data=await env.FILES.get(key,{onlyIf:{etagMatches:obj.etag},...(range?{range}:{})});
    if (!data?.body) return reject(503, { 'Access-Control-Allow-Origin': site });
    return new Response(data.body,{status:range?206:200,headers});
  } catch { return reject(503, { 'Access-Control-Allow-Origin': site }); }
}};
