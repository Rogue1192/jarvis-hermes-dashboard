// Isolated form preparation only. No ad, budget, optimization, approval or mapping writes.
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import {verifyJarvisKey} from '../_shared/jarvis-auth.ts';
import {getMetaConfig} from '../_shared/meta-config.ts';
import {durableMeta,execution} from '../_shared/apply-recovery.ts';
import {FIELDS,canonical,requireValue,sha,jobId,input,proposal,payload,checks,approval} from './logic.ts';
const FUNCTION='lead-form-build';
const json=(value:any,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
async function checked(q:any){const r=await q;if(r.error)throw new Error('Journal/database operation failed: '+r.error.code);return r.data;}
Deno.serve(async req=>{
 if(req.method!=='POST')return json({error:'POST only'},405);
 const service=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
 if(!await verifyJarvisKey(req,service))return json({error:'Unauthorized'},401);
 let b:any;try{b=input(await req.json());}catch(e:any){return json({error:e.message},400);}
 let job:any=null,owns=false;const trace:any[]=[];
 try{
  const {data:o,error:oe}=await service.from('optimizations').select('id,business_id,ad_request_id,bundle_id,status,action,form_review').eq('id',b.optimization_id).maybeSingle();
  if(oe||!o||o.action!=='form_rewrite'||(b.op==='create'&&!['pending','diagnosed','proposal_ready'].includes(o.status)))return json({error:'Unknown or ineligible optimization'},400);
  const p=o.form_review?.proposed_form;let imagePath:string;
  try{imagePath=proposal(p,o.business_id);}catch(e:any){return json({error:e.message},400);}
  const sigs=await checked(service.rpc('optimization_sigs',{p_ids:[o.id]}));const sig=sigs?.find((x:any)=>x.id===o.id)?.sig;requireValue(/^[0-9a-f]{64}$/.test(sig),'Current proposal signature unavailable');
  let witness:any=null;
  // Critical: refusal is BEFORE any Meta call or durable reservation.
  if(b.op==='create')try{witness=await approval(req.headers.get('x-form-approval'),req.headers.get('x-jarvis-key')!.trim(),o.id,sig);}catch(e:any){return json({error:e.message},400);}
  const connections=await checked(service.from('meta_connections').select('page_id').eq('business_id',o.business_id));
  requireValue(connections?.length===1&&/^\d+$/.test(connections[0].page_id??''),'Exactly one connected Page required');const PAGE=connections[0].page_id;
  const SOURCE=String(o.form_review.form_id??'');requireValue(/^\d+$/.test(SOURCE),'Source form missing');
  const ar=await checked(service.from('ad_requests').select('business_id,meta_form_id').eq('id',o.ad_request_id).single());
  requireValue(ar.business_id===o.business_id&&ar.meta_form_id===SOURCE,'Current request/source form changed');
  const cfg=await getMetaConfig('v23.0');requireValue(cfg.token,'Server Meta connection missing');const api=`https://graph.facebook.com/${cfg.apiVersion}`;
  async function graph(path:string,params:any,token=cfg.token){
   const values=new URLSearchParams();for(const[k,v]of Object.entries(params))if(v!=null)values.set(k,typeof v==='string'?v:JSON.stringify(v));
   const r=await fetch(`${api}/${path}?${values}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(25000)});const d=await r.json();
   trace.push({method:'GET',path,http_status:r.status,fbtrace_id:d.error?.fbtrace_id??r.headers.get('x-fb-trace-id')});
   requireValue(r.ok&&!d.error,`Meta read refused: ${path}, code ${d.error?.code??r.status}`);return d;
  }
  const page=await graph(PAGE,{fields:'id,access_token'});const token=page.access_token;requireValue(token,'Page credential unavailable');
  const source=await graph(SOURCE,{fields:FIELDS},token);let preview:any;
  try{preview=payload(p,source,PAGE,'<uploaded-main-image-photo-id>');}catch(e:any){return json({ok:false,error:e.message,read_only:true,...(b.op==='inspect'?{source}:{}),trace},422);}
  const forms:any[]=[];let after:string|undefined;
  for(let n=0;n<100;n++){
   const d=await graph(`${PAGE}/leadgen_forms`,{fields:'id,name,status',limit:100,...(after?{after}:{})},token);requireValue(Array.isArray(d.data),'Form listing unavailable');forms.push(...d.data);
   if(!d.paging?.next){after=undefined;break;}after=d.paging?.cursors?.after;requireValue(after&&n<99,'Form list pagination incomplete');
  }
  const matches=forms.filter(f=>f.name===p.form_name);requireValue(matches.length<2,'Duplicate form names; no writes permitted');
  const id=await jobId(o.id);job=await checked(service.from('apply_jobs').select('id,function_name,status,approved_body,journal,invocation_id,attempt_count').eq('id',id).maybeSingle());
  if(job)requireValue(job.function_name===FUNCTION&&job.approved_body?.optimization_id===o.id,'Reservation identity mismatch');
  const receipt=job?.journal?.form_build??null;
  const {data:image,error:imageError}=await service.storage.from('ad-creatives').download(imagePath);requireValue(!imageError&&image&&image.type.startsWith('image/'),'Proposed main image unavailable');
  const imageSha=await sha(await image.arrayBuffer());const proposalSha=await sha(canonical(p));
  if(receipt)requireValue(receipt.proposal_sha256===proposalSha&&receipt.image_sha256===imageSha&&receipt.source_sha256===await sha(canonical(preview)),'Proposal, source or image changed since reservation');
  const common={optimization_id:o.id,page_id:PAGE,source_form_id:SOURCE,seen_sig:sig,proposal_sha256:proposalSha,image_path:imagePath,image_sha256:imageSha,receipt,trace};
  if(b.op==='inspect')return json({ok:true,read_only:true,...common,proposed_form:p,source,create_payload_preview:preview,existing_forms:matches,create_requires:'Existing JARVIS held human approval, matching current seen_sig, supplied by crew/lead_form_build.py'});
  if(matches.length){
   const form=await graph(matches[0].id,{fields:FIELDS},token);
   requireValue(receipt?.photo_id&&receipt?.form_id===form.id,'Existing form has no trustworthy receipt; no creation or adoption');
   const list=checks(p,form,source,PAGE,receipt.photo_id);
   return json({ok:list.every(x=>x.ok),read_only:true,reused:true,...common,form_id:form.id,photo_id:receipt.photo_id,form,checks:list});
  }
  if(b.op==='read')return json({ok:false,read_only:true,...common,form_id:receipt?.form_id??null,existing_forms:[]},404);
  if(job)return json({error:'Prior reservation exists. No blind replay; inspect/read and investigate.',...common,no_replay:true},409);
  // Namespaced deterministic primary key reserves exactly once, WITHOUT consuming the unique
  // optimization_id slot needed later by apply-optimization. No automatic recovery queue is entered.
  const journal={meta:[],db:[],form_build:{optimization_id:o.id,proposal_sha256:proposalSha,image_sha256:imageSha,source_sha256:await sha(canonical(preview)),source_form_id:SOURCE,image_path:imagePath,state:'reserved',approval:witness}};
  const reservation={id,function_name:FUNCTION,optimization_id:null,ad_request_id:o.ad_request_id,business_id:o.business_id,bundle_id:o.bundle_id,approved_body:{optimization_id:o.id,op:'create'},status:'needs_fix',message:'Form-only one-shot reservation; automatic replay forbidden',journal,attempt_count:1,invocation_id:crypto.randomUUID(),first_started_at:new Date().toISOString(),completed_items:0,total_items:2};
  const reserved=await service.from('apply_jobs').insert(reservation).select().single();if(reserved.error)return json({error:'Reservation refused or already owned; inspect/read only'},409);
  job=reserved.data;owns=true;
  const persist=async(patch:any)=>{job.journal={...job.journal,form_build:{...job.journal.form_build,...patch}};await checked(service.from('apply_jobs').update({journal:job.journal}).eq('id',id));};
  const post=async(path:string,params:any,index:number)=>{
   // Every POST gets an apply_attempts in-flight record and durable result through the proven helper.
   // Distinct indices preserve both photo and form results. A timeout never authorizes replay.
   const ctx={base:service,job,journal:job.journal.meta,dbJournal:job.journal.db,index,dbIndex:0,writes:0,reads:0,lastWrite:0,progressExplicit:true};
   const result=await execution.run(ctx,()=>durableMeta(service,'POST',path,params,token,api));job.journal.meta=ctx.journal;return result;
  };
  // Re-check proposal signature immediately before the first write, after slower reads/downloads.
  const fresh=await checked(service.rpc('optimization_sigs',{p_ids:[o.id]}));requireValue(fresh?.[0]?.sig===sig,'Proposal changed during preparation');
  const {data:signed,error:signError}=await service.storage.from('ad-creatives').createSignedUrl(imagePath,300);requireValue(!signError&&signed?.signedUrl,'Image signing failed');
  await persist({state:'photo_in_flight'});const photo=await post(`${PAGE}/photos`,{url:signed.signedUrl,published:false},0);requireValue(/^\d+$/.test(photo.id??''),'No photo ID returned');
  await persist({state:'photo_created',photo_id:photo.id});
  const createPayload=payload(p,source,PAGE,photo.id);await persist({state:'form_in_flight'});
  const made=await post(`${PAGE}/leadgen_forms`,createPayload,1);requireValue(/^\d+$/.test(made.id??''),'No form ID returned');await persist({state:'form_created',form_id:made.id});
  const form=await graph(made.id,{fields:FIELDS},token);const list=checks(p,form,source,PAGE,photo.id);const ok=list.every(x=>x.ok);
  await persist({state:ok?'verified':'readback_mismatch',checks:list});await checked(service.from('apply_jobs').update({status:ok?'done':'needs_fix',completed_items:2,message:ok?'Form prepared and read back; no ads changed':'Form created; readback mismatch, no replay'}).eq('id',id));
  return json({ok,created:true,optimization_id:o.id,job_id:id,form_id:made.id,photo_id:photo.id,image_sha256:imageSha,form,checks:list,trace});
 }catch(e:any){
  // Never expose raw network errors, tokens or signed image query strings.
  if(owns)await service.from('apply_jobs').update({status:'needs_fix',message:'Form preparation interrupted or mismatched; inspect journal and live form before any action'}).eq('id',job.id);
  const message=String(e.message);return json({ok:false,error:message.includes('https:')?'Upstream operation failed; inspect durable journal':message,no_replay:true,trace},502);
 }
});
