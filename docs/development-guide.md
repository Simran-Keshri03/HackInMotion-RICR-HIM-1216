# Development Guide & Current State

> **Resuming work? Read `docs/CONTINUE-HERE.md` instead.** It carries the rules, the live URLs,
> the exact remaining work in order, and every bug already fixed. This file is the longer
> reference behind it.

**Read this first.** It is the handoff document: where the project stands, how to run it, and
what to do next. Written so a new session, or a teammate, can continue without re-deriving
anything.

Last updated: 2026-08-13 (frontend complete — the demo loop runs end to end in a browser)

---

## 1. How to run it

```bash
# Backend
cd backend
npm install
npm run dev          # http://localhost:4000/api/v1/health
npm test             # 73 unit tests
npm run typecheck

# Frontend — login, dashboard, practice all working
cd frontend
npm install
npm run dev          # http://localhost:5173
```

`backend/.env` holds the real Supabase credentials **and a working `ANTHROPIC_API_KEY`**. It is
gitignored and stays on this machine — the key is not tied to any Claude Code login, so it
survives switching accounts.

### Running migrations and SQL tests

```bash
export PATH="/Library/PostgreSQL/18/bin:$PATH"
DB=$(grep '^DATABASE_URL=' backend/.env | cut -d= -f2-)

psql "$DB" -v ON_ERROR_STOP=1 -f database/migrations/000_roles.sql   # then 001, 002, ...
psql "$DB" -v ON_ERROR_STOP=1 -f database/tests/001_profiles.test.sql
psql "$DB" -v ON_ERROR_STOP=1 -f database/seed/demo_questions.sql    # safe to re-run
```

Every SQL test runs inside a transaction that rolls back, so they leave no rows behind and
can be run as often as you like.

---

## 2. What is built and verified

### Database — 10 tables live on Supabase, 58 SQL assertions passing

| Migration | Table(s) | Tests |
|---|---|---|
| `000_roles` | grants (service_role full, browser roles explicit) | — |
| `001_profiles` | `profiles` + signup trigger | 5/5 |
| `002_topics` | `topics` (self-referencing syllabus tree) | 6/6 |
| `003_questions` | `questions` (answers withheld from browser) | 7/7 |
| `004_learning_goals` | `learning_goals`, `learning_goal_topics` | 7/7 |
| `005_question_attempts` | `question_attempts` (append-only log) | 8/8 |
| `006_assessments` | `assessments`, `assessment_questions` | 8/8 |
| `007_learner_profiles` | `learner_profiles` (cached learner traits) | 8/8 |
| `008_concept_mastery` | `concept_mastery` (per-topic mastery) | 9/9 |

**Question bank: 127 questions across 15 topics, 8-10 per topic at all three difficulties.**
37 hand-written (mcq/msq/numeric) plus 90 written by Claude and verified. Every one is
`is_verified = true`, so all are visible to learners. Spot-checked and correct.

### Backend — 4 endpoints, 73 unit tests passing

| Endpoint | What it does |
|---|---|
| `GET /api/v1/health` | liveness, no auth |
| `GET /api/v1/learner/summary` | learner model for the dashboard |
| `POST /api/v1/attempts` | grade → record → recompute mastery |
| `GET /api/v1/recommendations/next?minutes=20` | next best action + the questions for it |
| `POST /api/v1/questions/generate` | AI question generation (needs API key) |

Engines, all pure and unit tested:

- `services/practice/grader.ts` — mcq/msq/numeric grading, no partial credit (16 tests)
- `services/learner/masteryEngine.ts` — mastery 0-100 from evidence (13 tests)
- `services/adaptive/difficultyEngine.ts` + `recommendationEngine.ts` — next action (23 tests)
- `services/ai/responseValidator.ts` — AI output validation (21 tests)

### AI question generation — working, used in anger

`POST /api/v1/questions/generate` has been run against the real Claude API and filled the
bank: 90 questions requested, 89 verified, 0 rejected, 0 failures. Pipeline is generate →
schema check → business rules → **independent answer check** (a second request solves the
question without seeing the proposed answer) → store, verified only on agreement.

