// =====================================================================
//  Настройки сайта ПЕКАРНЯ DAG
//  SUPABASE_URL и SUPABASE_ANON_KEY: Supabase → Project Settings → API
//  Ключ anon (publishable) можно показывать в браузере: это нормально,
//  защиту данных обеспечивают правила RLS из supabase/schema.sql.
//  НИКОГДА не вставляйте сюда ключ service_role.
// =====================================================================
window.APP_CONFIG = {
  SUPABASE_URL: "https://nxxhaiahmcemkkkxiaqc.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im54eGhhaWFobWNlbWtra3hpYXFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwNTU0NzQsImV4cCI6MjEwNjYzMTQ3NH0.slwGnAlbdkR64w55yIoPj3RzM8JaOVX2q_Ednjfsnj8",

  CURRENCY: "₽",

  // Контакты в шапке и подвале. Пустое поле просто не показывается.
  PHONE: "",
  ADDRESS: "",
  HOURS: ""
};
