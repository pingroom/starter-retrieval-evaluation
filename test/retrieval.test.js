import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportEvaluation } from '../src/engine.js';
import { readJson, readText, atomicJson, atomicText, acquireLock } from '../src/storage.js';
import { validateInput, validateState, evaluateRankings, itemsFor, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/evaluation.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = simple;
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-retrieval-evaluation-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later relevance judgments; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), '2'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.item_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve a relevance judgment', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), '2'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.metrics, null);
    await s.run(); assert.equal(sends(s.api), 2);
  }
});

test('original asker, lifetime and intent remain bound across reads and across relevance judgments', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), '2'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'ready'); assert.equal((await localReport(s.directory, s.options.input)).metrics, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), '2');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), '2'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), '2'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing assessor before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), '2');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), '2'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).metrics, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


test('observation time cannot regress across reads or precede a durable intent on disk',async t=>{
  const s=await setup(t);await s.run();s.clock.value='2026-01-01T09:01:00.000Z';await s.run();
  const before=await readFile(join(s.directory,'state.json'),'utf8');s.clock.value='2026-01-01T09:00:30.000Z';
  await assert.rejects(s.run(),/regressed/);assert.equal(await readFile(join(s.directory,'state.json'),'utf8'),before);
  const saved=await s.saved();saved.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';
  assert.throws(()=>validateState(saved,s.options.input),/predates/);
});


const manifest = (count = 3, k = 2) => ({ evaluationId: 'test-pools', title: 'Help search', rubric: '2 answers, 1 partially answers, 0 unrelated; Unknown if unsure.',
  rankers: { a: 'First ranker', b: 'Second ranker' }, queries: [{ id: 'q', text: 'How to fold paper?', k,
    candidates: Array.from({ length: count }, (_, i) => ({ id: `d${i}`, snippet: `Candidate ${i}` })),
    rankings: { a: Array.from({ length: count }, (_, i) => `d${i}`), b: Array.from({ length: count }, (_, i) => `d${count - i - 1}`) } }] });
const gradesFor = (input, values) => Object.fromEntries(itemsFor(input).map((item, i) => [item.id, values[i]]));
const evaluate = (input, values) => evaluateRankings(input, gradesFor(input, values));
const close = (actual, expected) => expected === null ? assert.equal(actual, null) : assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('real SDK judgments produce golden ranking metrics and complete source/evidence export offline', async t => {
  const s = await setup(t), result = await decide(s, ['2', '1', '0']);
  assert.equal(result.status, 'complete'); assert.equal(result.systemsModified, false);
  const query = result.metrics.perQuery[0], discount = 1 / Math.log2(3), ideal = 3 + discount;
  close(query.a.precisionAtK, 0.5); close(query.a.reciprocalRank, 0.5); close(query.a.ndcgAtK, 3 * discount / ideal);
  close(query.b.precisionAtK, 1); close(query.b.reciprocalRank, 1); close(query.b.ndcgAtK, 1);
  close(query.deltaBMinusA.ndcgAtK, 1 - query.a.ndcgAtK); assert.deepEqual(query.a.order, ['tools', 'fold', 'size']);
  assert.equal(sends(s.api), 3);
  for (const answer of result.answers) { assert.equal(answer.responderId, CONFIG.participant.id); assert.equal(answer.askerId, ASKER); assert.ok(answer.answeredAt); }
  const calls = s.api.calls.length, output = await exportEvaluation(s.directory, example), saved = await readJson(output.path);
  assert.equal(output.queryCount, 1); assert.deepEqual(saved.source, validateInput(example)); assert.deepEqual(saved.answers, result.answers); assert.deepEqual(saved.metrics, result.metrics);
  assert.equal(saved.sourceHash, hash(validateInput(example))); assert.equal((await stat(output.path)).mode & 0o777, 0o600); assert.equal((await stat(s.directory)).mode & 0o777, 0o700);
  assert.deepEqual((await s.run()).metrics, result.metrics); assert.equal(s.api.calls.length, calls);
});

const permutations = values => values.length ? values.flatMap((value, i) => permutations(values.filter((_, j) => j !== i)).map(rest => [value, ...rest])) : [[]];
function reference(order, grades, k) {
  const gain = [0, 1, 3], weights = [1, 1 / Math.log2(3), 0.5, 1 / Math.log2(5)];
  const score = sequence => sequence.slice(0, k).map((id, i) => gain[grades[id]] * weights[i]).reduce((a, b) => a + b, 0);
  const relevantPositions = order.flatMap((id, i) => grades[id] === 0 ? [] : [i + 1]);
  const ideal = Math.max(...permutations(order).map(score));
  return { precisionAtK: relevantPositions.filter(rank => rank <= k).length / k, reciprocalRank: relevantPositions.length ? 1 / Math.min(...relevantPositions) : 0,
    dcgAtK: score(order), ndcgAtK: ideal === 0 ? null : score(order) / ideal, ideal };
}

