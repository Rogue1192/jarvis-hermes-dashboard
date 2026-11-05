// Shared helpers for the per-niche creative pack (niches.creative_pack jsonb)
// and the visual-angle system used by every image-generation path.
//
// creative_pack keys: scene_description, crew_and_equipment, default_material,
// realism_negatives, benefit_list, palette_hint, niche_compliance_notes,
// angle_notes { angle_key: text }, unsupported_angles [angle_key].

import { findNiche } from './niche.ts';

export const ANGLE_KEYS = [
  'crew_in_action',
  'finished_result',
  'offer_hero',
  'product_lineup',
  'craftsmanship_closeup',
] as const;

export type AngleKey = typeof ANGLE_KEYS[number];

export const ANGLES: Record<AngleKey, { name: string; instructions: string }> = {
  crew_in_action: {
    name: 'Crew in action',
    instructions: 'A professional crew of 1–3 actively doing the work, candid mid-task (not posing, not looking at the camera), realistic workwear and safety gear. The work is clearly visible and the home is recognizable.',
  },
  finished_result: {
    name: 'Finished result / curb appeal',
    instructions: 'The completed job is the hero on an attractive home, bright daylight or golden hour, curb-appeal composition. No people, or at most a homeowner small in the far background.',
  },
  offer_hero: {
    name: 'Offer hero',
    instructions: 'The offer is the dominant visual element: a large offer card over a simpler real scene with shallow depth of field, so the offer reads first while the scene still clearly shows the work.',
  },
  product_lineup: {
    name: 'Product / service lineup',
    instructions: 'The featured product or service large as the hero; 2–4 other options shown small along the bottom as realistic mini-photos (not icons or clip-art), each clearly distinct.',
  },
  craftsmanship_closeup: {
    name: 'Craftsmanship close-up',
    instructions: 'A tight, detailed close-up of quality workmanship with a hand or tool in frame and a softly blurred background, conveying care and precision.',
  },
};

export const REFRESH_ORDER: AngleKey[] = [
  'offer_hero',
  'craftsmanship_closeup',
  'product_lineup',
  'crew_in_action',
  'finished_result',
];

const PACK_VAR_KEYS = [
  'scene_description',
  'crew_and_equipment',
  'default_material',
  'realism_negatives',
  'benefit_list',
  'palette_hint',
  'niche_compliance_notes',
] as const;

export function isAngleKey(k: unknown): k is AngleKey {
  return typeof k === 'string' && (ANGLE_KEYS as readonly string[]).includes(k);
}

/** Loads niches.creative_pack for the niche whose name ilike-matches the business primary_category. */
export async function loadCreativePack(service: any, primaryCategory: string | null | undefined): Promise<Record<string, any> | null> {
  try {
    const cat = (primaryCategory || '').toString().trim();
    if (!cat) return null;
    const niche = await findNiche(service, cat, 'creative_pack');
    const pack = niche?.creative_pack;
    return pack && typeof pack === 'object' ? pack as Record<string, any> : null;
  } catch {
    return null;
  }
}

