// 2026-10-24 (Casey/Vector): for every APPLIED item, the exact Meta state the apply was supposed
// to produce — machine-readable, so JARVIS can compare it against meta-live-read without guessing.
// Shapes: { action, ads:[{ad_id,status,creative_id?,lead_gen_form_id?}], retired_ads:[{ad_id,status}],
//   adsets:[{adset_id,status}], retired_adsets:[{adset_id,status}], campaigns:[{campaign_id,daily_budget_cents}] }.
//
// 2026-10-25: `ads` lists ONLY ads the change was supposed to make live — the ads the job actually
// took responsibility for (its live list). Ads an earlier run of the SAME job already replaced show
// up as form_swap entries with no new_ad_id (idempotent skip); their ad_id still belongs in the list,
// so JARVIS can verify every ad the job put on the new form, not just the ones the last run created.
// An ad never appears in both `ads` and `retired_ads`; ads in paused ad sets that the run correctly
// left alone are not in either list.
//
// 2026-10-25 (Casey): entries from EARLIER runs of the same job (ad_replacements, form_swap
// already:true) can still point at ads the FINAL run found in paused ad sets and listed in
// not_live_left_alone (Weyers e0860bf1: four "…Parents under 12 — Ad 3/4 v3" ads, effective_status
// ADSET_PAUSED). Those must never be listed as live: any ad whose name the final run reported as
// left-alone is excluded from `ads`, whichever run created it.
import { LEAD_FORM_DESCRIPTION } from './lead-form-requirements.ts';
const num = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function expectedState(r: any, m: any, ar: any) {
  if (r.status !== 'applied') return null;
  if (r.action === 'change_offer') return { action: r.action, meta_change: false };
  const ads: any[] = []; const retiredAds = new Set<string>(); const adsets: any[] = []; const retiredSets = new Set<string>(); const campaigns: any[] = []; const forms: any[] = [];
  const addAd = (a: any) => { if (a?.ad_id && !ads.some((x) => x.ad_id === a.ad_id)) ads.push(a); };
  // Names the final run left alone (paused ad set / campaign), with the " (reason)" suffix stripped.
  const notLive = new Set<string>(
    (Array.isArray(m.not_live_left_alone) ? m.not_live_left_alone : [])
      .map((s: any) => String(s ?? '').replace(/\s*\([^()]*\)\s*$/, '').trim())
      .filter(Boolean),
  );
  for (const rep of Array.isArray(m.ad_replacements) ? m.ad_replacements : []) {
    if (rep.old_ad_id) retiredAds.add(String(rep.old_ad_id));
    if (notLive.has(String(rep?.new_ad_name ?? '').trim())) continue; // replacement sits in a paused ad set
    addAd({ ad_id: rep.new_ad_id, status: 'ACTIVE', ...(rep.new_creative_id ? { creative_id: rep.new_creative_id } : {}) });
  }
  const formId = String(r.new_form_id ?? '').trim() || null;
  if (r.action === 'form_rewrite' || r.stage === 'offer_rollout') {
    if (formId) {
      const proposed = r.form_review?.proposed_form;
      forms.push({ form_id: formId, context_card: { background_image_enabled: true, ...(proposed?.context_card?.cover_photo_id ? { cover_photo_id: String(proposed.context_card.cover_photo_id) } : {}) }, question_page_custom_headline: LEAD_FORM_DESCRIPTION });
    }
    for (const x of Array.isArray(m.form_swap) ? m.form_swap : []) {
      // ok entries: the ad the job made live on the new form — a brand-new replacement (new_ad_id)
      // or one an earlier run of this same job already replaced (already-done: ad_id itself).
      const liveId = x?.ok ? String(x.new_ad_id ?? x.ad_id ?? '') : '';
      // The live ad's name: the replacement's new name when there is one, else the processed ad's.
      // (For replaced ads x.ad_name is the OLD ad, which may itself be in not_live_left_alone.)
      const liveName = String(x?.rep?.new_ad_name ?? (x?.new_ad_id ? x?.new_ad_name : x?.ad_name) ?? '').trim();
      if (liveId && !notLive.has(liveName)) addAd({ ad_id: liveId, status: 'ACTIVE', ...(x.new_creative_id ?? x.old_creative_id ? { creative_id: x.new_creative_id ?? x.old_creative_id } : {}) });
    }
    if (formId) for (const a of ads) a.lead_gen_form_id = formId;
  }
  for (const v of Array.isArray(m.applied_variants) ? m.applied_variants : []) {
    for (const id of Array.isArray(v?.ad_ids) ? v.ad_ids : []) addAd({ ad_id: id, status: 'ACTIVE' });
  }
  if (r.action === 'pause_ad') for (const id of m.paused_ad_ids ?? []) retiredAds.add(String(id));
  if (r.action === 'swap_interest_audience') {
    if (m.new_adset_id) adsets.push({ adset_id: m.new_adset_id, status: 'ACTIVE', audience_id: m.next_audience_id ?? null });
    if (m.copied_from_adset_id) retiredSets.add(String(m.copied_from_adset_id));
    for (const c of Array.isArray(m.copied_ads) ? m.copied_ads : []) addAd({ ad_id: c.new_ad_id, status: 'ACTIVE', ...(c.creative_id ? { creative_id: c.creative_id } : {}) });
  }
  if ((r.action === 'scale_budget' || r.action === 'scale_down') && ar?.meta_campaign_id) {
    const budget = num(m.new_budget ?? m.requested_budget);
    campaigns.push({ campaign_id: ar.meta_campaign_id, daily_budget_cents: budget != null ? Math.round(budget * 100) : null, status: 'ACTIVE' });
  }
  // An ad the job made live is never also listed as retired (stale replacement records from
  // a later run of the same job must not contradict the live list).
  const liveIds = new Set(ads.map((a) => String(a.ad_id)));
  for (const id of liveIds) retiredAds.delete(id);
  return {
    action: r.action,
    ...(ads.length ? { ads } : {}),
    ...(retiredAds.size ? { retired_ads: [...retiredAds].map((ad_id) => ({ ad_id, status: 'PAUSED' })) } : {}),
    ...(adsets.length ? { adsets } : {}),
    ...(retiredSets.size ? { retired_adsets: [...retiredSets].map((adset_id) => ({ adset_id, status: 'PAUSED' })) } : {}),
    ...(campaigns.length ? { campaigns } : {}),
    ...(forms.length ? { forms } : {}),
  };
}
