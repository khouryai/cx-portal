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

// DERIVED VALUES LIVE IN cx-config.js, NOT HERE — ON PURPOSE.
//
// This file is replaced wholesale by every environment: azure/deploy-frontend.sh
// generates one, and at the Hitachi cutover a human writes one. Anything but
// plain values therefore gets silently deleted by a replacement that sets only
// the values. window.REST_BASE used to be defined below, and the generated
// Azure config dropped it, which turned every data call into a ReferenceError
// and showed up as "SYSTEM OFFLINE" against a perfectly healthy API.
//
// Set REST_PATH: '' above when pointing at a bare PostgREST (it serves tables
// at the root; Supabase mounts them under /rest/v1/). cx-config.js turns that
// into window.REST_BASE. tools/test_config_seam.js fails if logic returns here.
