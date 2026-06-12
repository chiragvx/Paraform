// Register the resolver hook for the face-pick test.
//   node --import ./src/lib/sketch/__tests__/_register.mjs <test.mjs>
import { register } from 'node:module';
register('./_loader.mjs', import.meta.url);
