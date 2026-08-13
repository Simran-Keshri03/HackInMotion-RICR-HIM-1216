# CONTINUE HERE

Everything a new session needs: the rules that must not be broken, exactly what is built,
exactly what is left and in what order, and how to run and verify it all.

**To resume, paste this into a fresh session:**

> Read `docs/CONTINUE-HERE.md` and continue from section 6, step 1.

Last updated: 2026-08-13, after the app was deployed and verified live.

---

## 1. Rules — read before touching anything

These are not preferences. Breaking one of the first three can cost the competition.

**1. Never `git commit` or `git push` unless asked in that message.** Writing and editing files
is always safe; uncommitted work is invisible to GitHub. HackInMotion requires commits made
during the event from the venue.

**2. Every line of this repo is the team's own work, and it stays that way.** No third-party
project is named, credited or referenced anywhere in the code or docs, because none was copied
from. Standard techniques are used freely — spaced repetition, Laplace-style smoothing, an
append-only event log — but every table, function and file was written here. Do not add an
attribution line for any outside project, and do not paste code from one.

**3. Never claim the code was AI-generated.** No `Co-Authored-By` trailers in commits, no
"built with AI" line in any doc. If a submission form asks directly whether AI tools were used,
that is the team's own call to answer, not something to add unprompted.

**4. Every claim in the docs must be true.** `docs/architecture.md` is what the team will be
questioned on. Never write that something works when it has not been run. State measured
numbers as measured and estimates as estimates. An inflated doc is worse than an unfinished
feature, because it leaves the team unable to answer for their own project.

**5. The app must run on a 2-4GB Android phone over a slow connection.** No new frontend
dependency unless a few lines of own code cannot do it; current bundle is 97.6 kB gzip and a
regression is a bug. All learning computation stays server-side. No polling, no websockets.

**6. Never put a secret in the frontend or in a committed file.** Anything prefixed `VITE_` is
compiled into the browser bundle. `SUPABASE_SECRET_KEY` and `ANTHROPIC_API_KEY` live only in
`backend/.env` (gitignored) and in Render's dashboard.

---

## 2. Live URLs and credentials

| What | Where |
|---|---|
| App | https://adigamai.vercel.app |
| API | https://adigam-api.onrender.com/api/v1 |
| Repo | github.com/harsh-1-code/HackInMotion-RICR-HIM-1216 (private) |
| Supabase | project `ldvimvtbslswafllhgyb`, PostgreSQL 17.6, Mumbai |
| Demo login | `demo@adigam-demo.com` / `AdigamDemo2026` |

Git identity for this repo is already set: `shaunmortal <ayushkumar2.0ds@gmail.com>`. SSH key is
authorised. Team: Harsh Kumar, Ayush Kumar, Soumya Raghuwanshi, Simran Kumari Keshri.

**API credit: roughly $22 left of the original $26.** About $3.40 was spent filling the question
bank. Real cost is ~2.4 cents per verified AI question.

### Two Supabase dashboard settings still needed before a public demo

Both found by testing signup for real:

1. **Authentication → Sign In / Providers → turn off "Confirm email".** With it on, sign-up
   returns no session and sends an email, and Supabase's free mailer allows only a couple of
   messages per hour — the third person to sign up at the venue gets
   `email rate limit exceeded`. The demo account above exists precisely so this is not blocking.
2. **Use a real email domain when signing up.** Supabase rejects `@example.com`, `@adigam.test`
   and similar reserved domains with `email_address_invalid`.

---

## 3. How to run and verify

```bash
# Backend — http://localhost:4000/api/v1/health
cd backend && npm install && npm run dev
npm test          # 73 unit tests
npm run typecheck

# Frontend — http://localhost:5173
cd frontend && npm install && npm run dev
npx tsc -p tsconfig.app.json --noEmit
npm run build     # must stay near 97.6 kB gzip
```

`backend/.env` and `frontend/.env` already hold real credentials, including a working
`ANTHROPIC_API_KEY`. Both are gitignored.

### Database migrations and SQL tests

```bash
export PATH="/Library/PostgreSQL/18/bin:$PATH"
DB=$(grep '^DATABASE_URL=' backend/.env | cut -d= -f2-)

psql "$DB" -v ON_ERROR_STOP=1 -f database/migrations/000_roles.sql   # then 001, 002, …
psql "$DB" -v ON_ERROR_STOP=1 -f database/tests/001_profiles.test.sql
```

Every SQL test runs in a transaction and rolls back, so they are safe to repeat.

### Verifying the deployment

