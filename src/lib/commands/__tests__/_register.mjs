// Tiny shim: register the resolver hook in the loader thread.
// Run via:  node --import ./src/lib/commands/__tests__/_register.mjs <test.mjs>
import { register } from 'node:module';
register('./_loader.mjs', import.meta.url);
