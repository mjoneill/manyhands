/**
 * #1562 — runs the OFFICIAL LangGraph checkpointer conformance suite
 * (@langchain/langgraph-checkpoint-validation `specTest`) under vitest, against
 * the initializer in langgraph-saver-initializer.mjs. Driven by
 * tests/langgraph-saver.test.mjs; not a node:test file.
 *
 * Why not the package's `validate-checkpointer` CLI: in 1.1.1 its runner imports
 * `checkpointerTestInitializerSchema` from dist/types.js, which does not export
 * it, so every CLI run fails before a single test with "Cannot read properties
 * of undefined (reading 'parse')". The library entry is the package's other
 * documented usage ("Usage in existing Jest-like test suite").
 */
import { specTest } from '@langchain/langgraph-checkpoint-validation';
import initializer from './langgraph-saver-initializer.mjs';

specTest(initializer);
