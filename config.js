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

// REST_PATH — the one difference between Supabase's gateway and a bare PostgREST.
//
// Supabase mounts PostgREST under /rest/v1/, so a table is /rest/v1/profiles.
// A self-hosted PostgREST serves at the root: /profiles. Set REST_PATH to ''
// when pointing at your own PostgREST, and leave it unset for Supabase.
//
// Getting this wrong is a flat 404 on EVERY table while authentication works
// perfectly — which reads like a missing database and is nothing of the kind.
//   window.CX_CONFIG.REST_PATH = '';
//
// Declared here rather than in app.js because the monolith only shrinks
// (CLAUDE.md), and because this is the backend seam.
window.REST_BASE = (window.CX_CONFIG.SUPABASE_URL || '') +
  (typeof window.CX_CONFIG.REST_PATH === 'string' ? window.CX_CONFIG.REST_PATH : '/rest/v1');
