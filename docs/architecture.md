# Adigam AI — Architecture & Technical Walkthrough

Everything built so far: what each technology is, why it was chosen over the alternative, how
the pieces fit, and the reasoning behind every non-obvious decision. Written to be defended
in a technical review, so it states what is measured, what is estimated, and what is not
built yet.

Companion documents: `docs/development-guide.md` (state and next steps),
`docs/security.md`, `docs/adaptive-learning.md`, `docs/database-schema.md`.

---

## 1. The problem, and why a dashboard would not solve it

Every learner gets the same content in the same order, regardless of what they already know.
The obvious product is a dashboard of charts, which tells a learner *what happened* and leaves
them to work out *what to do*. Adigam's whole point is the second half.

So the system is built around one loop:

```
learner answers a question
        ↓
attempt is graded and recorded          (append-only log — the source of truth)
        ↓
mastery for that topic is recomputed    (deterministic formula, no AI)
        ↓
adaptive engine ranks every topic in the learner's scope
        ↓
one concrete instruction: this topic, this many questions, this difficulty, and why
```

The learner never sees a number without an action attached to it.

**Where AI sits.** Nowhere in that loop. Mastery, ranking and difficulty are deterministic
arithmetic in TypeScript, so they are reproducible, unit-testable and explainable. Claude is
used for the things arithmetic cannot do — writing new questions, and (next) explaining a
concept. This is a deliberate constraint, not a limitation: an LLM that decides mastery gives
a different answer on Tuesday and cannot be defended.

---

## 2. Technology choices, and the alternative rejected

| Layer | Chosen | Why, and what was rejected |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite 6 | Vite for fast builds and route-level code splitting. Rejected Next.js: server-side rendering buys nothing for an authenticated app behind a login, and adds a Node server to deploy. Current build: **193 kB raw / 60.6 kB gzip**. |
| Backend | Node + Express 5 + TypeScript | Express because the layering the project needs (routes → controllers → services → repositories) is plain and readable by every team member. Rejected Fastify (marginally faster, less familiar) and putting logic in Supabase Edge Functions (Deno functions resist the OOP layering and unit testing this project is graded on). |
| Running TS | `tsx` | Runs TypeScript directly, so there is no build step to get wrong during a demo. `tsc --noEmit` still typechecks in CI. |
| Validation | zod | One schema does runtime validation *and* generates the TypeScript type, so the two cannot drift. Used at both trust boundaries: incoming HTTP bodies and outgoing-then-returning AI output. |
| Database | Supabase (PostgreSQL 17.6), Mumbai region | Postgres for real constraints, real foreign keys and Row Level Security. Supabase for managed auth and RLS without writing a session layer. Mumbai because the users are in India. Rejected MongoDB: this data is deeply relational, and half the security model *is* SQL constraints. |
| DB connection | Session pooler (IPv4) | New Supabase projects expose direct connections over IPv6 only, which most home networks cannot reach. This was discovered during setup, not guessed. |
| Auth | Supabase Auth (JWT) | Battle-tested. Rebuilding password hashing and session rotation would be the least original and most dangerous code in the project. |
| AI | `@anthropic-ai/sdk` 0.116.0, model `claude-opus-5` | Structured outputs (schema-constrained JSON) and server-side fallbacks. Wrapped behind our own interface — see section 8. |
| Backend tests | vitest | Same authoring style as the frontend toolchain, near-instant runs. **73 tests.** |
| Database tests | plain `.sql` files run through `psql` | Tests the constraints in the language they are written in. Each file runs in a transaction and rolls back, so it leaves no rows behind. **58 assertions.** |

---

## 3. System shape

```
┌───────────────┐        ┌──────────────────────┐        ┌────────────────────┐
│   Browser     │        │   backend (Express)  │        │  Supabase Postgres │
│               │        │                      │        │                    │
│ reads its own │───────▶│ grading, mastery,    │───────▶│ 10 tables          │
│ rows directly │  RLS   │ adaptive engine,     │        │ RLS on all of them │
│               │        │ all AI calls         │        │ triggers, checks   │
└───────┬───────┘        └──────────┬───────────┘        └────────────────────┘
        │                           │
        │  reads (RLS-protected)    │  writes + anything needing the secret key
        └───────────────────────────┘
```

