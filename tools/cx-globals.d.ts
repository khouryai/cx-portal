// Ambient declarations for the classic-script bundle (Tier 3 Stage D).
// The app attaches ~dozens of helpers to `window` at runtime; a string index
// signature keeps `window.foo` access typed as `any` instead of erroring, and
// `module` is declared for the dual browser/Node (test require) exports.
interface Window { [key: string]: any; }
declare var module: any;
