import { AsyncLocalStorage } from 'node:async_hooks';
import { isLiveAd, isLiveEffective } from './live-ads.ts';
export type Cause = 'timeout'|'rate_limit'|'transient'|'policy'|'permission'|'validation'|'unknown';
export const retryable = (cause: Cause) => !['policy','permission','validation'].includes(cause);
export function classify(status: number, e: any = {}): Cause {
  const code = Number(e.code), sub = Number(e.error_subcode);
  const msg = `${e.message ?? ''} ${e.error_user_msg ?? ''}`.toLowerCase();
  if ([368,506].includes(code) || [18157520,2446211].includes(sub) || /disapproved|policy violation|integrity|advertising policies/.test(msg)) return 'policy';
  if ([10,190,200,294].includes(code) || [458,459,460,463,464,467].includes(sub) || /expired.*token|invalid.*token|missing permission/.test(msg) || status === 401 || status === 403) return 'permission';
  if ([4,17,32,613,80000,80003,80004,80014].includes(code) || [1487742,2446079].includes(sub) || status === 429) return 'rate_limit';
  if (status === 408 || status === 504 || /timeout|timed out|abort/.test(msg)) return 'timeout';
  if (e.is_transient === true || [1,2].includes(code)) return 'transient';
  if ([100,2500].includes(code) || /invalid parameter|bad parameter|must be|missing required/.test(msg)) return 'validation';
  if(status>=500)return 'transient';
  return 'unknown';
}
export function usage(headers: Headers) {
  const raw: Record<string,unknown> = {}; let seconds = 0;
  const scan = (v: any) => { if (!v || typeof v !== 'object') return; for (const [k,x] of Object.entries(v)) {
    // Meta documents this field in MINUTES (including nested business arrays).
    if (k === 'estimated_time_to_regain_access') seconds = Math.max(seconds, Number(x)*60 || 0); else scan(x);
  }};
  for (const h of ['x-business-use-case-usage','x-ad-account-usage','x-app-usage']) {
    const value=headers.get(h); if (!value) continue;
    try { raw[h]=JSON.parse(value); scan(raw[h]); } catch { raw[h]=value; }
  }
  return {raw,seconds};
}
export function recoveryDecision(job: any, cause: Cause, wait = 0, now = Date.now()) {
  const failures=Number(job.failure_count||0)+1;
  const exhausted=now-Date.parse(job.first_started_at||new Date(now).toISOString()) >= 6*3600_000;
  const stop=!retryable(cause)||exhausted||(Number(job.completed_items||0)===0&&!(job.journal?.meta??[]).some((x:any)=>x.method==='POST'&&x.data?.id)&&failures>=2);
  const delay=Math.max([60,120,300,600,900][Math.min(failures-1,4)],wait);
  return {status:stop?'needs_fix':'retry',failure_count:failures,next_attempt_at:new Date(now+delay*1000).toISOString()};
}
export class Handoff extends Error { constructor(){super('Scheduled continuation');} }
export class MetaFailure extends Error { constructor(public override cause: Cause, public evidence: any){super(evidence.message||cause);} }
export const execution = new AsyncLocalStorage<any>();
async function checked(q: any) { const r=await q; if(r.error) throw new Error(`Recovery persistence: ${r.error.message}`); return r; }
// Jobs keyed on the ad request (one per campaign) rather than an optimization card.
const AR_KEYED=['launch-campaign','ensure-retargeting-adset'];
export async function enqueue(service: any, functionName: string, row: any, body: any) {
  const key=AR_KEYED.includes(functionName)?'ad_request_id':'optimization_id'; const id=row.id;
  const {data:existing}=await service.from('apply_jobs').select('*').eq(key,id).eq('function_name',functionName).maybeSingle();
  if(existing && ['queued','retry','running','needs_fix'].includes(existing.status)) return existing;
  const payload={function_name:functionName,optimization_id:AR_KEYED.includes(functionName)?null:row.id,
    ad_request_id:AR_KEYED.includes(functionName)?row.id:row.ad_request_id,business_id:row.business_id,
    bundle_id:row.bundle_id??null,approved_body:body,status:'queued',journal:[],failure_count:0,completed_items:0,attempt_count:0,next_attempt_at:new Date().toISOString()};
  const {data}=await checked(existing?service.from('apply_jobs').update(payload).eq('id',existing.id).select().single():service.from('apply_jobs').insert(payload).select().single()); return data;
}
export function durableService(base: any): any {
  return new Proxy(base,{get(target,key){
    if(key!=='from') return Reflect.get(target,key);
    return (table: string) => {
      const ctx=execution.getStore(); if(!ctx||ctx.verify||table==='app_settings') return target.from(table);
      let q=target.from(table); const ops:any[]=[];
      const proxy:any=new Proxy({}, {get(_t,k){
        if(k==='then') return (resolve:any,reject:any)=> (async()=>{
          const n=ctx.dbIndex++; const prior=ctx.dbJournal[n];
          const shape=ops.map(([k,a]:any[])=>[k,k==='update'||k==='insert'?Object.keys(a[0]??{}).sort():a]);
          const signature=JSON.stringify(shape);
          if(prior) {if(prior.table!==table||prior.signature!==signature)throw new MetaFailure('validation',{message:'Stored execution no longer matches this code path'});return structuredClone(prior.result);}
          if(ctx.failure) throw ctx.failure;
          if(ctx.yielded) throw new Handoff();
          // Terminal state is committed only by the worker after read-back succeeds.
          const r=await q; if(r.error) throw new Error(r.error.message);
          ctx.dbJournal[n]={table,signature,result:structuredClone(r)};
          await checked(ctx.base.from('apply_jobs').update({journal:{meta:ctx.journal,db:ctx.dbJournal}}).eq('id',ctx.job.id));
          return r;
        })().then(resolve,reject);
        return (...args:any[])=>{
          if(k==='update'&&table==='optimizations'&&args[0]?.status) {
            args[0]={...args[0]}; if(args[0].status==='applied') ctx.applied=true;
            delete args[0].status; delete args[0].applied_at;
          }
          ops.push([k,args]); q=q[k](...args); return proxy;
        };
      }}); return proxy;
    };
  }});
}
export async function durableMeta(base: any, method: string, path: string, body: any, token: string, apiBase: string) {
  const ctx=execution.getStore();
  if(!ctx) {
    if(method!=='GET') throw new Error('Meta mutations require a durable execution job');
    const p=new URLSearchParams({access_token:token});for(const[k,v]of Object.entries(body??{}))if(v!=null)p.set(k,typeof v==='string'?v:JSON.stringify(v));
    const r=await fetch(`${apiBase}/${path}?${p}`,{signal:AbortSignal.timeout(25000)});const d=await r.json();if(!r.ok||d.error)throw new MetaFailure(classify(r.status,d.error),d.error??{message:`HTTP ${r.status}`});return d;
  }
  ctx.reads=ctx.reads??0;
  const n=ctx.index++; const prior=ctx.verify?null:ctx.journal[n];
  if(prior) {if(prior.method!==method||prior.path!==path)throw new MetaFailure('validation',{message:'Stored Meta execution no longer matches this code path'});return structuredClone(prior.data);}
  if(ctx.failure) throw ctx.failure;
  if(ctx.yielded||ctx.writes>=1||(!ctx.verify&&ctx.reads>=3)) {ctx.yielded=true;throw new Handoff();}
  const step=path.endsWith('/adcreatives')?'create_creative':path.endsWith('/ads')?'create_ad':path.endsWith('/adsets')?'create_adset':path.endsWith('/customaudiences')?'create_audience':path.endsWith('/copies')?'copy_adset':method==='GET'?'verify':body?.status==='PAUSED'?'pause_old':'update_ad';
  ctx.lastStep=step;
  const started=Date.now(); const attemptId=crypto.randomUUID();
  const common={job_id:ctx.job.id,invocation_id:ctx.job.invocation_id,kind:'meta',optimization_id:ctx.job.optimization_id,bundle_id:ctx.job.bundle_id,business_id:ctx.job.business_id,
    ad_id:ctx.adId??(/^[0-9]+$/.test(path)?path:null),ad_name:ctx.adName??body?.name??null,step,endpoint:path,method,attempt_number:ctx.job.attempt_count,started_at:new Date(started).toISOString()};
  await checked(base.from('apply_jobs').update({last_step:step}).eq('id',ctx.job.id));
  await checked(base.from('apply_attempts').insert({id:attemptId,...common}));
  const marker=`[MC:${ctx.job.id}:${n}]`;
  if(method==='POST'&&body?.name&&/\/(ads|adsets|adcreatives|campaigns|customaudiences)$/.test(path))body={...body,name:`${String(body.name).slice(0,330)} ${marker}`};
  const params=new URLSearchParams({access_token:token}); for(const [k,v]of Object.entries(body??{})) if(v!=null) params.set(k,typeof v==='string'?v:JSON.stringify(v));
  let res:Response = new Response('{}'); let data:any; let headers:any={raw:{},seconds:0};
  try {
    const freshRead=async(readPath:string,readParams:string,readStep:string)=>{
      const id=crypto.randomUUID(),at=Date.now();await checked(base.from('apply_attempts').insert({...common,id,method:'GET',endpoint:readPath,step:readStep,started_at:new Date(at).toISOString()}));
      try {const r=await fetch(`${apiBase}/${readPath}?${readParams}&access_token=${encodeURIComponent(token)}`,{signal:AbortSignal.timeout(20000)});const d=await r.json(),u=usage(r.headers);const e=d.error;await checked(base.from('apply_attempts').update({http_status:r.status,usage_headers:u.raw,regain_access_seconds:u.seconds,meta_error_code:e?.code??null,error_subcode:e?.error_subcode??null,error_type:e?.type??null,is_transient:e?.is_transient??null,error_user_title:e?.error_user_title??null,error_user_msg:e?.error_user_msg??null,fbtrace_id:e?.fbtrace_id??null,message:e?.message??null,cause:e?classify(r.status,e):null,ended_at:new Date().toISOString(),elapsed_ms:Date.now()-at,outcome:e?'error':'success'}).eq('id',id));if(!r.ok||e)throw new MetaFailure(classify(r.status,e),{...e,wait:u.seconds});return d;}catch(e:any){await checked(base.from('apply_attempts').update({ended_at:new Date().toISOString(),elapsed_ms:Date.now()-at,message:e.message,cause:e.cause??classify(0,{message:e.message}),outcome:'error'}).eq('id',id));throw e;}
    };
    // Fresh safety read before replacing or pausing an existing ad/adset; never mutate something no
    // longer live. "Live" = effective_status ACTIVE or in review (2026-10-25 rule), which already
    // accounts for a paused ad set or campaign — an ad in a paused set is left alone.
    if(method==='POST'&&path.endsWith('/ads')&&ctx.adId){
      const original=await freshRead(ctx.adId,'fields=effective_status','live_check');
      if(!isLiveEffective(original.effective_status))throw new MetaFailure('unknown',{message:`not live, left alone: ${ctx.adName??ctx.adId}; original effective_status ${original.effective_status??'unknown'}`});
    }
    if(method==='POST'&&body?.status==='PAUSED'&&/^\d+$/.test(path)) {
      const state=await freshRead(path,'fields=effective_status','live_check');
      if(!isLiveEffective(state.effective_status)) {data={success:true,not_live_left_alone:path};res=new Response('{}',{status:200});}
    }
    if(!data) {
      if(method==='POST'&&body?.name&&/\/(ads|adsets|adcreatives|campaigns|customaudiences)$/.test(path)) {
        const {data:oldAttempts}=await base.from('apply_attempts').select('id').eq('job_id',ctx.job.id).eq('endpoint',path).eq('step',step).eq('ad_name',common.ad_name).limit(2);
        if((oldAttempts??[]).length>1){
          let after:string|undefined;
          for(let page=0;page<20;page++){
            const values=await freshRead(path,`fields=id,name&limit=100${after?`&after=${encodeURIComponent(after)}`:''}`,'reconcile');
            const match=values.data?.find((v:any)=>v.name?.includes(marker));if(match){data={id:match.id,reconciled:true};res=new Response('{}',{status:200});break;}
            after=values.paging?.next?values.paging?.cursors?.after:undefined;if(!after)break;
            if(page===19)throw new MetaFailure('unknown',{message:'Create reconciliation incomplete; retrying read before any duplicate write'});
          }
        }
      }
      if(!data) {
      if(method==='POST') {const gap=1000-(Date.now()-ctx.lastWrite);if(gap>0)await new Promise(r=>setTimeout(r,gap));ctx.lastWrite=Date.now();}
      res=await fetch(method==='GET'?`${apiBase}/${path}?${params}`:`${apiBase}/${path}`,{method,...(method==='POST'?{body:params}:{}),signal:AbortSignal.timeout(25000)});
      headers=usage(res.headers); const text=await res.text();try{data=JSON.parse(text)}catch{data={error:{message:text}};}
      if(!res.ok||data?.error) {
        const e=data.error??{message:`HTTP ${res.status}`}; const cause=classify(res.status,e);
        await checked(base.from('apply_attempts').update({http_status:res.status,meta_error_code:e.code??null,error_subcode:e.error_subcode??null,error_type:e.type??null,is_transient:e.is_transient??null,error_user_title:e.error_user_title??null,error_user_msg:e.error_user_msg??null,fbtrace_id:e.fbtrace_id??null,message:e.message,cause,usage_headers:headers.raw,regain_access_seconds:headers.seconds,ended_at:new Date().toISOString(),elapsed_ms:Date.now()-started,outcome:'error'}).eq('id',attemptId));
        ctx.failure=new MetaFailure(cause,{...e,wait:headers.seconds,http_status:res.status});throw ctx.failure;
      }
      }
    }
    await checked(base.from('apply_attempts').update({http_status:res?.status??200,usage_headers:headers.raw,ended_at:new Date().toISOString(),elapsed_ms:Date.now()-started,outcome:'success'}).eq('id',attemptId));
    if(!ctx.progressExplicit&&!ctx.verify&&method==='GET'&&path.endsWith('/ads')&&Array.isArray(data.data)&&!ctx.job.total_items){ctx.job.total_items=data.data.filter(isLiveAd).length;await checked(base.from('apply_jobs').update({total_items:ctx.job.total_items}).eq('id',ctx.job.id));}
    if(method==='GET')ctx.reads=(ctx.reads??0)+1;
    if(!ctx.verify){
    ctx.journal[n]={data,method,path,step,ad_id:common.ad_id,ad_name:common.ad_name};if(method==='POST')ctx.writes++;
    const jobPatch:any={journal:{meta:ctx.journal,db:ctx.dbJournal}};
    if(!ctx.progressExplicit)jobPatch.completed_items=ctx.journal.filter((x:any)=>x?.step==='pause_old'&&x?.data?.success).length;
    await checked(base.from('apply_jobs').update(jobPatch).eq('id',ctx.job.id));
    }
    return data;
  }catch(e:any){
    if(!ctx.failure){ctx.failure=e instanceof MetaFailure?e:new MetaFailure(classify(0,{message:e.message}),{message:e.message});await checked(base.from('apply_attempts').update({cause:ctx.failure.cause,message:e.message,ended_at:new Date().toISOString(),elapsed_ms:Date.now()-started,outcome:'error'}).eq('id',attemptId));}
    throw ctx.failure;
  }
}

