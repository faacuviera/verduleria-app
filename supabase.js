const appConfig = window.APP_CONFIG || {};
const SUPABASE_URL = appConfig.SUPABASE_URL;
const SUPABASE_ANON_KEY = appConfig.SUPABASE_ANON_KEY;

const supabaseClient = window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  })
  : null;

export { SUPABASE_URL, SUPABASE_ANON_KEY, supabaseClient };
