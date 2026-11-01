# PingRoom retrieval evaluation

Collect a named assessor's grades for a fixed candidate pool, then compare two supplied rankings using those judgments. Export private JSON containing source, evidence and metrics. The starter performs no search, model call, indexing or system change.

## Try it offline

Use Node.js 22 or 24 on macOS or Linux. Choose **Use this template**, clone your repository, then run:

```sh
npm ci
npm test
npm run demo
```

The demo uses the pinned SDK with a local mock transport: a craft-help comparison, an Unknown judgment and an all-irrelevant pool. Tests and demo need no credentials or network after installation. Live phone delivery is not tested.

## Prepare the comparison

```sh
cp examples/evaluation.json evaluation.json
cp config.example.json config.json
```

Edit `evaluation.json` before starting. Supply an `evaluationId`, title, relevance rubric, distinct `rankers.a`/`rankers.b` labels, and 1–3 queries. Each query needs an ID, query text, 2–4 candidate IDs/snippets, an integer `k` from 1 through pool size, and `rankings.a`/`rankings.b`. Both rankings must list every candidate ID exactly once, best first.

Export the lists from your retrieval workflow. Both rankers must use the **same pool for each query**. Resolve score ties into explicit orders before importing; the starter evaluates those orders without averaging tie permutations. Repeated document IDs across queries receive separate judgments.

```sh
npm run preview
```

Preview validates offline. Query and candidate metadata sort by ID; ranking order stays fixed. Changing text, rubric, k or ranking order invalidates a session. Grades assess the supplied snippets, which may not establish full-document relevance.

## Connect the assessor

Install [PingRoom](https://pingroom.io/i), sign in, and choose a **standard private room** containing the assessor:

```sh
npm run connect
npm run inspect
```

Open the pairing URL, approve the connection and grant the room. Verify the person in the app; copy their exact member UUID from `inspect` into `config.json` as `participant.id`. Names alone do not establish identity. Retain the robot's grant and assessor's membership.

Pairing saves ignored `.pingroom/credentials.json` and resumes a pending link. For an **existing connection only**, optionally copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Complete pairs override saved credentials. Defining either shell variable selects the whole shell pair without borrowing from `.env`; blank/partial pairs fail. Another CLI's credential store is not read.

## Judge and export

```sh
npm start          # Send the next pair, or read its active Question once.
# Answer in PingRoom, then repeat:
npm start
npm run status     # Read saved evidence offline.
npm run report     # Save .retrieval-evaluation/report.json.
npm run export     # Save .retrieval-evaluation/evaluation.json when complete.
```

Each Question shows query text, candidate snippet and rubric. Choose **0 Not relevant**, **1 Partly relevant**, **2 Relevant** or **Unknown**. The example's canonical order is `fold`, `size`, `tools`; demo grades are `2`, `1`, `0`.

Each query/document pair is judged once for both rankings: at most twelve Questions, in canonical ID order, each lasting 15 minutes. Pending Questions are read without resending. Rankings stay local; this does not establish independent or blinded assessment. Unknown, invalid, expired or cancelled answers withhold the entire comparison and export. Later pairs may continue without replacement Questions. Code validates button selection, assessor, request, asking registration and times; typed text is not a button answer.

## Interpret metrics

Per query, rank positions start at 1:

- **P@k:** fraction of the top k with grade greater than zero.
- **Reciprocal rank:** `1 / first_relevant_rank` over the **full supplied ranking**, or zero if none is relevant.
- **DCG@k:** sum of `(2^grade - 1) / log2(rank + 1)` through k.
- **nDCG@k:** DCG divided by ideal DCG from that query's pool, sorted by descending grade through k.

These use the conventional definitions described by [McSherry and Najork, §§2.1, 2.5–2.6](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/ecir2008.pdf), with reciprocal rank evaluated through the pool's full length.

If all grades are zero, P@k and reciprocal rank are zero; ideal DCG is zero, so nDCG and its delta are null. Such a fully judged query is still exportable.

`metrics.perQuery` shows both orders, grades and metrics. `deltaBMinusA` subtracts A from B. `metrics.macro` gives every query equal weight: `reciprocalRank` is **mean reciprocal rank (MRR)**, while precision and nDCG average each query at its own declared k, which may vary. Macro nDCG excludes zero-IDCG queries and exposes eligible/excluded counts and excluded IDs. With none eligible, both macro nDCGs and their delta are null. Precision and MRR include every query. Floating-point values remain unrounded internally.

Results describe only the supplied pools and assessor's judgments. They do not establish corpus-wide recall, average precision, online performance or generalization.

Export recomputes validated evidence and includes canonical source, source hash, attributed answers and metrics. A failed export preserves any previous file; consume it only after successful export for the expected hash. Local commands replay historical evidence without checking current room access.

## Recovery and adaptation

Creation intent is saved before POST. At `create_unknown`, keep state and recover the original Question:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

An empty bounded recent-list search does not prove creation failed. Inspect the original Question if needed; recovery validates its exact ID without resending. Never delete state to bypass uncertainty. For uncertain/expired pairing, resolve or revoke the old robot in Connected Agents before archiving `.pingroom/pairing.json`. Before a new evaluation, resolve outstanding Questions and securely archive `.retrieval-evaluation/`.

Collection exits: `0` complete, `1` error, `2` incomplete/Unknown or newly failed judgment, `3` ready/pending/interrupted, `4` uncertain creation. Readable status/report commands exit `0`; inspect their JSON status and nullable metrics. Refused exports exit `1`.

`src/model.js` owns validation/metrics; `src/engine.js` owns collection/export. Use validated reports for provenance when adapting the pure `evaluateRankings` helper. No AI inference is needed.

Inputs/config are capped at 64/16 KiB, state/reports at 1 MiB, HTTP bodies at 512 KiB. IDs use lowercase letters, digits, `_` or `-`, beginning with a letter: evaluation ID 40 characters, query/document IDs 16. Prototype-related query/document IDs are forbidden. Single-line text must be well formed, without controls, format characters or outer spaces. UTF-16 limits: title 40, rubric/query text 100, snippet 120, ranker label 24, assessor label 60.

Atomic writes use `0600` files and `0700` directories. Inputs, config, credentials and reports are Git-ignored; paths resolve from this project. Use one machine with persistent storage. Remove a stale `.lock` only after confirming its recorded process stopped; restore corrupt state from backup. Saved evidence can be altered; persistence does not guarantee distributed exactly-once execution. HTTP requests refuse redirects and use five-second deadlines.

Tests include an independent permutation-based metric oracle, maximum prompts, zero relevance, macro exclusions, SDK recovery, pairing and real CLI subprocesses. Actions runs Node 22/24. [SDK](https://github.com/pingroom/sdk) `0.7.1` is pinned with a lockfile and 14-day npm minimum release age. [MIT license](LICENSE).
