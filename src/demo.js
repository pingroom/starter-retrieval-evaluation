import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, exportEvaluation } from './engine.js';
import { CONFIG, ROOM_CODE, mockApi } from './mock.js';

const input = await readJson(new URL('../examples/evaluation.json', import.meta.url), 65536);
for (const [scenario, grades, expected] of [
  ['ranked craft-help comparison', ['2', '1', '0'], 'complete'],
  ['one judgment uncertain', ['2', 'unknown', '0'], 'unknown'],
  ['all snippets irrelevant', ['0', '0', '0'], 'complete'],
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-retrieval-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    let result;
    for (const grade of grades) {
      const pending = await step(options);
      api.answer(pending.answers.find(answer => answer.status === 'pending').questionId, grade);
      result = await step(options);
    }
    assert.equal(result.status, expected); assert.equal(api.calls.filter(call => call.method === 'POST').length, 3);
    if (expected === 'complete') { const output = await exportEvaluation(directory, input); assert.deepEqual((await readJson(output.path)).metrics, result.metrics); }
    else { assert.equal(result.metrics, null); await assert.rejects(exportEvaluation(directory, input)); }
    if (scenario === 'all snippets irrelevant') assert.equal(result.metrics.macro.a.ndcgAtK, null);
    const calls = api.calls.length; await step(options); assert.equal(api.calls.length, calls);
    console.log(JSON.stringify({ scenario, status: result.status, macro: result.metrics?.macro ?? null, systemsModified: false }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('Offline demo used the pinned SDK with local mock transport. No phone delivery or search/model changes. Metrics describe supplied pools only.');
