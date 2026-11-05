// HARD RULE (2026-10-25, Casey): "live" = Meta's effective_status ACTIVE or in review.
// effective_status already accounts for a paused ad set or campaign (ADSET_PAUSED /
// CAMPAIGN_PAUSED), so the ad's own configured `status` field is never used for this.
// Only live ads may be changed; everything else is left completely alone.
export const LIVE_EFFECTIVE_STATUSES: ReadonlySet<string> = new Set([
  'ACTIVE',
  'IN_PROCESS',
  'WITH_ISSUES',
  'PENDING_REVIEW',
]);

export const isLiveEffective = (status: unknown): boolean =>
  LIVE_EFFECTIVE_STATUSES.has(String(status ?? '').toUpperCase());

export const isLiveAd = (ad: { effective_status?: unknown } | null | undefined): boolean =>
  isLiveEffective(ad?.effective_status);