**Why not route every read through the backend?** A learner reading their own goal or their own
attempt history is a query RLS already secures. Sending it through the API adds a network hop
and a second place for the same rule to be written. Writes and anything that needs privileged
data go through the backend, because that is where grading and mastery live.

### Request flow, with the real file names

```
POST /api/v1/attempts
  routes/attempts.routes.ts        path + requireAuth + validateBody
  middleware/authMiddleware.ts     token → verified userId   (body ignored)
  middleware/validationMiddleware.ts  zod schema → 400 with the offending field
  controllers/attemptController.ts    read identity, build service, respond
  services/practice/practiceService.ts  grade → record → recompute mastery
    services/practice/grader.ts             pure: is this answer right
    services/learner/masteryEngine.ts       pure: mastery from evidence
  repositories/attemptRepository.ts   all SQL for attempts
  repositories/masteryRepository.ts   all SQL for the mastery cache
  → Postgres (triggers and CHECK constraints enforce the invariants)
```

Controllers are 20 lines and contain no SQL and no rules. Repositories contain no rules.
Services contain no SQL. That separation is what makes the engines unit-testable without a
database — all 73 unit tests run in under half a second with no network.

---

## 4. Database — 10 tables, and the reasoning in each

Migrations are numbered in **dependency order** so they can be run top to bottom on an empty
database. Each has a matching `database/tests/NNN_*.test.sql`.

### `000_roles.sql` — grants

Supabase's "automatically expose new tables" was turned **off** at project creation. Nothing is
reachable until granted. This file grants `service_role` (the backend) full access and sets
default privileges so future tables are covered; `anon` gets nothing.

*Why it exists:* turning that setting off broke the backend — it could not read its own
question bank. The setting is right (browser roles should be granted deliberately) but the
server needs an explicit grant. Found by a failing request, not by reading docs.

### `001_profiles.sql` — one row per learner

- Primary key **is** `auth.users.id`, `on delete cascade`. Deleting the auth user removes the
  profile and, through the rest of the schema, everything they own.
- **A trigger creates the row on signup**, not the browser. A browser that can insert its own
  profile can also choose its own field values.
- `set search_path = public, pg_temp` on the definer function — without it a rogue schema
  earlier on the path could shadow the objects the function resolves.
- Column-level grant: learners may update only `display_name`, `avatar_url`, `timezone`,
  `settings`. They cannot change `email` or `id`, because `auth.users` is the source of truth
  for identity.
- `timezone` exists because the planner schedules by the learner's local day.

### `002_topics.sql` — the syllabus as one self-referencing tree

```
parent_id IS NULL      → a subject   ("Data Structures & Algorithms")
parent_id IS NOT NULL  → a topic     ("Binary Trees")
```

One table instead of `subjects` + `topics`: sub-topics need no new migration.

- `unique nulls not distinct (parent_id, name)` — a **Postgres 15+** feature. A plain UNIQUE
  treats every NULL as distinct, so two subjects could share a name. Test 3 catches exactly
  that.
- `weight` (0–5) is the topic's exam importance; the adaptive engine and readiness score
  multiply by it.
- `sort_order` gives syllabus order, so "learn the next new concept" is not alphabetical.
- RLS has a SELECT policy and nothing else, so no learner can edit the syllabus even if a
  grant were added by mistake later.

### `003_questions.sql` — the bank, with the answer withheld

The most important two lines in the schema:

```sql
grant select (id, topic_id, question_type, body, options, difficulty, marks)
    on public.questions to authenticated;
```

`correct_answer` and `explanation` are **not in that list**. The browser has no privilege on
those columns — it cannot request them; the request errors. Consequence: `select *` from the
frontend fails on purpose. That is why grading must happen server-side, and why a mock test is
worth anything.

- `is_verified` + RLS `using (is_verified)` — an unverified question does not exist as far as a
  learner is concerned. This is how "AI questions must be validated before being shown" is
  enforced at the data layer rather than in application code.
- `is_ai_generated` records provenance.
- `CHECK` ties options to type: mcq/msq need ≥ 2 options, numeric must have none.
- `unique index (topic_id, md5(body))` stops the same question being stored twice — which
  matters most when AI generation is run repeatedly on one topic. `md5` keeps the index small
  regardless of question length.
- Partial index `(topic_id, difficulty) where is_verified` — the adaptive engine's main query,
  and the index only covers rows that can actually be served.