```bash
API=https://adigam-api.onrender.com/api/v1
SITE=https://adigamai.vercel.app

curl -s $API/health                                            # 200 + JSON
curl -s -o /dev/null -w '%{http_code}\n' $API/learner/summary   # must be 401
curl -s -o /dev/null -w '%{http_code}\n' $SITE/dashboard        # must be 200 (SPA rewrite)
curl -s -D- -o /dev/null -X OPTIONS $API/learner/summary \
  -H "Origin: $SITE" -H "Access-Control-Request-Method: GET" | grep -i access-control-allow-origin
```

A push to `main` auto-deploys both hosts.

---

## 4. What is built and verified

### Database — 10 tables live, 58 SQL assertions passing

| Migration | Table(s) | Tests |
|---|---|---|
| `000_roles` | grants; "auto-expose new tables" is off so access is deliberate | — |
| `001_profiles` | `profiles` + signup trigger | 5/5 |
| `002_topics` | `topics`, syllabus as one self-referencing tree | 6/6 |
| `003_questions` | `questions`; answers withheld from the browser | 7/7 |
| `004_learning_goals` | `learning_goals`, `learning_goal_topics` | 7/7 |
| `005_question_attempts` | append-only log, trigger-filled columns | 8/8 |
| `006_assessments` | `assessments`, `assessment_questions` | 8/8 |
| `007_learner_profiles` | cached learner traits | 8/8 |
| `008_concept_mastery` | per-topic mastery + its evidence | 9/9 |

**Question bank: 127 questions across 15 topics, 8-10 per topic at all three difficulties.**
37 hand-written, 90 written by Claude and verified. All `is_verified = true`.

### Backend — 5 endpoints, 73 unit tests passing

```
GET  /health
GET  /learner/summary
POST /attempts                  grade -> record -> recompute mastery
GET  /recommendations/next       next best action + the questions for it
POST /questions/generate         AI question generation (rate limited 10/hour/learner)
```

Engines, all pure functions with their constants in one config object:

- `services/practice/grader.ts` — mcq/msq/numeric, no partial credit (16 tests)
- `services/learner/masteryEngine.ts` — mastery 0-100 from evidence (13 tests)
- `services/adaptive/difficultyEngine.ts` + `recommendationEngine.ts` (23 tests)
- `services/ai/responseValidator.ts` — AI output validation (21 tests)

### Frontend — 3 screens, 97.6 kB gzip

`/login`, `/dashboard` (the "do this next" card + numbers + weakest topics),
`/practice` (question → answer → explanation → mastery before/after). Loading, empty and
error-with-retry states are shared; an ErrorBoundary prevents a white screen; routes are lazy.

### Verified end to end against the deployed stack

```
Q1 easy  wrong   mastery  —    → 29.17
Q2 easy  correct mastery 29.17 → 37.48  (+8.31)
Q3 hard  correct mastery 37.48 → 46.37  (+8.89)
next recommendation: practice | Normalisation | medium | 5 questions
```

The difficulty stepping from easy to medium on its own is the adaptive engine working. Also
confirmed live: 0% request failure rate, auth enforced, `correct_answer` absent from what the
browser receives, no secret in the bundle.

---

## 5. Design decisions that must not be undone

**Identity comes from the verified token, never the request.** No endpoint accepts a `user_id`.
`question_attempts` fills `topic_id` and `attempt_number` from a database trigger, so a client
cannot file an answer under the wrong topic or claim a later try was its first.

**The browser cannot read `questions.correct_answer` or `questions.explanation`.** Not by policy
— the `authenticated` role has no column privilege on them. That is why grading is server-side
and why `select *` from the frontend fails on purpose.

**Two Supabase clients.** `adminDb` (secret key, bypasses RLS) only for grading, writing
attempts and updating mastery. `userDb(token)` for reads, so RLS is a second lock.

**Learners can read their learner model, never write it.** `learner_profiles` and
`concept_mastery` have a SELECT policy and nothing else.

**Mastery is recomputed from the attempt log, not incremented.** The database enforces
`easy + medium + hard = total_attempts`, so a drifting cache fails loudly.

**Nothing outside `services/ai/providers/claudeProvider.ts` imports the Anthropic SDK.**
Everything depends on `IAIProvider`.

**AI output passes four gates**: schema-constrained generation, zod schema, business rules, and
an independent answer check where a second request solves the question without seeing the
proposed answer. Unverified questions are kept but hidden by RLS.

**`api.get` retries up to three times; `api.post` never retries.** Attempt numbers come from
existing rows, so a repeated submit would be logged as a second try and skew mastery.

**No UI library, no CSS framework, no data-fetching library, no `services/` layer in the
frontend.** Everything reaches the API through `lib/api.ts`; every response type is in
`types/api.ts`.

