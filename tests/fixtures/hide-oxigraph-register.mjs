// Registers a loader that makes `oxigraph` unresolvable — the shape of a
// fresh clone that has not run `npm install`. Used by the stranger tests.
import { register } from 'node:module';
register('./hide-oxigraph-loader.mjs', import.meta.url);
