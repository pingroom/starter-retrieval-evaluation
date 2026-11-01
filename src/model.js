import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


const safeId = value => word(value) && value.length <= 16 && !['constructor', 'prototype', '__proto__'].includes(value);
const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const permutation = (order, ids) => Array.isArray(order) && order.length === ids.length && new Set(order).size === ids.length && order.every(id => ids.includes(id));
export function validateInput(input) {
  if (!keys(input, ['evaluationId', 'title', 'rubric', 'rankers', 'queries']) || !word(input.evaluationId) || !line(input.title, 40) || !line(input.rubric, 100)
    || !keys(input.rankers, ['a', 'b']) || !line(input.rankers.a, 24) || !line(input.rankers.b, 24) || input.rankers.a === input.rankers.b
    || !Array.isArray(input.queries) || input.queries.length < 1 || input.queries.length > 3) throw new Error('Provide an evaluation ID, title, rubric, two distinct ranker labels and one to three queries.');
  const ids = new Set();
  for (const query of input.queries) {
    if (!keys(query, ['id', 'text', 'k', 'candidates', 'rankings']) || !safeId(query.id) || ids.has(query.id) || !line(query.text, 100)
      || !Array.isArray(query.candidates) || query.candidates.length < 2 || query.candidates.length > 4
      || !Number.isSafeInteger(query.k) || query.k < 1 || query.k > query.candidates.length || !keys(query.rankings, ['a', 'b'])) throw new Error('Queries need unique safe IDs, bounded text, two to four candidates and an integer k within the pool.');
    ids.add(query.id);
    const docIds = new Set();
    for (const doc of query.candidates) {
      if (!keys(doc, ['id', 'snippet']) || !safeId(doc.id) || docIds.has(doc.id) || !line(doc.snippet, 120)) throw new Error('Each candidate needs a unique safe ID and a single-line snippet up to 120 UTF-16 units.');
      docIds.add(doc.id);
    }
    if (!permutation(query.rankings.a, [...docIds]) || !permutation(query.rankings.b, [...docIds])) throw new Error('Both rankings must be full permutations of the same query candidate IDs.');
  }
  return { ...structuredClone(input), queries: input.queries.map(query => ({ ...structuredClone(query), candidates: structuredClone(query.candidates).sort(compareId) })).sort(compareId) };
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact assessor UUID and label.');
  return structuredClone(config);
}
export function itemsFor(rawInput) {
  const input = validateInput(rawInput);
  return input.queries.flatMap(query => query.candidates.map(doc => ({ id: `${query.id}::${doc.id}`, queryId: query.id, docId: doc.id, query: query.text, snippet: doc.snippet })));
}
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput), item = itemsFor(input).find(item => item.id === itemId); validateConfig(config);
  if (!item || !isId(attemptId)) throw new Error('Invalid query/document pair or attempt.');
  const prompt = `${input.title}\nQuery [${item.queryId}]: ${item.query}\nDocument [${item.docId}]: ${item.snippet}\nRubric: ${input.rubric}\nGrade relevance to this query. Unknown if unsure.`;
  if (prompt.length > 500) throw new Error('Relevance prompt exceeds 500 characters.');
  const key = `retrieval-${attemptId}`;
  return { prompt, context: `To ${config.participant.id}`, options: [['0', '0 Not relevant'], ['1', '1 Partly relevant'], ['2', '2 Relevant'], ['unknown', 'Unknown']].map(([value, label]) => ({ value, label, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), item_id: itemId, query_id: item.queryId, doc_id: item.docId, attempt_id: attemptId }, idempotencyKey: key };
}
const dcg = grades => grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
const difference = (a, b) => ({ precisionAtK: b.precisionAtK - a.precisionAtK, reciprocalRank: b.reciprocalRank - a.reciprocalRank,
  ndcgAtK: a.ndcgAtK === null || b.ndcgAtK === null ? null : b.ndcgAtK - a.ndcgAtK });