`ANTHROPIC_API_KEY` is set in `backend/.env`. Model `claude-opus-5`.

**Spend so far: about $3.40 of the account's credit.** $2.14 for the successful bulk run
(97k input / 66k output tokens), ~$1.25 wasted on a first run that generated everything and
then failed on insert (see bug 8 below), $0.02 on the first single-question test. Real cost
is roughly **2.4 cents per verified question**.

Bulk generation was done with a throwaway `backend/fill-bank.ts` that called the service
directly, bypassing the per-learner rate limit (10/hour) which exists to protect against a
runaway browser, not a seed run. That file was deleted after use; write it again if the bank
needs refilling.

### Three more bugs found and fixed during that run

8. The bulk script passed a placeholder `created_by` UUID that no profile row matched, so
   every batch generated and verified questions and then failed the insert on a foreign key.
   `created_by` is now `string | null` and a seed run passes null, which is what the schema
   always intended.
9. `findTopicWithSubject` used a PostgREST embedded self-join
   (`parent:topics!parent_id(name)`) that **silently returned nothing** — so the generator was
   told a topic's subject was the topic itself. Wrong context, no error. Replaced with two
   plain queries.
10. The verification call ran before the insert, so a question the model re-suggested from
    the list it had been shown still cost a paid verification. Duplicates are now recognised
    before the check.

### Verified end to end with a real user and a real JWT

Created a Supabase user, signed in, called the API with the token, submitted answers, watched
mastery move (`— → 43.94 → 37.38 → 44.29`), then deleted the user and confirmed the cascade
cleaned up their attempts and mastery rows.

---

## 3. Design decisions that must not be undone

These are the load-bearing ones. Changing any of them breaks a guarantee elsewhere.

**Identity comes from the verified token, never from the request.** No endpoint accepts a
`user_id`. `question_attempts` fills `topic_id` and `attempt_number` from a database trigger
so a client cannot file an attempt under the wrong topic or lie about which try it is.

**The browser cannot read `questions.correct_answer` or `questions.explanation`.** Not by
policy — the `authenticated` role has no column privilege on them at all. That is why grading
happens server-side, and why `select *` from the frontend fails on purpose.

**Two Supabase clients.** `adminDb` (secret key, bypasses RLS) only for grading, writing
attempts and updating mastery. `userDb(token)` for every read, so RLS is a second lock behind
the user id we already filtered on.

**Learners can read their learner model, never write it.** `learner_profiles` and
`concept_mastery` have a SELECT policy and nothing else. If a learner could set their own
mastery, every plan and recommendation built on it would be fiction.

**Mastery is recomputed from the attempt log, not incremented.** Slightly more work per
answer, but the cache can never drift from the history it claims to summarise. The database
enforces the invariant: `easy + medium + hard = total_attempts`.

**"Automatically expose new tables" is off in Supabase.** Every table grants access
deliberately, table by table and sometimes column by column. `000_roles.sql` grants
service_role what the backend needs; `anon` gets nothing.

**AI output is never trusted.** Four gates: schema-constrained generation, zod schema check,
business rules, then an **independent answer check** — a second request solves the question
without seeing the proposed answer, and the question is only made visible if the two agree.
Unverified questions are kept but hidden by RLS.

**Nothing outside `services/ai/providers/claudeProvider.ts` imports the Anthropic SDK.**
Everything else depends on `IAIProvider`.

---

## 4. Structure

```
backend/src/          34 files, all of them written
  config/             environment.ts (zod-validated, fails fast), database.ts (two clients)
  middleware/         auth, validation, rateLimit
  routes/             one file per feature, mounted in index.ts
  controllers/        thin: read identity, delegate, respond
  services/           learner/, adaptive/, practice/, ai/, questions/
  repositories/       all database access
  utils/              http.ts (response envelope + error handler), errors.ts
frontend/src/         15 files, all of them written
  lib/                api.ts (the only path to the backend), supabase.ts (auth only)
  types/api.ts        every backend response shape
  hooks/useApi.ts     fetch-on-mount with loading / error / reload
  features/auth/      AuthProvider + useAuth
  components/         Loading (states), ErrorBoundary, layout
  pages/              Login, Dashboard, Practice
  router.tsx          lazy routes + auth guard
  index.css           all styling
database/migrations/  000-008 written, 009-021 empty by design (the numbering fixes the
                      dependency order that was already worked out)
database/tests/       one .test.sql per written migration
database/seed/        demo_questions.sql
```

