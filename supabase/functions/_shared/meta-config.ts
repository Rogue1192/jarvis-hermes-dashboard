import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export interface MetaConfig {
  token: string;
  appSecret: string;
  apiVersion: string;
}

/**
 * Resolves the Meta credentials used by the ad engine.
 *
 * Precedence for each value: the `app_settings` row (written by the Meta
 * settings tab) -> the matching env secret -> for apiVersion only, the
 * supplied default.
 *
 * The DB read is best-effort: any failure falls back to env so a database
 * hiccup can never break a Meta call.
 */
export async function getMetaConfig(defaultApiVersion = 'v21.0'): Promise<MetaConfig> {
  const envToken = Deno.env.get('META_SYSTEM_USER_TOKEN') ?? '';
  const envAppSecret = Deno.env.get('META_APP_SECRET') ?? '';
  const envApiVersion = Deno.env.get('META_API_VERSION') ?? '';

  let dbToken = '';
  let dbAppSecret = '';
  let dbApiVersion = '';

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    if (supabaseUrl && serviceRoleKey) {
      const supabase = createClient(supabaseUrl, serviceRoleKey);
      const { data } = await supabase
        .from('app_settings')
        .select('meta_system_user_token, meta_app_secret, meta_api_version')
        .maybeSingle();

      dbToken = (data?.meta_system_user_token ?? '').trim();
      dbAppSecret = (data?.meta_app_secret ?? '').trim();
      dbApiVersion = (data?.meta_api_version ?? '').trim();
    }
  } catch (err) {
    console.warn('getMetaConfig: app_settings read failed, falling back to env secrets', err);
  }

  return {
    token: dbToken || envToken,
    appSecret: dbAppSecret || envAppSecret,
    apiVersion: dbApiVersion || envApiVersion || defaultApiVersion,
  };
}