- `on delete restrict` from topics: deleting a topic cannot silently take questions and their
  attempt history with it.

### `004_learning_goals.sql` — goals and their scope

- `unique index (user_id) where status = 'active'` — a **partial unique index**: one active
  goal, unlimited archived ones. "The current study plan" has to mean one thing.
- `daily_minutes` CHECK 10–960. A wrong daily budget makes every generated plan wrong.
- No CHECK that `exam_date` is in the future — deliberately. A CHECK also fires on UPDATE, so
  once an exam passed, any edit to that row would fail. That validation belongs in the backend.
- `learning_goal_topics` rows may point at a subject (meaning everything under it) or a single
  topic; the planner expands subjects. Its RLS policy is nested: a scope row is visible only if
  its goal belongs to the caller.

### `005_question_attempts.sql` — the append-only log everything is derived from

Two columns are filled by a **trigger**, and whatever the caller sends is overwritten:

| Column | Why the caller is not trusted |
|---|---|
| `topic_id` | Copied from the question. Otherwise correct answers on an easy topic could be filed under a hard one to inflate its mastery. |
| `attempt_number` | Counted from existing rows. Otherwise a client could claim "first attempt" after failing three times. |

- Append-only in practice. An attempt is never edited to fix a score — history would stop
  matching what the learner did. Summaries are derived and rebuildable.
- `given_answer` (jsonb) records *what* they chose, which is what tells a careless slip from a
  real misconception. It is the mistake engine's input.
- `source` — one of practice / assessment / topic_test / mock_test / revision. A mock-test
  answer says more about exam readiness than an untimed practice one.
- `time_taken_seconds` capped at 3600: over an hour means the tab was left open, and an
  uncapped value ruins every average.
- Three indexes, one per real query: mastery (`user_id, topic_id, attempted_at desc`),
  "seen this question before" (`user_id, question_id`), and a partial index on
  `attempt_number = 1` for measuring a question's true difficulty from honest first tries.

### `006_assessments.sql` — the diagnostic

- **Answers are not stored here.** They go into `question_attempts` like every other answer,
  and `assessment_questions.attempt_id` points at them. One answer log means the mastery engine
  reads from one place instead of two.
- The question list is stored, not generated per request, so a learner on a patchy connection
  resumes the same paper — and so the per-topic breakdown afterwards knows what was tested.
- `accuracy` is a **generated column**: `round(correct_count * 100 / question_count, 2)`,
  recomputed by Postgres. Application code cannot make the two numbers disagree.
- CHECK ties status to time: `completed` requires `completed_at`, anything else requires it to
  be NULL. Half-finished rows cannot exist.

### `007_learner_profiles.sql` — cached learner-level traits

Everything here is derived from `question_attempts` and can be rebuilt. It exists because the
dashboard is the most-visited screen and scanning a learner's whole history on a slow phone for
every visit is not acceptable — one row read instead of one scan.

Because it is a cache, two columns keep it honest: `computed_at` and `computed_version`. When
the mastery weights change, `computed_version` identifies exactly which rows are stale, and
there is an index on `(computed_version, computed_at)` to find them.

A second trigger chain means the row always exists: `auth.users` insert → `profiles` row →
`learner_profiles` row of zeros. No reader anywhere has to handle "profile exists but learner
profile does not".

### `008_concept_mastery.sql` — the heart, one row per (learner, topic)

The table's rule: `mastery_score` is the **output**; every other column is the **evidence** it
was computed from. The formula lives in TypeScript, not SQL, because its weights are meant to
be tuned and unit tested. The table's job is to refuse impossible numbers.

Evidence in four parts:

| Part | Columns | Why |
|---|---|---|
| Overall | `total_attempts`, `correct_attempts`, generated `accuracy` | lifetime record |
| Recent | `recent_attempts`, `recent_correct`, generated `recent_accuracy` | someone who just revised knows it better than their six-week average says |
| Difficulty | `easy/medium/hard_attempts` and `_correct` | clearing hard questions is not the same as clearing easy ones |
| Recency & consistency | `last_attempt_at`, `last_correct_at`, `correct_streak` | `last_correct_at` gets its own column because the retention engine measures decay from it |

The cleverest constraint:

```sql
check (easy_attempts + medium_attempts + hard_attempts = total_attempts)
```

