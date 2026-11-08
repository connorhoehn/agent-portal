// Compatibility shim: ingest sub-components import their primitives from
// './ui'. Everything here is now a straight re-export of the library —
// the local PulseDot and the labelStyle/inputStyle CSSProperties objects
// that used to live here are gone, replaced by StatusDot and
// FormField/Input respectively.
export { EmptyState } from '@connorhoehn/ui-components/shared';
export { Switch as Toggle } from '@connorhoehn/ui-components/shared';
export { Button } from '@connorhoehn/ui-components/shared';
// PulseDot lived here until StatusDot replaced it: identical dot, and it no
// longer injects a <style> block into the document on every render.
export { StatusDot } from '@connorhoehn/ui-components/shared';
