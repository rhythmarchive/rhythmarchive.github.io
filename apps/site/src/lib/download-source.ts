// No probes. A second failed foreground request opens a short session circuit.
let failures = 0, until = 0;
export async function fetchDownload(primary: string, backup: string | undefined, signal?: AbortSignal) {
  const options = {credentials: "omit", referrerPolicy: "strict-origin-when-cross-origin", ...(signal ? {signal} : {})} as const;
  if (!backup) return {response: await fetch(primary,options), automatic: false};
  let failure: unknown, response: Response | undefined;
  if (Date.now() >= until) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),15000);
    try {
      response = await fetch(primary,{...options,signal:AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])});
      if (response.ok) {failures=0;until=0;return {response,automatic:false};}
    } catch(error) {failure=error;} finally {clearTimeout(timer);}
    signal?.throwIfAborted();
    if (++failures < 2) {if(response)return {response,automatic:false};throw failure;}
    until=Date.now()+60000;
  }
  const grant=await fetch(new URL('/fallback'+new URL(primary).pathname,primary),{...options,method:'POST',signal:AbortSignal.any([AbortSignal.timeout(3500),...(signal?[signal]:[])])});
  if(grant.status!==204) throw new Error('备用下载流量未获分配');
  return {response:await fetch(backup,options),automatic:true};
}
