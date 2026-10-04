/**
 * #1562 — the CheckpointerTestInitializer the official conformance suite
 * (@langchain/langgraph-checkpoint-validation, CLI `validate-checkpointer`)
 * runs against. One real executor on a throwaway store per suite run; every
 * createCheckpointer() gets its own saver SCOPE (a disjoint partition of the
 * store), which is how the suite's "isolated instances" requirement is met
 * without any raw delete.
 *
 * LG_SAVER_VARIANT selects a deliberately BROKEN control (design v0.2 #9):
 *   oxigraph (default)            the real OxigraphSaver
 *   putwrites-requires-checkpoint putWrites refuses when its checkpoint is absent
 *   putwrites-drops-writes        putWrites stores nothing (a control the harness
 *                                 must catch, to show it can fail at all)
 */
import { createGraphClient } from '../../core/graph-client.mjs';
import { OxigraphSaver } from '../../core/langgraph-saver.mjs';
import { startExecutor, killExecutor, tmpStore } from '../helpers/graph-executor-proc.mjs';

const VARIANT = process.env.LG_SAVER_VARIANT || 'oxigraph';

class PutWritesRequiresCheckpoint extends OxigraphSaver {
  async putWrites(config, writes, taskId) {
    if (config?.configurable?.thread_id !== undefined && config?.configurable?.checkpoint_id !== undefined
      && !(await this.getTuple(config))) {
      throw new Error('BROKEN CONTROL: putWrites requires its checkpoint to exist');
    }
    return super.putWrites(config, writes, taskId);
  }
}
class PutWritesDropsWrites extends OxigraphSaver {
  async putWrites(config) {
    if (config?.configurable?.thread_id === undefined || config?.configurable?.checkpoint_id === undefined) throw new Error('missing ids');
  }
}
const CLS = { oxigraph: OxigraphSaver, 'putwrites-requires-checkpoint': PutWritesRequiresCheckpoint, 'putwrites-drops-writes': PutWritesDropsWrites }[VARIANT];
if (!CLS) throw new Error(`unknown LG_SAVER_VARIANT ${VARIANT}`);

let exec;
let client;
let n = 0;

export default {
  checkpointerName: VARIANT === 'oxigraph' ? 'OxigraphSaver' : `OxigraphSaver[control:${VARIANT}]`,
  beforeAllTimeout: 30000,
  async beforeAll() {
    exec = await startExecutor({ store: tmpStore('lg-conf-'), datasetId: 'lg-conformance', create: true });
    client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'lg-conformance', timeoutMs: 30000 });
  },
  async afterAll() { await killExecutor(exec); },
  createCheckpointer() { return new CLS({ client, scope: `conf${++n}` }); },
};
