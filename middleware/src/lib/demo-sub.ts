// The cookie-less demo identity's subject. Kept in its own dependency-free
// module so authority helpers can name it without importing session.ts (which
// pulls config.ts, and its import.meta, into every suite that touches them).
// session.ts re-exports it; see the comment there for what the identity is.
export const DEMO_SUB = 'demo-user';