Every attempt was at exactly one difficulty, so the buckets must sum to the total. If an update
ever bumps the total without bumping a bucket, the difficulty component of every score is
quietly wrong and nobody notices. Now the database refuses it. Test 4 makes the bad update and
proves it fails; test 5 makes the correct update and proves it passes.

`last_correct_at <= last_attempt_at` is also enforced: a topic cannot have been answered
correctly before it was answered at all.

---

## 5. Security, layer by layer

Seven layers, each independently checked by a test.

**1. Identity comes from the token.** `requireAuth` verifies the bearer token with Supabase and
attaches the user id. `authOf(req)` throws if the middleware was not mounted, so a controller
can never quietly run unauthenticated. **No endpoint accepts a `user_id` field.**

**2. Two database clients, different powers.**

| Client | Key | Powers | Used for |
|---|---|---|---|
| `adminDb` | secret | bypasses RLS | grading, writing attempts, updating mastery, AI generation |
| `userDb(token)` | publishable + the learner's JWT | RLS applies | every read |

The dangerous client is used in a few obvious places. The everyday one cannot leak another
learner's data even if a query forgets its `where user_id =` filter.

**3. RLS on all 10 tables.** A learner sees only their own rows. Cross-user reads are tested per
table, not assumed.

**4. Grants decide operations, RLS decides rows.** Two independent locks. Learners have SELECT
on their own data and, for `profiles`, UPDATE on four named columns. They have **no** write
grant on `question_attempts`, `learner_profiles` or `concept_mastery`.

**5. Answers are withheld at the column-privilege level** (section 4, `003`).

**6. Triggers stop client-supplied lies** (section 4, `005`).

**7. Learners cannot write their own learner model.** If they could, every plan,
recommendation and readiness score built on it would be fiction. Tested directly:
`008_concept_mastery.test.sql` test 9 tries to set mastery to 100 as an authenticated learner
and asserts it is blocked.

Also: secrets exist only in `backend/.env` (gitignored — verified with `git check-ignore`); the
browser receives only `VITE_`-prefixed values; the environment is zod-validated at boot so the
server refuses to start with a missing secret rather than failing on the first request; bodies
are capped at 100 kB; and the AI route is rate limited per learner.

### Mistakes deliberately not repeated

A prior-generation exam app was studied for its data model. Its security weaknesses were
catalogued and avoided:

| Weakness there | What Adigam does |
|---|---|
| An RPC read `user_id` from the client's JSON payload | Identity from the verified token only; `topic_id` and `attempt_number` from triggers |
| The browser inserted its own profile row with client-chosen fields | Trigger on `auth.users`; column-level UPDATE grant |
| `correct_answer` was world-readable | No column privilege for `authenticated` |
| No rate limiting | Per-learner quota on the AI route |

---

## 6. The mastery engine — the formula, in full

`backend/src/services/learner/masteryEngine.ts`. Pure function: same evidence in, same number
out, no database, no AI. Every constant is in one exported `MASTERY_CONFIG` object so weights
can be tuned without touching the logic.

**Step 1 — four components, each 0 to 1.**

| Component | Weight | Definition |
|---|---:|---|
| Recent accuracy | 0.40 | correct ÷ attempts over the last 10 attempts |
| Historical accuracy | 0.25 | correct ÷ attempts, lifetime |
| Difficulty handling | 0.25 | see below |
| Consistency | 0.10 | `min(correct_streak, 5) / 5` |

Recent leads because someone who has just revised knows the topic better than their old average
suggests; history is a counterweight so one good session cannot erase a long weak record.

A component with no evidence is **dropped and the remaining weights rescaled**, so a missing
component cannot drag the score toward zero.

**Step 2 — difficulty handling, in two parts.**

```
weightedAccuracy = Σ(w_i × accuracy_i) / Σ(w_i)        over attempted buckets only
                   where w = easy 1, medium 2, hard 3

attemptedLevel   = Σ(w_i × attempts_i) / (totalAttempts × 3)     → 1/3 easy-only … 1 hard-only
levelFactor      = 0.6 + 0.4 × attemptedLevel

difficultyHandling = weightedAccuracy × levelFactor
```

Buckets with no attempts are **excluded**, because never trying a hard question is not the same
as failing every hard question.