Search the code for `ponytail:` to find every deliberate shortcut with its upgrade path.

---

## 6. What is left — do these in this order

### Step 1 — Learning Goals (half done, finish this first)

Nothing else in the list works properly without it: with no goal, the adaptive engine falls
back to the entire syllabus, which is why the app currently jumps straight from login to
questions and skips the brief's steps 2-7.

Already written (**and accidentally swept into commit `7175cb3` while it was about CORS — they
are not wired up, so nothing is broken**):

- `backend/src/repositories/goalRepository.ts` — `findSubjects`, `findActive`, `findScope`,
  `replaceActive` (archives the old goal first, because a partial unique index allows only one
  active goal per learner)
- `backend/src/services/learning/goalService.ts` — `listSubjects`, `getActive`, `create`, plus
  an exported `daysUntil`. Validation that a CHECK constraint cannot do lives here: the exam
  date must be in the future and within two years, and at least one subject must be chosen.

Still to write:

1. `backend/src/controllers/goalController.ts` — thin, like `learnerController.ts`. A zod schema
   with `title` (1-120 chars), `examDate` (`YYYY-MM-DD`), `dailyMinutes` (10-960, matching the
   database CHECK), `subjectIds` (array of uuid, min 1). Use `adminDb` for the write and
   `userDb(token)` for reads.
2. `backend/src/routes/goals.routes.ts` — `GET /` (active goal or null), `GET /subjects`,
   `POST /` (create). Mount at `/goals` in `routes/index.ts`.
3. `frontend/src/pages/LearningGoals/LearningGoals.tsx` — title, a native `<input type="date">`
   (no picker library — see rule 5), daily minutes, and subject checkboxes from
   `GET /goals/subjects`. Show `daysRemaining` and `totalMinutesAvailable` as the learner types,
   so the plan's budget is visible before they commit to it.
4. Add the route to `frontend/src/router.tsx` and a link from the dashboard. If
   `GET /goals` returns null, the dashboard's empty state should point at this screen rather
   than at practice.
5. Add types to `frontend/src/types/api.ts`.

A unit test for `daysUntil` and the create-validation rules belongs in
`backend/tests/unit/`.

### Step 2 — Diagnostic assessment

The brief's first promise is "understands what the student knows", and right now that is learned
one question at a time. Table `006_assessments` is already built and tested; `assessments`
requires a `goal_id`, which is why Step 1 comes first.

- `assessmentRepository` + `services/assessment/{diagnosticBuilder,assessmentService}.ts`
- `POST /assessments` — build a paper spanning the goal's topics (roughly 2 per topic, mixed
  difficulty), store the question list, return it without answers
- `POST /assessments/:id/answer` — grade through the **existing** `PracticeService` with
  `source: 'assessment'` so mastery updates through one path, then link
  `assessment_questions.attempt_id`
- `POST /assessments/:id/complete` — set `correct_count`, `status`, `completed_at`; `accuracy`
  is a generated column so do not write it
- `GET /assessments/:id/result` — per-topic breakdown and the weakest topics
- `frontend/src/pages/Assessment/` — reuse the question-rendering shape from `Practice.tsx`

### Step 3 — AI tutor

The most visible AI feature after question generation.

- `POST /ai/tutor` using `IAIProvider.generateText` (already exists)
- **Use `claude-sonnet-5` for this**, not Opus: the tutor runs repeatedly during a demo and
  writing an explanation is well within Sonnet's range. Generation stays on Opus because a wrong
  question poisons the mastery data. The model id is a constant in `claudeProvider.ts`; make it
  a parameter rather than duplicating the provider.
- Send the minimum context: current topic, the question, mastery, recent mistakes. Not the
  learner's identity or full history.
- Rate limit it with the existing `rateLimit` middleware.
- Migration `015_ai_conversations` for history — write the table when the code that reads it
  exists, not before.
- `frontend/src/pages/AITutor/`, plus an "Ask about this" button on the practice screen.

### Step 4 — Retention engine and smart revision

- `010_retention_tracking`; Leitner-style boxes over `concept_mastery.last_correct_at`
- `services/learner/retentionEngine.ts` returning LOW / MEDIUM / HIGH risk
- Feed it into the adaptive engine's ranking, and build `013_revision_schedule` +
  `/revision` + `frontend/src/pages/SmartRevision/`

### Step 5 — Study planner and re-planner

- `011_study_plans`, `012_study_sessions`
- Versioned plans: never overwrite. A re-plan writes a new version and records why.
- `GET /study-plan/current`, `POST /study-plan/replan`
- `frontend/src/pages/StudyPlan/`