/** Metrics describe this supplied pool and its assessor's grades, not a full corpus or future traffic. */
export function evaluateRankings(rawInput, grades) {
  const input = validateInput(rawInput), items = itemsFor(input);
  if (!keys(grades, items.map(item => item.id)) || Object.values(grades).some(value => ![null, 'unknown', 0, 1, 2].includes(value) || Object.is(value, -0))) throw new Error('Supply an exact grade, Unknown marker or null for each query/document pair.');
  const missing = items.filter(item => grades[item.id] === null).map(item => item.id), unknown = items.filter(item => grades[item.id] === 'unknown').map(item => item.id);
  if (missing.length || unknown.length) return { status: missing.length ? 'incomplete' : 'unknown', missingItemIds: missing, unknownItemIds: unknown, metrics: null };
  const perQuery = input.queries.map(query => {
    const gradeFor = id => grades[`${query.id}::${id}`];
    const idealDcgAtK = dcg(query.candidates.map(doc => gradeFor(doc.id)).sort((a, b) => b - a).slice(0, query.k));
    const measure = key => {
      const order = query.rankings[key], rankedGrades = order.map(gradeFor), first = rankedGrades.findIndex(grade => grade > 0);
      const dcgAtK = dcg(rankedGrades.slice(0, query.k));
      return { label: input.rankers[key], order: [...order], grades: rankedGrades, precisionAtK: rankedGrades.slice(0, query.k).filter(grade => grade > 0).length / query.k,
        reciprocalRank: first === -1 ? 0 : 1 / (first + 1), dcgAtK, ndcgAtK: idealDcgAtK === 0 ? null : dcgAtK / idealDcgAtK };
    };
    const a = measure('a'), b = measure('b');
    return { queryId: query.id, k: query.k, poolSize: query.candidates.length, relevantCount: query.candidates.filter(doc => gradeFor(doc.id) > 0).length,
      idealDcgAtK, a, b, deltaBMinusA: difference(a, b) };
  });
  const eligible = perQuery.filter(query => query.idealDcgAtK > 0), excluded = perQuery.filter(query => query.idealDcgAtK === 0);
  const macro = key => ({ precisionAtK: perQuery.reduce((sum, query) => sum + query[key].precisionAtK, 0) / perQuery.length,
    reciprocalRank: perQuery.reduce((sum, query) => sum + query[key].reciprocalRank, 0) / perQuery.length,
    ndcgAtK: eligible.length ? eligible.reduce((sum, query) => sum + query[key].ndcgAtK, 0) / eligible.length : null });
  const a = macro('a'), b = macro('b');
  return { status: 'complete', missingItemIds: [], unknownItemIds: [], metrics: { scope: 'supplied_candidate_pools_and_assessor', rankers: input.rankers, perQuery,
    macro: { aggregation: { weighting: 'equal_query', cutoff: 'each_query_declared_k', reciprocalRank: 'mean_reciprocal_rank' }, queryCount: perQuery.length, ndcgEligibleQueryCount: eligible.length, ndcgExcludedQueryCount: excluded.length, ndcgExcludedQueryIds: excluded.map(query => query.queryId),
      a, b, deltaBMinusA: difference(a, b) }, systemsModified: false } };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed evaluation manifest. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved relevance judgment or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last judgment may have an active Question.');
  }
  return state;
}


export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = itemsFor(input).map(item => {
    const attempt = state.attempts.find(attempt => attempt.itemId === item.id), answer = attempt?.observation?.answer;
    return { itemId: item.id, queryId: item.queryId, docId: item.docId, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, grade: ['0', '1', '2'].includes(answer?.value) ? Number(answer.value) : null, label: answer?.label ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null, responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const result = evaluateRankings(input, Object.fromEntries(answers.map(item => [item.itemId, item.choice === 'unknown' ? 'unknown' : item.grade])));
  const active = answers.find(item => ['create_unknown', 'pending'].includes(item.status));
  const status = active?.status ?? (answers.some(item => item.status === 'unasked') ? 'ready' : result.status);
  return { evaluationId: input.evaluationId, sourceHash: hash(input), source: input, participant: state.config.participant, answers, ...result, status, systemsModified: false };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved relevance judgment evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered relevance judgments must not contain relevance judgment evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved query/document pair, room, or assessor.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