test('independent permutation-max oracle checks 486 graded pools, rank orders and cutoffs', () => {
  let cases = 0;
  for (const x of [0, 1, 2]) for (const y of [0, 1, 2]) for (const z of [0, 1, 2]) for (const order of permutations(['d0', 'd1', 'd2'])) for (const k of [1, 2, 3]) {
    const input = manifest(3, k); input.queries[0].rankings.a = order;
    const result = evaluate(input, [x, y, z]), query = result.metrics.perQuery[0], grades = { d0: x, d1: y, d2: z };
    assert.equal(result.status, 'complete');
    for (const key of ['a', 'b']) {
      const expected = reference(input.queries[0].rankings[key], grades, k);
      for (const metric of ['precisionAtK', 'reciprocalRank', 'dcgAtK', 'ndcgAtK']) close(query[key][metric], expected[metric]);
      close(query.idealDcgAtK, expected.ideal);
      if (query[key].ndcgAtK !== null) assert.ok(query[key].ndcgAtK >= 0 && query[key].ndcgAtK <= 1 + 1e-12);
    }
    for (const key of ['precisionAtK', 'reciprocalRank', 'ndcgAtK']) close(query.deltaBMinusA[key], query.a[key] === null ? null : query.b[key] - query.a[key]);
    cases++;
  }
  assert.equal(cases, 486);
});

test('reciprocal rank searches the full ranking even when the first positive is beyond k', () => {
  const result = evaluate(manifest(4, 1), [0, 0, 0, 1]), query = result.metrics.perQuery[0];
  close(query.a.precisionAtK, 0); close(query.a.reciprocalRank, 0.25); close(query.a.ndcgAtK, 0);
  close(query.b.precisionAtK, 1); close(query.b.reciprocalRank, 1); close(query.b.ndcgAtK, 1);
});

test('equal grades do not depend on document ID ordering; identical rankings have zero deltas', () => {
  const input = manifest(4, 3), result = evaluate(input, [2, 2, 2, 2]), query = result.metrics.perQuery[0];
  for (const key of ['a', 'b']) { assert.equal(query[key].precisionAtK, 1); assert.equal(query[key].reciprocalRank, 1); assert.equal(query[key].ndcgAtK, 1); }
  assert.deepEqual(query.deltaBMinusA, { precisionAtK: 0, reciprocalRank: 0, ndcgAtK: 0 });
  input.queries[0].rankings.b = [...input.queries[0].rankings.a];
  assert.deepEqual(evaluate(input, [0, 1, 2, 0]).metrics.macro.deltaBMinusA, { precisionAtK: 0, reciprocalRank: 0, ndcgAtK: 0 });
});

test('all-irrelevant pool is complete with precision/RR zero and null nDCG, including its macro delta', async t => {
  const s = await setup(t), result = await decide(s, ['0', '0', '0']);
  assert.equal(result.status, 'complete'); assert.deepEqual(result.answers.map(answer => answer.grade), [0, 0, 0]);
  const macro = result.metrics.macro;
  assert.equal(macro.ndcgEligibleQueryCount, 0); assert.equal(macro.ndcgExcludedQueryCount, 1); assert.deepEqual(macro.ndcgExcludedQueryIds, ['paper']);
  for (const key of ['a', 'b', 'deltaBMinusA']) assert.deepEqual(macro[key], { precisionAtK: 0, reciprocalRank: 0, ndcgAtK: null });
  await exportEvaluation(s.directory, example);
});

