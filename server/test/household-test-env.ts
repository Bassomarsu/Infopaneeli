// Set isolated paths before test-env or any database/config dependency loads.
// Static imports, not `await import()` — see waste-test-env.ts.
import './household-test-vars.ts';
import './test-env.ts';
export {};