*Why `levelFactor` exists — and this is a good story for a review.* The first version used only
`weightedAccuracy`. A unit test asserted that clearing 20 hard questions should score higher
than clearing 20 easy ones, and it **failed**: both scored 87. With uniform accuracy the
weighted average is identical regardless of difficulty, so the weights did nothing. `levelFactor`
caps what an easy-only record can demonstrate. The test found a real design flaw before any
learner saw it.

**Step 3 — shrinkage, so thin evidence cannot look like mastery.**

```
confidence = attempts / (attempts + 5)
shrunk     = raw × confidence + 0.35 × (1 − confidence)
```

At 5 attempts the score sits halfway between a neutral 0.35 and the raw score; at 20 it is 80%
of the way there. This is why the **first correct answer produces 43.94, not 100** — one answer
does not prove mastery. Same family of idea as Laplace smoothing.

**Step 4 — decay, capped.**

```
decay = 1 − clamp(daysIdle / 30, 0, 1) × 0.15
score = clamp(shrunk × decay × 100, 0, 100)
```

At most 15% is lost to idleness: a well-learned topic does not become unknown in a month. The
heavy lifting of "you are about to forget this" belongs to the retention engine (not yet built).

**Recomputed, not incremented.** Every submitted answer re-reads that topic's attempts and
rebuilds the row. Slightly more work; removes an entire class of bug where a cache drifts from
the history it claims to summarise. The buckets-sum-to-total constraint is satisfied by
construction.

**Measured behaviour on a real run** (Trees topic, one learner, live database):

```
correct   →  mastery  —   → 43.94   (1 attempt: confident of nothing yet)
wrong     →  43.94  → 37.38
correct   →  37.38  → 44.29
wrong     →  44.29  → 38.70
```

**Honesty.** `mastery_score` is an estimate from a handful of answers, not a measurement.
`total_attempts` is stored next to it and returned by the API so the interface can say
"68, based on 9 attempts" rather than implying precision it does not have. The column comment
in the schema says the same thing.

---

## 7. The adaptive engine — from a score to an instruction

`services/adaptive/recommendationEngine.ts` and `difficultyEngine.ts`. Deterministic; no AI is
involved in the decision.

**Step 1 — who is allowed to compete (`eligibleCandidates`).**

```
started   = topics with at least one attempt
unfinished = started topics below mastery 50
candidates = unfinished.length > 0 ? unfinished : everything in scope
```

*Why this rule exists — the second story worth telling.* Without it, an unattempted topic scores
maximum on both need (nothing known) and staleness (waiting since day one), so it always wins.
In a live run the engine got **0 out of 3 on Time Complexity** and then recommended a brand new
topic. With 15 topics a learner would touch all 15 and fix none. The rule is *finish what you
started*: while anything already begun is below 50, new topics wait. Initial breadth is the
diagnostic assessment's job, not the session engine's.

**Step 2 — ranking.**

```
gap       = mastery === null ? 1 : (100 − mastery) / 100
staleness = daysSinceLastAttempt === null ? 1 : clamp(days / 14, 0, 1)
priority  = (0.7 × gap + 0.3 × staleness) × topic.weight
```

Staleness stops one weak topic monopolising every session. `topic.weight` means an important
topic outranks a trivial one at equal need. Ties break on name, so the same inputs always give
the same order.

**Step 3 — which kind of session.**

| Condition | Action | Questions |
|---|---|---:|
| never attempted | `learn_new` | 3 |
| solid (≥ 75) and idle ≥ 10 days | `revise` | 4 |
| solid and recently practised | `mini_test` | 10 |
| otherwise | `practice` | 5 |

**Step 4 — difficulty, with a recent-form override.**

```
mastery < 40 → easy      mastery 40–69 → medium      mastery ≥ 70 → hard
```

then, only with **≥ 4 recent attempts** (so one unlucky answer changes nothing):

- recent accuracy < 40% → step **down** one level
- recent accuracy > 85% → step **up** one level

A score built weeks ago should not keep serving hard questions to someone struggling today.

**Step 5 — fit the time the learner actually has.** `?minutes=20` caps the question count using
their own measured pace (`avg_seconds_per_question`, default 90s). Promising a 15-minute session
to someone with 5 minutes free is how a plan stops being followed.

**Step 6 — two phases, so the sentence cannot lie.**

```
planSession()     choose topic + action + difficulty + requested count
      ↓           ask the bank how many questions actually exist
finaliseAction()  final count, time estimate and sentence — all from the real number
```

