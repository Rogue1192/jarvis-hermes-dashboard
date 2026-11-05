// Shared gate for internal-only edge functions.
// Allows: exact service-role bearer, optional x-internal-secret (= app_settings.optimizer_cron_secret),
// or a logged-in user for whom check_if_admin returns true. All secret compares are constant-time.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i % (ab.length || 1)] ?? 0) ^ (bb[i % (bb.length || 1)] ?? 0);
  return diff === 0 && ab.length > 0;
}

export async function isInternalAuthorized(req: Request, opts: { allowCronSecret?: boolean } = {}): Promise<boolean> {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (serviceKey && timingSafeEqualStr(authHeader, `Bearer ${serviceKey}`)) return true;
  try {
    const service = createClient(supabaseUrl, serviceKey);
    if (opts.allowCronSecret) {
      const provided = req.headers.get("x-internal-secret") ?? "";
      if (provided) {
        const { data } = await service.from("app_settings").select("optimizer_cron_secret").limit(1).maybeSingle();
        const expected = String((data as any)?.optimizer_cron_secret ?? "").trim();
        if (expected && timingSafeEqualStr(provided.trim(), expected)) return true;
      }
    }
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) return false;
    const { data: u, error } = await service.auth.getUser(token);
    if (error || !u?.user) return false;
    const { data: isAdmin } = await service.rpc("check_if_admin", { user_id: u.user.id });
    return isAdmin === true;
  } catch (e) {
    console.error("[internal-auth] check failed", e);
    return false;
  }
}
