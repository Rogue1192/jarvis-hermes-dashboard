// Shared helpers for `ad-creatives` storage URLs.
//
// The bucket is private, so every creative is exposed through a signed URL.
// Signed URLs used to be minted with a 30-day TTL, which silently broke every
// campaign draft older than a month (broken images in the dashboard, and
// launch-campaign failing to fetch the bytes). New URLs get a 10-year TTL and
// any older/expired URL can be re-signed on the fly with refreshAdCreativeUrl.

export const AD_CREATIVE_TTL = 60 * 60 * 24 * 3650; // ~10 years

const BUCKET = 'ad-creatives';

/** Extracts the in-bucket object path from a signed or public ad-creatives URL. */
export function extractAdCreativePath(url: string): string | null {
  if (!url) return null;
  const m = url.match(/\/storage\/v1\/object\/(?:sign|public)\/ad-creatives\/([^?]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Returns a freshly signed URL for an ad-creatives URL; other URLs pass through. */
export async function refreshAdCreativeUrl(service: any, url: string): Promise<string> {
  const path = extractAdCreativePath(url);
  if (!path) return url;
  const { data, error } = await service.storage.from(BUCKET).createSignedUrl(path, AD_CREATIVE_TTL);
  if (error || !data?.signedUrl) return url;
  return data.signedUrl;
}