*Third story.* Originally the sentence was written before the bank was consulted, so a live run
said *"5 easy questions"* and served **1**. Promising more than you deliver is the small
dishonesty that makes a learner stop trusting the recommendation. The split fixed it at the
source rather than patching the string.

**Step 7 — question selection** (`questionSelector.ts`), three attempts in order: unseen at the
target difficulty → unseen at any difficulty on that topic → questions already seen. Repeating
a question is a legitimate fallback (that is how spaced repetition works) but it is **reported**
in a `bankNote`, because a topic that always falls through needs more questions.

**Measured behaviour on a real run:**

```
new learner              → learn_new | Normalisation | 3 questions
                           "You have not attempted Normalisation yet, so start with
                            3 questions at easy level to find where you stand."
3 correct → mastery 57.46 → opens a NEW topic (57 is above the floor of 50)
3 wrong on it → 21.87     → STAYS on that topic: practice | easy | 1 question
                           "Time Complexity is at mastery 22, so 1 question at easy
                            level should move it most."
```

---

## 8. The AI layer — and why nothing trusts it

### The provider abstraction

```
questionBankService → IAIProvider (interface) ← ClaudeProvider → @anthropic-ai/sdk
```

**Exactly one file in the project imports the Anthropic SDK**:
`services/ai/providers/claudeProvider.ts`. Everything above it depends on `IAIProvider`, which
has two methods: `generateJson` (anything the app will act on) and `generateText` (anything a
person will read). Adding Gemini is a new file, not a refactor. Tests can pass a fake provider.

`AIProviderError` lives in `utils/errors.ts`, not beside the provider, so the central error
handler can map it to HTTP without `utils` importing from `services` — the dependency points
the right way.

### Claude specifics handled

- **Model `claude-opus-5`**, structured outputs (`output_config.format` with our JSON Schema),
  so generation is constrained to the shape we asked for.
- **A refusal is HTTP 200.** Safety classifiers can decline a request and the API returns 200
  with `stop_reason: "refusal"` and empty content. Reading `content[0]` without checking
  `stop_reason` first is how that becomes a crash. Checked before touching content.
- **`stop_reason: "max_tokens"`** is treated as a failure — half a JSON document is not usable.
- **Server-side fallbacks** (`fallbacks: "default"`): a declined request is re-run on a fallback
  model inside the same call.
- **Thinking blocks**: the reply can contain more than one block type, so the text block is
  located rather than assumed to be index 0.
- 90-second timeout, SDK retry ×2 on transient failures, and SDK errors translated into our own
  error type so no caller imports Anthropic types to catch them.
- The provider is built **lazily**, so the server starts without an API key and only the AI
  routes fail.

### Four gates before an AI question reaches a learner

```
1. schema-constrained generation      the model is bound to our JSON Schema
2. zod schema validation              is it the shape we asked for
3. business rules                     is it a usable question
4. independent answer check           is the marked answer actually right
```

**Gate 3** catches what a schema cannot (21 unit tests):

| Rejected | Why |
|---|---|
| answer index past the end of the options | **the worst one** — marks a learner wrong for being right |
| mcq with two answers, msq with one | structurally broken question |
| the same option listed correct twice | |
| every option correct | not a question |
| two identical options | |
| "all of the above" | breaks the moment the UI shuffles options |
| "the figure", "shown above" | learner cannot see it |
| explanation identical to the question | teaches nothing |
| the question text contains the correct answer | gives it away |
| duplicate of another question in the same batch | |

**Gate 4 is the one that matters.** Gates 1–3 only prove the question is *shaped* correctly. A
question with a wrong answer key can be perfectly well-formed — and it would mark a learner
wrong for being right, after which the mastery engine records that as evidence. So a **second,
independent request solves the question without being shown the proposed answer**, and the
question is only made visible when both answers agree, the checker is confident, and it did not
flag the question as ambiguous.

Questions that fail gate 4 are **stored but hidden** — `is_verified = false`, and the RLS policy
`using (is_verified)` means no learner can see them. They are not deleted: they cost nothing and
they are the record of what the model got wrong.

If the AI is unavailable mid-check, the question stays unverified. An outage can never produce a
verified question.

### Cost and quota

Each batch is 1 generation call + 1 verification call per question produced. Roughly
**$0.10–0.15 for 3 questions** on `claude-opus-5`. Rate limited to **10 requests per hour per
learner**, keyed on the verified token — never on an IP or a header, both of which are trivially
spoofed. Counters are in process memory, which is honest for one instance and marked with a
`ponytail:` comment naming the upgrade path.