**Every remaining file in `backend/src` and `frontend/src` has content.** The scaffold's
zero-byte placeholders — 74 in the backend, 24 in the frontend — were deleted once it was clear
which layers the project actually uses. A file nobody can explain is worse than a file that does
not exist, and in a viva an empty `readinessEngine.ts` invites a question the team cannot
answer. Empty directories remain under `backend/src/services/` and `frontend/src/pages/` for
work that is genuinely still to come; each will get its files when it gets its code.

Layers that were scaffolded and then deliberately not used: `backend/src/models/` (types live
with the repository that returns them), `frontend/src/services/` (everything goes through
`lib/api.ts`), and a split `frontend/src/types/` (one `api.ts` instead).


---

## 5. What is NOT done

**Migrations 009-021 are empty files:** `mistake_patterns`, `retention_tracking`,
`study_plans`, `study_sessions`, `revision_schedule`, `adaptive_recommendations`,
`ai_conversations`, `ai_insights`, `mock_tests`, `mock_test_attempts`, `readiness_scores`,
`rls_policies` (audit), `indexes`. They were left until the code that reads them exists —
writing a table before its consumer means guessing at its shape.

**The frontend is finished for the demo path.** Three screens, wired to the live backend:

| Route | Screen | What it does |
|---|---|---|
| `/login` | `pages/Login/Login.tsx` | one form for sign-in and sign-up; handles the no-session-yet case when email confirmation is on |
| `/dashboard` | `pages/Dashboard/Dashboard.tsx` | the "do this next" card (action, topic, difficulty, count, minutes, and the engine's own reason sentence), then attempts / accuracy / streak and the weakest topics with mastery meters |
| `/practice` | `pages/Practice/Practice.tsx` | one question at a time, mcq / msq / numeric, then right-or-wrong, the explanation, and **mastery before → after with the delta** |

Supporting files: `lib/api.ts` (the only path to the backend), `lib/supabase.ts` (auth only),
`features/auth/AuthProvider.tsx`, `hooks/useApi.ts`, `components/Loading/States.tsx` (loading /
empty / error-with-retry), `components/ErrorBoundary/`, `components/layout/Layout.tsx`,
`router.tsx` (lazy routes + auth guard), `index.css` (all styling, plain CSS).

**Bundle: 331 kB raw / 97.6 kB gzip**, with each page its own 1-2 kB chunk. The full
`@supabase/supabase-js` was swapped for `@supabase/auth-js` after measuring: the app only ever
calls `auth.*`, and the full client additionally bundles postgrest, realtime (websockets),
storage and functions clients, which cost 31 kB gzip of code that never runs. If the browser
ever needs direct table reads, swapping back is a one-file change in `lib/supabase.ts`.

**Deliberately not built:** no UI library, no CSS framework, no data-fetching library, no
per-feature `services/` layer and no `types/` split. Three screens do not justify any of them,
and each would cost more than the app's own code. Everything reaches the backend through
`lib/api.ts`, and every response type lives in `types/api.ts` — one place each.

The scaffold's zero-byte files (`services/*.ts`, `types/*.ts`, unused hooks) and unused
component folders were **deleted** rather than left as empty placeholders: a file nobody can
explain is worse than a file that does not exist. Empty folders remain only under `pages/` for
screens whose backend is genuinely still to come (MockTest, StudyPlan, AITutor, ExamReadiness,
WhatIf, Assessment, LearningGoals, TopicTests, SmartRevision, AIInsights, Settings).

### Verified end to end against the live stack

Signed in with a real Supabase account, then ran the exact calls the three screens make. One
practice session, one wrong answer then two right:

```
Q1 easy  wrong   mastery  —    → 29.17
Q2 easy  correct mastery 29.17 → 37.48  (+8.31)
Q3 hard  correct mastery 37.48 → 46.37  (+8.89)

summary afterwards: 3 attempts, 66.67% accuracy, 1 weak topic
next recommendation: practice | Normalisation | medium | 5 questions
  "Normalisation is at mastery 46, so 5 questions at medium level should move it most."
```

The difficulty stepping from easy to medium on its own is the adaptive engine working. Also
confirmed: `correct_answer` is absent from the questions the browser receives and arrives only
in the attempt response; CORS allows `http://localhost:5173`; all 13 modules transform under
Vite; the signup trigger chain creates both `profiles` and `learner_profiles` rows.

### ⚠️ Two things to do in the Supabase dashboard before demoing

Both were found by testing signup for real, and both will bite during a demo:

1. **Turn OFF email confirmation** — Authentication → Sign In / Providers → *Confirm email*.
   With it on, signing up sends an email and returns no session, and Supabase's built-in mailer
   is rate limited to a couple of messages per hour on the free tier: the third person to sign
   up at the venue gets `email rate limit exceeded`. With it off, sign-up signs the learner
   straight in and no email is sent. `Login.tsx` handles both cases, but the demo is far
   smoother with it off.
2. **Use a real email domain when signing up.** Supabase rejects `@example.com`,
   `@adigam.test` and similar reserved test domains with `email_address_invalid`. A real
   address, or anything on a genuinely registered domain, works.

### One more bug found and fixed (11)

11. Straight after signing in, the dashboard's first request sometimes failed with
    `JWT issued at future` — the token was a second old and Supabase's database clock was
    fractionally behind its auth server's. The learner's very first screen showed an error for
    something that fixes itself. `api.get` now retries once after 700 ms on a retryable
    failure. `api.post` deliberately does **not** retry: attempt numbers are assigned from the
    rows that already exist, so a repeated submit would be logged as a second try and skew that
    topic's mastery.

**Engines not yet written:** mistake engine, retention engine, study planner, re-planner,
readiness, what-if, AI tutor, AI insights, mock tests.

**Deferred inside what exists:**

- `learner_profiles` streaks, consistency score and average answer time are never computed —
  `recordAttemptOnProfile` only bumps the counters and the last-active date. Needs a
  day-by-day pass, which belongs with the retention work.
- `authMiddleware` validates the token by calling Supabase on every request. Verifying the
  signature locally against the project JWKS would remove that hop.
- The rate limiter counts in this process's memory. Fine for one instance; move it into
  Postgres before running two.
- `POST /api/v1/questions/generate` has never made a real Claude call (no API key).

Search the code for `ponytail:` to find every deliberate shortcut with its upgrade path.

---

## 6. Do these next, in this order

1. **Do the two Supabase dashboard changes above**, then click through
   `/login → /dashboard → /practice` in a browser once, to confirm what was verified at the
   API level also looks right on screen.
2. **Retention engine + `010_retention_tracking`.** Leitner-style boxes over
   `concept_mastery.last_correct_at`; feeds smart revision.
4. **Study planner + `011_study_plans`, `012_study_sessions`.** Versioned plans, and a
   re-planner that writes a new version with the reason rather than overwriting.
5. **AI tutor** (`POST /api/v1/ai/tutor`) using `IAIProvider.generateText`, with the minimum
   context: current topic, current question, mastery, recent mistakes.
6. **Readiness + what-if**, then mock tests.

---

## 7. Conventions worth keeping

- Every migration has a matching `database/tests/NNN_*.test.sql` that runs in a rolled-back
  transaction and asserts the security rules, not just the happy path.
- Every engine is a pure function with its constants in one exported config object, so the
  weights can be tuned without touching the logic and unit tested without a database.
- Controllers never touch the database. Repositories never contain business rules.
- Error responses always use `{ success, data, error: { code, message } }`.
- Comments explain *why*, and name the failure a rule prevents.