### Step 6 — Exam readiness and what-if

- `019_readiness_scores`, `services/readiness/{readinessEngine,bottleneckEngine}.ts`
- Configurable weighted score over mastery, coverage, consistency, difficulty handling. Label it
  "estimated readiness" everywhere — never imply a guaranteed result.
- `services/what-if/whatIfSimulator.ts` — re-run the readiness formula with one topic's mastery
  overridden. Clearly an estimate.
- `frontend/src/pages/ExamReadiness/`, `frontend/src/pages/WhatIf/`

### Step 7 — Mock tests

- `017_mock_tests`, `018_mock_test_attempts`
- Generate from the goal's topic distribution weighted by weakness; **serve without answers**
  (the column privileges already make this the only option)
- `frontend/src/pages/MockTest/`

### Step 8 — Also missing

- `docs/security.md`, `docs/database-schema.md`, `docs/ai-architecture.md`,
  `docs/adaptive-learning.md`, `docs/api-documentation.md` are **empty files**. The content
  exists in `docs/architecture.md`; splitting it out is a Phase 19 task.
- `docs/architecture-diagram.png` and `presentation.pptx` are named in the brief and do not
  exist. A diagram source can be written as text/mermaid; the image and the deck are manual.
- `learner_profiles` streaks, consistency score and average answer time are **never computed** —
  `recordAttemptOnProfile` only bumps the counters and the last-active date. The dashboard shows
  a 0-day streak for everyone. Fix this with Step 4, which needs the same day-by-day pass.
- `tests/security/` and `tests/integration/` directories exist but are empty. The SQL tests
  already cover cross-user access and RLS.
- Keep-alive ping (cron-job.org → `/api/v1/health` every 10 min) is **not set up**. Without it
  the free Render instance sleeps after 15 minutes and the next request takes ~50 seconds. Do
  this before any judged demo.
- **The project's name is spelled two ways.** `README.md` (written by a teammate) says
  *AdhigamAI* / *adhigamAI*; the code, the other docs, the LICENSE and the deployed URL all say
  *Adigam AI* / `adigamai.vercel.app`. Judges will notice. The team needs to pick one and make
  it consistent — this was left alone rather than overwriting a teammate's work.

---

## 7. Conventions to keep

- Every migration gets a matching `database/tests/NNN_*.test.sql` that runs in a rolled-back
  transaction and asserts the security rules, not just the happy path.
- Every engine is a pure function with its constants in one exported config object, so weights
  can be tuned without touching logic and tested without a database.
- Controllers never touch the database. Repositories never hold business rules. Services never
  hold SQL.
- Error responses are always `{ success, data, error: { code, message } }`.
- Comments explain *why*, and name the failure a rule prevents.
- Anything deliberately simplified gets a `ponytail:` comment naming the ceiling and the upgrade
  path.

---

## 8. Bugs already found and fixed — do not reintroduce these

| # | Bug | Found by |
|---|---|---|
| 1 | Difficulty weighting did nothing when accuracy was uniform — 20 easy and 20 hard both scored 87 | unit test |
| 2 | Engine opened a new topic every session and never returned to a weak one | live run |
| 3 | Recommendation promised 5 questions and served 1 | live run |
| 4 | Server silently refused to boot: `ANTHROPIC_API_KEY=` (empty) failed a `.optional()` zod check | boot log |
| 5 | Backend could not read its own question bank — `service_role` had no grants after disabling auto-expose | failing request |
| 6 | AI failure returned 500 because the provider was constructed outside the try block | live run |
| 7 | Database password containing `@` and `#` broke the connection URL | connection failure |
| 8 | Bulk generation passed a placeholder `created_by` uuid; every batch generated, verified, then failed on a foreign key — about $1.25 of credit wasted | failing insert |
| 9 | `findTopicWithSubject` used a PostgREST embedded self-join that silently returned nothing, so the generator was told a topic's subject was the topic itself | wrong prompt context |
| 10 | The verification call ran before the insert, so a duplicate question still cost a paid check | cost review |
| 11 | The dashboard's first request after sign-in failed with `JWT issued at future` | live run |
| 12 | `healthCheckPath` in `render.yaml` took the single free instance offline; 5-50% of requests got the host's own 404 while the app's uptime climbed with no restart | deployed measurement |
| 13 | `vercel.json` carried `"//"` comment keys, which Vercel's schema rejects — the import failed outright | Vercel import error |
| 14 | `CORS_ORIGINS` still held only localhost after deploy, so every browser request was refused while both halves were healthy | preflight check |