test('macro metrics weight each query equally and exclude only zero-IDCG queries from nDCG', () => {
  const input = manifest(2, 1);
  input.queries.push({ ...manifest(4, 2).queries[0], id: 'r' }, { ...manifest(3, 3).queries[0], id: 's' });
  const grades = { 'q::d0': 1, 'q::d1': 0, 'r::d0': 0, 'r::d1': 0, 'r::d2': 0, 'r::d3': 0, 's::d0': 0, 's::d1': 1, 's::d2': 2 };
  const result = evaluateRankings(input, grades), macro = result.metrics.macro;
  assert.equal(macro.queryCount, 3); assert.equal(macro.ndcgEligibleQueryCount, 2); assert.equal(macro.ndcgExcludedQueryCount, 1); assert.deepEqual(macro.ndcgExcludedQueryIds, ['r']);
  close(macro.a.precisionAtK, (1 + 0 + 2 / 3) / 3); close(macro.a.reciprocalRank, (1 + 0 + 0.5) / 3);
  close(macro.b.precisionAtK, (0 + 0 + 2 / 3) / 3); close(macro.b.reciprocalRank, (0.5 + 0 + 1) / 3);
  const included = result.metrics.perQuery.filter(query => query.queryId !== 'r');
  for (const key of ['a', 'b']) close(macro[key].ndcgAtK, (included[0][key].ndcgAtK + included[1][key].ndcgAtK) / 2);
  close(macro.deltaBMinusA.precisionAtK, -1 / 3);
});

test('Unknown and missing grades withhold the entire comparison and export, without treating them as zero', async t => {
  const s = await setup(t), result = await decide(s, ['2', 'unknown', '0']); assert.equal(result.status, 'unknown'); assert.equal(result.metrics, null);
  assert.deepEqual(result.unknownItemIds, ['paper::size']); await assert.rejects(exportEvaluation(s.directory, example), /known relevance grade/);
  assert.equal(await readJson(join(s.directory, 'evaluation.json')), null); const calls = s.api.calls.length; await s.run(); assert.equal(s.api.calls.length, calls);
  const incomplete = evaluate(manifest(2, 1), [2, null]); assert.equal(incomplete.status, 'incomplete'); assert.equal(incomplete.metrics, null); assert.deepEqual(incomplete.missingItemIds, ['q::d1']);
});

test('query/document metadata order canonicalizes but rank order, k and rubric stay bound to saved evidence', async t => {
  const input = manifest(3, 2); input.queries.push({ ...manifest(2, 1).queries[0], id: 'other' });
  const reordered = structuredClone(input); reordered.queries.reverse(); reordered.queries.forEach(query => query.candidates.reverse());
  assert.equal(hash(validateInput(input)), hash(validateInput(reordered)));
  const grades = gradesFor(input, [2, 0, 1, 2, 0]); assert.deepEqual(evaluateRankings(input, grades), evaluateRankings(reordered, grades));
  const s = await setup(t, input); await s.run(); const state = await s.saved(); assert.doesNotThrow(() => validateState(state, reordered));
  for (const mutate of [x => x.queries[0].rankings.a.reverse(), x => { x.queries[0].k = 1; }, x => { x.rubric = 'Changed rubric'; }, x => { x.queries[0].candidates[0].snippet = 'Changed evidence'; }]) {
    const altered = structuredClone(input); mutate(altered); assert.throws(() => validateState(state, altered), /changed evaluation manifest/);
  }
});

test('same document IDs under different queries receive independent judgments exactly once, up to 12 maximum prompts', async t => {
  const input = manifest(4, 4); input.queries = Array.from({ length: 3 }, (_, i) => ({ ...structuredClone(input.queries[0]), id: `q${String(i).repeat(15)}` }));
  input.title = 'T'.repeat(40); input.rubric = 'R'.repeat(100);
  for (const query of input.queries) {
    query.text = 'Q'.repeat(100); query.candidates.forEach((doc, i) => { doc.id = `d${String(i).repeat(15)}`; doc.snippet = '🙂'.repeat(60); });
    query.rankings = { a: query.candidates.map(doc => doc.id), b: query.candidates.map(doc => doc.id).reverse() };
  }
  assert.equal(itemsFor(input).length, 12); assert.equal(new Set(itemsFor(input).map(item => item.id)).size, 12); assert.ok(Buffer.byteLength(JSON.stringify(input)) < 65536);
  for (const item of itemsFor(input)) {
    const request = requestFor(input, CONFIG, item.id, id(30)); assert.ok(request.prompt.length <= 500); assert.ok(request.context.length <= 40);
    for (const text of [item.query, item.snippet, input.rubric]) assert.ok(request.prompt.includes(text)); assert.equal(request.options.length, 4); assert.equal(request.text_input, undefined);
  }
  const s = await setup(t, input), result = await decide(s, ['2', '0', '0', '0', '0', '2', '0', '0', '0', '0', '2', '0']);
  assert.equal(result.status, 'complete'); assert.equal(sends(s.api), 12); assert.deepEqual(result.metrics.perQuery.map(query => query.a.reciprocalRank), [1, 0.5, 1 / 3]);
  await exportEvaluation(s.directory, input); const calls = s.api.calls.length; await s.run(); assert.equal(s.api.calls.length, calls);
});

