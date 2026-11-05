// Generic exact-content conversion. No client identifiers belong in this module.
export const FIELDS='id,name,status,locale,questions,context_card,question_page_custom_headline,thank_you_page,privacy_policy_url,legal_content,page,allow_organic_lead,block_display_for_non_targeted_viewer,is_optimized_for_quality,tracking_parameters,follow_up_action_url';
export const canonical=(x:any):string=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
export const clean=(x:any):any=>Array.isArray(x)?x.map(clean):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).filter(([k])=>k!=='id').map(([k,v])=>[k,clean(v)])):x;
export function requireValue(ok:any,message:string):asserts ok {if(!ok)throw new Error(message);}
export async function sha(x:string|ArrayBuffer){const bytes=typeof x==='string'?new TextEncoder().encode(x):x;return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');}
export async function jobId(opt:string){const h=await sha('lead-form-build:'+opt);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
export function input(b:any){requireValue(b&&typeof b==='object'&&!Array.isArray(b)&&Object.keys(b).length===2&&Object.keys(b).every(k=>['op','optimization_id'].includes(k))&&['inspect','create','read'].includes(b.op)&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b.optimization_id),'Invalid operation or optimization_id; no extra fields accepted');return b;}
const CONTACT:Record<string,string>={'Full name':'FULL_NAME','Phone number':'PHONE','Email':'EMAIL','ZIP code':'ZIP'};
const text=(v:any)=>typeof v==='string'&&v.trim().length>0;
export function proposal(p:any,business:string){
 requireValue(p&&text(p.form_name)&&['More volume','Higher intent'].includes(p.form_type),'Unsupported or missing proposed form');
 requireValue(text(p.intro?.headline)&&text(p.intro?.description),'Proposed intro missing');
 requireValue(Array.isArray(p.questions)&&p.questions.every((q:any)=>q.type==='multiple_choice'&&text(q.label)&&Array.isArray(q.options)&&q.options.length>=2&&q.options.every(text)&&new Set(q.options).size===q.options.length),'Unsupported custom-question shape');
 requireValue(Array.isArray(p.contact_fields)&&p.contact_fields.length>0&&p.contact_fields.every((x:string)=>CONTACT[x])&&new Set(p.contact_fields).size===p.contact_fields.length,'Unsupported contact fields');
 requireValue(p.contact_fields.includes('ZIP code'),'ZIP must be retained');
 requireValue(p.question_page_custom_headline==='Your information will be used to contact you about our offers.','Required contact-info description missing');
 requireValue(p.context_card?.style==='PARAGRAPH_STYLE'&&p.context_card.title===p.intro.headline&&canonical(p.context_card.content)===canonical([p.intro.description])&&p.context_card.background_image_enabled===true&&p.context_card.cover_photo_source==='main_ad_image','Intro and main-image metadata disagree');
 requireValue(text(p.thank_you?.headline)&&text(p.thank_you?.description)&&text(p.thank_you?.button_text)&&p.thank_you?.button_action==='Go to website','Unsupported thank-you shape');
 requireValue(p.thank_you.button_link===`https://roguemetacore.com/book/${business}?lead_id={{lead_id}}`,'Wrong booking destination');
 const u=new URL(p.context_card.cover_photo_url);const prefix='/storage/v1/object/sign/ad-creatives/';
 requireValue(u.protocol==='https:'&&u.hostname==='rqqwsiybtwmdkpndlbfj.supabase.co'&&decodeURIComponent(u.pathname).startsWith(prefix+business+'/')&&!decodeURIComponent(u.pathname).includes('..'),'Untrusted image source');
 return decodeURIComponent(u.pathname).slice(prefix.length);
}
export function payload(p:any,source:any,page:string,photo:string){
 requireValue(String(source.page?.id??source.page)===page,'Source belongs to another Page');
 requireValue(text(source.locale)&&Array.isArray(source.questions),'Native source unavailable');
 const qs=clean(source.questions),custom=qs.filter((q:any)=>q.type==='CUSTOM'),standard=qs.filter((q:any)=>q.type!=='CUSTOM');
 requireValue(custom.length===p.questions.length,'Custom-question count changed; unsupported source shape');
 requireValue(canonical(standard.map((q:any)=>q.type))===canonical(p.contact_fields.map((x:string)=>CONTACT[x])),'Source contact fields differ from proposal');
 custom.forEach((q:any,i:number)=>{
  requireValue(text(q.key)&&Array.isArray(q.options)&&q.options.every((v:any)=>text(v.value)&&text(v.key))&&Object.keys(q).every(k=>['key','type','label','options'].includes(k)),'Unsupported native custom-question shape');
  const want=p.questions[i];q.label=want.label;
  q.options=want.options.map((value:string,j:number)=>({value,key:q.options.find((v:any)=>v.value===value)?.key??`option_${j}_${value.toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,60)}`}));
  requireValue(new Set(q.options.map((v:any)=>v.key)).size===q.options.length,'Option key collision');
 });
 standard.forEach((q:any)=>{requireValue(Object.keys(q).every(k=>['key','type','label'].includes(k)),'Unsupported native contact shape');delete q.label;});
 const policy=clean(source.legal_content?.privacy_policy??{url:source.privacy_policy_url});requireValue(text(policy.url)&&['http:','https:'].includes(new URL(policy.url).protocol),'Current privacy policy unavailable');
 const result:any={name:p.form_name,locale:source.locale,questions:qs,context_card:{style:p.context_card.style,title:p.intro.headline,content:[p.intro.description],cover_photo_id:photo},question_page_custom_headline:p.question_page_custom_headline,thank_you_page:{title:p.thank_you.headline,body:p.thank_you.description,button_text:p.thank_you.button_text,button_type:'VIEW_WEBSITE',enable_messenger:false,website_url:p.thank_you.button_link},privacy_policy:policy,is_optimized_for_quality:p.form_type==='Higher intent'};
 if(source.legal_content?.custom_disclaimer)result.custom_disclaimer=clean(source.legal_content.custom_disclaimer);
 if(source.allow_organic_lead!=null)result.allow_organic_lead_retrieval=source.allow_organic_lead;
 for(const k of ['block_display_for_non_targeted_viewer','follow_up_action_url'])if(source[k]!=null)result[k]=source[k];
 if(source.tracking_parameters?.length)result.tracking_parameters=Object.fromEntries(source.tracking_parameters.map((x:any)=>[x.key,x.value]));
 return result;
}
export function checks(p:any,form:any,source:any,page:string,photo:string){
 const want=payload(p,source,page,photo),list:any[]=[];const add=(what:string,a:any,b:any)=>list.push({what,expected:a,found:b,ok:canonical(a)===canonical(b)});
 add('Page',page,String(form.page?.id??form.page));add('name',want.name,form.name);add('status','ACTIVE',form.status);add('locale',want.locale,form.locale);
 const norm=(qs:any[])=>qs.map(q=>{const x=clean(q);if(x.type!=='CUSTOM')delete x.label;return x;});
 add('questions including ZIP',norm(want.questions),norm(form.questions??[]));add('contact-info description',want.question_page_custom_headline,form.question_page_custom_headline);
 const cc=clean(form.context_card??{});delete cc.cover_photo;delete cc.cover_photo_id;const wc={...want.context_card};delete wc.cover_photo_id;
 add('intro',wc,cc);add('main image',photo,String(form.context_card?.cover_photo?.id??form.context_card?.cover_photo_id??''));add('thank you and booking link',want.thank_you_page,clean(form.thank_you_page));
 add('privacy policy',want.privacy_policy,clean(form.legal_content?.privacy_policy??{url:form.privacy_policy_url}));add('form type',want.is_optimized_for_quality,form.is_optimized_for_quality);
 for(const k of ['block_display_for_non_targeted_viewer','follow_up_action_url'])if(want[k]!=null)add(k,want[k],form[k]);
 if(want.custom_disclaimer)add('custom disclaimer',want.custom_disclaimer,clean(form.legal_content?.custom_disclaimer));
 if(want.allow_organic_lead_retrieval!=null)add('organic lead retrieval',want.allow_organic_lead_retrieval,form.allow_organic_lead);
 if(want.tracking_parameters)add('tracking parameters',want.tracking_parameters,Object.fromEntries((form.tracking_parameters??[]).map((x:any)=>[x.key,x.value])));
 return list;
}
// Trusted JARVIS attests its existing HELD human decision. Body stays optimization_id/op only.
// The JARVIS key already owns board-decide authority; this adds exact-version and expiry binding.
export async function approval(header:string|null,key:string,opt:string,sig:string){
 requireValue(header,'Approved form review required');const [encoded,mac,...rest]=header.split('.');requireValue(rest.length===0&&/^[0-9a-f]{64}$/.test(mac??''),'Invalid approval attestation');
 const cryptoKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 requireValue(await crypto.subtle.verify('HMAC',cryptoKey,new Uint8Array(mac.match(/../g)!.map(v=>parseInt(v,16))),new TextEncoder().encode(encoded)),'Invalid approval signature');
 const a=JSON.parse(atob(encoded));requireValue(a.optimization_id===opt&&a.seen_sig===sig&&a.verdict==='approve'&&/^t_[0-9a-f]+$/.test(a.task_id)&&Number.isFinite(a.expires)&&a.expires>Date.now()/1000&&a.expires<Date.now()/1000+121,'Stale or mismatched approval');return a;
}