---

## 9. Testing — what is actually proven

### 73 backend unit tests, no database, under half a second

| File | Tests | What it pins down |
|---|---:|---|
| `grader.test.ts` | 16 | mcq/msq/numeric grading, no partial credit, tolerance, malformed stored answers |
| `masteryEngine.test.ts` | 13 | bounds, shrinkage, recency weighting, difficulty, decay, evidence folding |
| `recommendationEngine.test.ts` | 23 | ranking, the finish-what-you-started rule, difficulty steps, time fitting, determinism |
| `responseValidator.test.ts` | 21 | every AI failure mode above |

The mastery tests assert **behaviour, not numbers** — "more evidence scores higher", "hard beats
easy", "recent form outweighs history". Tuning the weights does not break them; changing what
mastery *means* does.

### 58 SQL assertions against the live database

One `.test.sql` per migration, each in a rolled-back transaction. They assert the security
rules, not just the happy path: a learner reading another learner's rows, writing their own
mastery, inserting a profile, editing the syllabus, reading `correct_answer`.

### Verified end to end

Created a real Supabase user through the admin API, signed in for a real JWT, called the API
with it, submitted answers, watched mastery change, requested recommendations, then deleted the
user and confirmed the cascade removed their attempts and mastery rows. Also confirmed: no
token → 401, malformed token → 401, malformed body → 400 naming the field, AI without a key →
503 (not 500, and the server stays up), 11th AI request in an hour → 429.

---

## 10. Bugs the tests and live runs caught

Worth telling, because each one was found before it could matter.

| # | Bug | Found by | Fix |
|---|---|---|---|
| 1 | Difficulty weighting did nothing when accuracy was uniform — 20 easy and 20 hard both scored 87 | unit test | added `levelFactor` |
| 2 | Engine opened a new topic every session and never returned to a weak one | live run | `masteryFloorBeforeNewTopics` |
| 3 | Recommendation promised 5 questions and served 1 | live run | split into `planSession` / `finaliseAction` |
| 4 | Server silently refused to boot: `ANTHROPIC_API_KEY=` (empty) failed a `.optional()` zod check | boot log | blank env vars are dropped before parsing |
| 5 | Backend could not read its own question bank — `service_role` had no grants after disabling auto-expose | failing request | `000_roles.sql` |
| 6 | AI failure returned 500 because the provider was constructed outside the try block | live run | error type moved to `utils/errors.ts`, mapped centrally |
| 7 | Database password containing `@` and `#` broke the connection URL | connection failure | percent-encoded |

---

## 11. Built for low-end devices

A hard requirement, not an afterthought: the users are on cheap Android phones and slow
networks.

- **All learning computation is server-side.** The browser never runs the mastery or adaptive
  logic; it receives a small JSON summary, not raw attempt history.
- **Small payloads.** `/learner/summary` returns 5 weak topics, not every topic. The
  recommendation returns one action plus the questions for it.
- **Cached summaries** (`learner_profiles`, `concept_mastery`) so the dashboard is one row read
  rather than a full-history scan.
- **Frontend build is 60.6 kB gzip** and no dependency has been added that a few lines of code
  could replace.
- **No polling and no realtime sockets.** Nothing in the product needs them.
- **Indexes match the real queries** — including two partial indexes that only cover the rows a
  query can actually return.

---

## 12. Honest scope

**Built and verified:** 10 tables with RLS and constraints, 4 API endpoints, grading, the
mastery engine, the adaptive engine, the AI provider abstraction with four-gate validation,
131 assertions total (73 unit + 58 SQL), end-to-end verification with a real user.

**Not built:** frontend UI (Vite starter only), mistake engine, retention engine, study planner
and re-planner, exam readiness, what-if simulator, AI tutor, AI insights, mock tests.
Migrations 009–021 are intentionally empty — writing a table before the code that reads it
means guessing at its shape.

**Not yet run:** a real Claude API call. The pipeline, validation and error handling are tested;
generation itself needs the API key.

**Deliberate shortcuts** are marked in the code with `ponytail:` comments naming the ceiling and
the upgrade path — streaks and consistency are not computed yet, token verification costs one
network hop per request, the rate limiter is per-process.