/** Flat string template vars from the pack ('' when missing). */
export function packVars(pack: Record<string, any> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PACK_VAR_KEYS) {
    const v = pack?.[k];
    out[k] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

function unsupported(pack: Record<string, any> | null | undefined): string[] {
  const u = pack?.unsupported_angles;
  return Array.isArray(u) ? u.map((x: any) => String(x)) : [];
}

function isSupported(pack: Record<string, any> | null | undefined, key: AngleKey): boolean {
  return !unsupported(pack).includes(key);
}

/** Angle for a launch variant: 0 -> crew_in_action, 1 -> finished_result, skipping unsupported keys. */
export function launchAngle(pack: Record<string, any> | null | undefined, variantIndex: number): AngleKey {
  const preferred: AngleKey = variantIndex === 1 ? 'finished_result' : 'crew_in_action';
  if (isSupported(pack, preferred)) return preferred;
  const start = ANGLE_KEYS.indexOf(preferred);
  for (let n = 1; n < ANGLE_KEYS.length; n++) {
    const k = ANGLE_KEYS[(start + n) % ANGLE_KEYS.length];
    if (isSupported(pack, k)) return k;
  }
  return preferred;
}

/** Next angle for a fatigue refresh: first supported unused key in REFRESH_ORDER; if all used, first supported !== lastKey. */
export function nextRefreshAngle(pack: Record<string, any> | null | undefined, usedKeys: string[], lastKey?: string): AngleKey {
  const used = new Set((usedKeys || []).filter(Boolean));
  for (const k of REFRESH_ORDER) {
    if (isSupported(pack, k) && !used.has(k)) return k;
  }
  for (const k of REFRESH_ORDER) {
    if (isSupported(pack, k) && k !== lastKey) return k;
  }
  return REFRESH_ORDER[0];
}

/**
 * N DIFFERENT refresh angles (optimization options). Unused supported keys first (REFRESH_ORDER),
 * then already-used supported keys, then any key — never the same key twice unless the pack
 * supports fewer than N.
 */
export function distinctRefreshAngles(
  pack: Record<string, any> | null | undefined, usedKeys: string[], lastKey: string | undefined, n: number,
): AngleKey[] {
  const out: AngleKey[] = [];
  const used = new Set((usedKeys || []).filter(Boolean));
  const tiers: AngleKey[][] = [
    REFRESH_ORDER.filter((k) => isSupported(pack, k) && !used.has(k)),
    REFRESH_ORDER.filter((k) => isSupported(pack, k) && k !== lastKey),
    REFRESH_ORDER.filter((k) => isSupported(pack, k)),
    [...ANGLE_KEYS].filter((k) => isSupported(pack, k)),
  ];
  for (const tier of tiers) for (const k of tier) {
    if (out.length >= n) return out;
    if (!out.includes(k)) out.push(k);
  }
  while (out.length < n) out.push(out[out.length % Math.max(1, out.length)] ?? REFRESH_ORDER[0]);
  return out;
}

export function angleVars(pack: Record<string, any> | null | undefined, key: AngleKey): { visual_angle: string; visual_angle_name: string; visual_angle_instructions: string } {
  const a = ANGLES[key];
  const note = pack?.angle_notes?.[key];
  return {
    visual_angle: key,
    visual_angle_name: a.name,
    visual_angle_instructions: a.instructions + (note ? ' ' + note : ''),
  };
}

export function freshIterationNote(hint: string): string {
  return 'This is a FRESH creative replacing a fatigued ad. It must look clearly different from the previous version (different visual angle, composition, and scene).'
    + (hint ? ` Direction: ${hint}` : '');
}

/** Constant-time-ish string compare (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a ?? ''));
  const bb = enc.encode(String(b ?? ''));
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// ---- Refresh (propose-optimization / apply-optimization) helpers -----------

/**
 * Finds the stored intake.ads[i] for a creative. Primary match is
 * intake.ads[i].creative_id (how intake-extract links ads[i] to its creatives
 * row); fallback is the creative's index among the ad_request's creatives
 * ordered by created_at.
 */
export function storedAdFor(intake: any, creativesOrdered: any[], creativeId: string): { ad: any; index: number } {
  const ads: any[] = Array.isArray(intake?.ads) ? intake.ads : [];
  let index = ads.findIndex((a: any) => a?.creative_id && a.creative_id === creativeId);
  if (index < 0) index = Math.max(0, (creativesOrdered || []).findIndex((c: any) => c?.id === creativeId));
  return { ad: ads[index] || {}, index };
}

/**
 * Angles already used on this ad_request: every intake.ads[*].visual_angle plus
 * metrics.visual_angle of its optimizations rows (any status), excluding
 * `excludeOptimizationId`. `last` = the most recent optimization's angle, else
 * `fallbackLast`.
 */
export async function usedAngles(
  service: any,
  adRequestId: string,
  intake: any,
  excludeOptimizationId?: string | null,
  fallbackLast?: string,
): Promise<{ used: string[]; last?: string }> {
  const ads: any[] = Array.isArray(intake?.ads) ? intake.ads : [];
  const used: string[] = ads.map((a: any) => a?.visual_angle).filter(isAngleKey);
  let last: string | undefined;
  try {
    let q = service.from('optimizations')
      .select('id, metrics, created_at')
      .eq('ad_request_id', adRequestId)
      .order('created_at', { ascending: false });
    if (excludeOptimizationId) q = q.neq('id', excludeOptimizationId);
    const { data } = await q;
    for (const r of data ?? []) {
      const k = r?.metrics?.visual_angle;
      if (isAngleKey(k)) {
        used.push(k);
        if (!last) last = k;
      }
    }
  } catch { /* non-fatal: rotate on ads[] only */ }
  return { used, last: last ?? (isAngleKey(fallbackLast) ? fallbackLast : undefined) };
}

/** Full variant + niche + angle vars for a refresh image prompt. */
export function refreshImageVars(args: {
  biz: any;
  intake: any;
  ad: any;
  index: number;
  pack: Record<string, any> | null;
  angleKey: AngleKey;
  angleHint: string;
  hook?: string;
}): Record<string, string> {
  const { biz, intake, ad, index, pack, angleKey, angleHint, hook } = args;
  const pkg = intake?.creative_package || null;
  const fallbackAd = ad || (Array.isArray(intake?.ads) && intake.ads.length ? intake.ads[Math.min(index, intake.ads.length - 1)] : null);
  const pv = (pkg ? (index === 0 ? pkg.variant_1 : index === 1 ? pkg.variant_2 : null) : null) || pkg?.variant_1 || {};
  const loc = biz?.ad_target_location || biz?.primary_city || '';
  return {
    business_name: biz?.name ?? '',
    offer_line: fallbackAd?.offer_line || pkg?.offer_line || intake?.offer || '',
    audience_callout: fallbackAd?.audience_callout || pkg?.audience_callout || `Attention ${loc} and surrounding area homeowners!`,
    cta: biz?.cta_text || intake?.cta || '',
    variant_id: String(ad?.variant_id || index + 1),
    // ad_image_generate / ad_image_overlay reference {{variant_angle}} (apply-optimization fallback path).
    variant_angle: fallbackAd?.variant_angle || pv.angle || '',
    variant_headline_direction: fallbackAd?.variant_headline_direction || pv.headline_direction || '',
    variant_hook: hook || fallbackAd?.variant_hook || pv.image_hook || '',
    variant_subline: fallbackAd?.variant_subline || pv.image_subline || '',
    variant_usp_1: fallbackAd?.variant_usp_1 || pv.usp_1 || biz?.usp_1 || '',
    variant_usp_2: fallbackAd?.variant_usp_2 || pv.usp_2 || biz?.usp_2 || '',
    variant_usp_3: fallbackAd?.variant_usp_3 || pv.usp_3 || biz?.usp_3 || '',
    ...packVars(pack),
    ...angleVars(pack, angleKey),
    fresh_iteration_note: freshIterationNote(angleHint),
  };
}