// Explicit done/left accounting. Each action knows its own unit of work (an ad swapped, a slot paused,
// a budget change), so the handler reports progress instead of relying on journal heuristics. Counts are
// monotonic within a job: a later report never lowers completed_items.
export async function reportProgress(done:number,total?:number){
 const ctx=execution.getStore();if(!ctx)return;
 ctx.progressExplicit=true;
 const completed=Math.max(Number(ctx.job.completed_items||0),done);
 const patch:any={completed_items:completed};
 if(total!=null){patch.total_items=total;ctx.job.total_items=total;}
 ctx.job.completed_items=completed;
 await checked(ctx.base.from('apply_jobs').update(patch).eq('id',ctx.job.id));
}

export async function runDurableHandler(ctx:any,req:Request,handler:(req:Request)=>Promise<Response>){
 const trusted=new Request(req.url,{method:req.method,headers:req.headers,body:JSON.stringify({...ctx.job.approved_body,recovery_job_id:ctx.job.id,recovery_invocation_id:ctx.job.invocation_id})});
 return execution.run(ctx,async()=>{try{return await handler(trusted);}catch(e:any){
  const failure=ctx.failure??(e instanceof MetaFailure?e:null);
  const payload=failure?{error:failure.message,cause:failure.cause,fbtrace_id:failure.evidence.fbtrace_id,wait_seconds:failure.evidence.wait}:ctx.yielded?{ok:true,continuation:true}:{error:e.message,cause:classify(0,{message:e.message})};
  return new Response(JSON.stringify(payload),{status:ctx.yielded&&!failure?202:503,headers:{'Content-Type':'application/json'}});
 }});
}
