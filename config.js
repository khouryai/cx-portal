// ==========================================
// HITACHI Rail T&C Portal - Backend endpoint configuration
// Single seam for the backend connection. At the Microsoft migration
// cutover this is the ONE file that changes - point at the self-hosted
// PostgREST gateway / Entra ID flow.
// Deliberately a window property (NOT a top-level const): the PWA shell
// updates files independently, so an old cached app.js (which declares
// its own consts) must be able to coexist with this file during the
// brief update window. app.js reads window.CX_CONFIG with a fallback.
// The anon key is a publishable client key by design (RLS enforces access).
// ==========================================

window.CX_CONFIG = {
  SUPABASE_URL: 'https://uqtwiucxktljhukmgmxg.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxdHdpdWN4a3Rsamh1a21nbXhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NDMxMDcsImV4cCI6MjA5MzUxOTEwN30.nJuQOOyvGpGphSqiNxrO2_p1oYroev8mVdNn9unxmdI'
};
