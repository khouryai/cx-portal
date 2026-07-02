// ==========================================
// HITACHI Rail T&C Portal - Backend endpoint configuration
// Single seam for the backend connection: every module reads these globals
// (supabase-js client creation, REST/storage/RPC fetches). At the Microsoft
// migration cutover this is the ONE file that changes - point the URL at the
// self-hosted PostgREST gateway and swap the anon key for the Entra ID
// token flow. Loaded FIRST (before data.js/app.js) in index.html, sw.js
// SHELL_ASSETS, and tools/_load_app.js.
// The anon key is a publishable client key by design (RLS enforces access).
// ==========================================

const SUPABASE_URL      = 'https://uqtwiucxktljhukmgmxg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxdHdpdWN4a3Rsamh1a21nbXhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NDMxMDcsImV4cCI6MjA5MzUxOTEwN30.nJuQOOyvGpGphSqiNxrO2_p1oYroev8mVdNn9unxmdI';
