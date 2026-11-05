// JARVIS auth: SHA-256 (hex, lowercase) of header x-jarvis-key must equal
// app_settings.jarvis_api_key_sha256 (timing-safe). Plaintext key never stored here.
import { timingSafeEqual } from './creative-pack.ts';

async function sha256Hex(v: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyJarvisKey(req: Request, service: any): Promise<boolean> {
  const provided = (req.headers.get('x-jarvis-key') || '').trim();
  const { data: st } = await service.from('app_settings').select('jarvis_api_key_sha256')
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  const expected = String((st as any)?.jarvis_api_key_sha256 ?? '').trim().toLowerCase();
  const providedHash = provided ? await sha256Hex(provided) : '';
  return /^[0-9a-f]{64}$/.test(expected) && !!provided && timingSafeEqual(providedHash, expected);
}

export function jarvisCors(baseCors: Record<string, string>, methods: string) {
  return {
    ...baseCors,
    'Access-Control-Allow-Headers': `${baseCors['Access-Control-Allow-Headers'] ?? 'authorization, x-client-info, apikey, content-type'}, x-jarvis-key`,
    'Access-Control-Allow-Methods': methods,
  };
}