test('invalid permutations, bounds, unsafe IDs, delimiter collisions and exact-key injections fail before any request', async t => {
  const changes = [
    x => { x.queries = []; }, x => { x.queries.push(...Array(3).fill(x.queries[0])); }, x => { x.queries[0].candidates.pop(); x.queries[0].candidates.pop(); },
    x => { x.queries[0].rankings.a = ['fold', 'fold', 'tools']; }, x => { x.queries[0].rankings.a = ['fold', 'size']; }, x => { x.queries[0].rankings.a = ['fold', 'size', 'foreign']; },
    x => { x.queries[0].rankings.b = ['fold', 'size', 'tools', 'extra']; }, x => { x.queries[0].k = 0; }, x => { x.queries[0].k = 4; }, x => { x.queries[0].k = 1.5; },
    x => { x.queries[0].id = 'q::d'; }, x => { x.queries[0].candidates[0].id = 'd::q'; }, x => { x.queries[0].id = 'constructor'; },
    x => { x.queries[0].candidates[0].id = 'x'.repeat(17); }, x => { x.queries[0].candidates[0].snippet = '\ud800'; }, x => { x.queries[0].candidates[0].snippet = 'x'.repeat(121); },
    x => { x.queries[0].text = '\u2028'; }, x => { x.rubric = ' bad '; }, x => { x.rankers.b = x.rankers.a; },
    x => { x['rankers,rubric'] = 'merged'; delete x.rankers; delete x.rubric; }, x => { x.queries[0].candidates[0] = { 'id,snippet': 'merged' }; },
  ];
  for (const change of changes) { const input = structuredClone(example); change(input); assert.throws(() => validateInput(input)); }
  for (const grades of [{ 'paper::fold,paper::size': 2, 'paper::tools': 0 }, { 'paper::fold': '2', 'paper::size': 1, 'paper::tools': 0 }, { 'paper::fold': -0, 'paper::size': 1, 'paper::tools': 0 }]) assert.throws(() => evaluateRankings(example, grades));
  const s = await setup(t), invalid = structuredClone(example); invalid.queries[0].rankings.a.reverse(); invalid.queries[0].rankings.a[0] = 'missing';
  await assert.rejects(s.run({ input: invalid })); assert.equal(s.api.calls.length, 0);
  assert.throws(() => requestFor(example, { participant: { id: 'name', label: 'Assessor' } }, 'paper::fold', id(1)));
});

test('export refuses incomplete evidence, respects locks and preserves prior files after failure', async t => {
  const s = await setup(t); await assert.rejects(exportEvaluation(s.directory, example), /No retrieval/);
  await decide(s, ['unknown', '1', '0']); await atomicJson(s.directory, 'evaluation.json', { previous: 'preserved' });
  await assert.rejects(exportEvaluation(s.directory, example)); assert.deepEqual(await readJson(join(s.directory, 'evaluation.json')), { previous: 'preserved' });
  const release = await acquireLock(s.directory); await assert.rejects(exportEvaluation(s.directory, example), /lock exists/); await release();
});

test('newline-suffixed IDs, UUIDs, room codes and credentials fail strict end validation before network', async t => {
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.equal(isId(id(1) + suffix), false); assert.equal(ROOM.test(ROOM_CODE + suffix), false);
    for (const mutate of [x => { x.evaluationId += suffix; }, x => { x.queries[0].id += suffix; }, x => { x.queries[0].candidates[0].id += suffix; }]) {
      const input = structuredClone(example); mutate(input); assert.throws(() => validateInput(input));
      const s = await setup(t); await assert.rejects(s.run({ input })); assert.equal(s.api.calls.length, 0);
    }
    const s = await setup(t), config = structuredClone(CONFIG); config.participant.id += suffix;
    await assert.rejects(s.run({ config })); await assert.rejects(s.run({ room: ROOM_CODE + suffix })); await assert.rejects(s.run({ token: 'valid-token' + suffix })); assert.equal(s.api.calls.length, 0);
    assert.throws(() => validateConnection({ token: 'valid-token', room: ROOM_CODE + suffix }));
    assert.throws(() => validateConnection({ token: 'valid-token' + suffix, room: ROOM_CODE }));
    assert.throws(() => requestFor(example, CONFIG, 'paper::fold', id(1) + suffix));
  }
});
