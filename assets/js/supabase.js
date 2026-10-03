// Общий клиент Supabase для сайта и админки
(function () {
  var c = window.APP_CONFIG || {};
  var ok = c.SUPABASE_URL && !/YOUR-/.test(c.SUPABASE_URL) && c.SUPABASE_ANON_KEY && !/YOUR-/.test(c.SUPABASE_ANON_KEY);
  window.APP_CONFIGURED = !!ok;
  window.sb = ok && window.supabase
    ? window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } })
    : null;
})();
