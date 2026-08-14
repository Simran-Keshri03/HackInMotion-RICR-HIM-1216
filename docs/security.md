# Security

How Adigam AI protects a learner's data, and — more importantly — how it protects the *integrity* of
what the app claims about them.

Every claim in this document was verified against the running system rather than read off the source.
The commands used are included so any of it can be checked again.

---

## The one-line version

**A learner's browser holds no privilege to read an answer key or to write a single number the app
uses to judge them.** Not "the API does not return it" — the database refuses.

There are two different things being defended here, and they need different mechanisms:

| Risk | Why it matters | Defence |
|---|---|---|
| Reading somebody else's data | ordinary privacy | Row-level security, on every table |
| Reading data *about* yourself that would break the product | an answer key makes every score meaningless | Column-level privileges |
| Writing data about yourself | self-marked mastery makes every plan, test and recommendation fiction | No write privilege at all |

The third is the one most easily overlooked. A learner who could set their own mastery score is not a
privacy problem — they are a correctness problem, because the adaptive engine, the study plan, the
revision schedule and the readiness figures are all derived from it.

---

## 1. Identity comes from a verified token, never from the request

No endpoint accepts a user id. The learner is whoever Supabase says the bearer token belongs to:

```ts
const { data, error } = await adminDb.auth.getUser(token);   // verified with Supabase
req.auth = { userId: data.user.id, accessToken: token };
```

`getUser` is a verification call, not a decode — a forged or edited token fails it.

Verified: no controller reads a user id from `req.body`, `req.query` or `req.params`.

```bash
grep -rn "userId" backend/src/controllers/*.ts | grep -E "req.body|req.query|req.params"
# no matches
```

Because identity cannot be supplied, the whole class of "change the id in the request and read
somebody else's data" does not exist. Malformed and missing tokens are answered distinctly —
`Malformed token.` and `Missing bearer token.` — both as 401.

---

## 2. The answer key is unreachable from the browser

`questions` grants `authenticated` SELECT on **seven named columns**. `correct_answer` and
`explanation` are not among them:

```
granted: id  topic_id  question_type  body  options  difficulty  marks
```

The only privilege `authenticated` holds on `correct_answer` and `explanation` is `REFERENCES`, which
permits a foreign key and no reading of data.

This is not a filtered API response. Asking for the column directly, from the browser, with a valid
signed-in token:

```bash
GET /rest/v1/questions?select=correct_answer   →  42501 permission denied for table questions
GET /rest/v1/questions?select=*                →  42501 permission denied for table questions
GET /rest/v1/questions?select=body             →  200  [{"body":"In C, what is the value of 17 % 5?"}]
```

The middle line is the interesting one. `select=*` **fails** rather than silently returning the
allowed columns — asking for everything is refused outright, so there is no version of this request
that leaks the key.

### What this buys

Grading happens on the server, and the answer travels back only in the response to a submitted
attempt. That is what makes a score mean something:

- **Practice** returns the correct answer and the explanation *after* the attempt is recorded.
- **Mock tests** never return them while the paper is open, and mark every answer in one pass at
  submission. Withholding answers could not be done in the client — they would sit in the response,
  visible in devtools — which is precisely why mock tests have their own tables rather than looping
  over the practice endpoint.
- **AI-generated questions** stay invisible until verified. RLS on `questions` filters on
  `is_verified`, so a question whose answer failed its independent check is present in the table and
  unreadable by learners.

---

## 3. Learners cannot write anything the app judges them by

Across all twenty tables in the public schema, `authenticated` holds **zero table-level INSERT,
UPDATE or DELETE grants**:

```sql
select count(*) from information_schema.role_table_grants
where grantee = 'authenticated' and table_schema = 'public'
  and privilege_type in ('INSERT','UPDATE','DELETE');
--  0
```

The only write privilege granted anywhere in the schema is **column-level UPDATE on four columns of
`profiles`** — `display_name`, `avatar_url`, `timezone`, `settings`. Those are the learner's own
preferences and nothing is derived from them except how the app addresses them.

Tested from the browser with a valid token, against the learner's *own* row:

```bash
PATCH /rest/v1/profiles       {"email": "hacked@evil.com"}   →  42501 permission denied
PATCH /rest/v1/concept_mastery {"mastery_score": 100}        →  42501 permission denied
PATCH /rest/v1/profiles       {"display_name": "Ayush"}      →  200  updated
```

Everything else — attempts, mastery, plans, sessions, revision schedules, test marking, group
membership — is written by the backend through an elevated client, behind validation the learner
cannot skip.

### Read-only by design, table by table

| Table | Why learners may not write it |
|---|---|
| `concept_mastery` | a self-set score makes every plan and recommendation fiction |
| `question_attempts` | append-only evidence; the mastery formula runs on it |
| `study_plans`, `study_sessions` | self-marked sessions destroy the missed-session signal that adaptive re-planning reads |
| `revision_schedule` | pushing a due date out would remove every difficult topic from revision — precisely the topic the schedule exists to return |
| `mock_tests`, `mock_test_questions` | `is_correct` **is** the marking; writing it means marking your own paper |
| `learner_profiles` | streaks and consistency are shown to a study group |
| `group_members` | inserting directly would let anyone join any group whose id they learned, making the invite code decorative |

---

## 4. Row-level security on every table

All twenty tables in `public` have RLS enabled, with 21 policies between them.

```sql
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r';
--  all 20 rows: true
```

The shape is always the same: `using (auth.uid() = user_id)`, or — for rows reachable only through a
parent the learner owns — an `exists` check against that parent. `ai_messages` is readable only
through an owned conversation; `mock_test_questions` only through an owned test.

Two subtleties worth recording:

**`questions` and `topics` are shared, not per-learner.** Their policies gate on `is_verified` and on
nothing user-specific, because a question bank is meant to be common. The per-learner protection
there is the column grant, not the row policy.

**`is_group_member` is `security definer`, and has to be.** The obvious policy — "read
`group_members` rows for groups you belong to" — must consult `group_members` to decide whether it may
read `group_members`, and Postgres refuses that outright:

```
infinite recursion detected in policy for relation "group_members"
```

A `security definer` function runs with the definer's rights, so the lookup inside it is not itself
subject to the policy. It is written as narrowly as possible: it takes both ids, answers one boolean,
and so cannot be used to enumerate anything.

### RLS is a second lock, not the only one

Backend writes use the elevated client, which **bypasses RLS by design**. So every repository method
that touches learner data filters on the user id from the token as well. Those filters are
load-bearing, not decorative — with the elevated client they are the only thing standing between a
record id and somebody else's data, which is why `findConversation`, `findTest` and `findGroup` all
take a user id and return 404 without it.

---

## 5. The database refuses to be lied to

Four `BEFORE INSERT` triggers overwrite or reject caller-supplied values, because a denormalised
field the caller controls is a field the caller can lie about:

| Trigger | What it enforces |
|---|---|
| `question_attempts_fill_fields` | takes `topic_id` from the question and counts `attempt_number` from existing rows, so neither can be forged |
| `study_sessions_fill_user` | takes `user_id` from the plan, so sessions cannot be attached to another learner's plan |
| `mock_test_questions_fill_topic` | takes `topic_id` from the question, so a per-topic breakdown cannot be skewed |
| `group_members_enforce_size` | caps a group at 30, so a publicly posted invite code cannot turn one group into a mailing list |

CHECK constraints carry the same intent: mastery difficulty buckets must sum to the total attempts, a
current streak may not exceed the longest, lapses may not exceed reviews, a submitted test must carry
a complete result, and a marked question must have an answer. These are invariants the application
also maintains — stated twice on purpose, because the copy in the database is the one that cannot be
forgotten during a refactor.

---

## 6. Keys, and what is safe to publish

| Key | Where it lives | Exposure |
|---|---|---|
| Supabase publishable key | compiled into the frontend bundle | public by design; grants nothing without a signed-in token, because every table is behind RLS |
| Supabase secret key | backend environment only | never sent to a browser |
| Anthropic API key | backend environment only | never sent to a browser |
| Postgres connection string | backend environment only | never sent to a browser |

Verified: no reference to the secret key or `service_role` exists anywhere in `frontend/src`.

The frontend deliberately uses `@supabase/auth-js` rather than the full `supabase-js`. The security
consequence is incidental but real: the browser has no PostgREST client at all in the shipped bundle,
so all data access goes through the app's own API where the validation lives.

`.env`, `.env.*` and the demo credentials file have been gitignored since the first commit. Before the
repository was made public, the entire git history was scanned for API keys, connection strings, JWTs
and committed `.env` files. One real leak was found — the demo account's password, written into a
documentation file — and it was removed and **the password rotated**, which also makes the copy left
in history useless.

---

## 7. Abuse limits

Rate limits are per learner per hour, and the reason differs by endpoint:

| Endpoint | Limit | Why |
|---|---|---|
| `POST /questions/generate` | 10 | each call is real money at the model |
| `POST /curricula/resolve` | 20 | free-text AI entry point |
| `POST /ai/tutor` | 40 | AI cost, but a learner asks a lot in a session |
| `POST /study-plan/generate` | 20 | writes a hundred rows and supersedes the previous plan |
| `POST /mock-tests` | 20 | writes a paper and retires the open one |
| `POST /groups/join` | 30 | **not a cost limit** — see below |

The join limit is the tightest relative to its cost, which is zero. An invite code is six characters
from a 31-symbol alphabet, about 900 million combinations. Unlimited attempts turn that into a
guessing game whose prize is standing inside a stranger's group and reading their progress. Thirty an
hour makes that hopeless while being far more than a person mistyping a code they were given.

Group codes also avoid `O`, `0`, `I`, `1` and `L` — they get read aloud across a room — and are
generated with rejection sampling rather than modulo, so no symbol is likelier than another.

---

## 8. Not-found rather than forbidden

Anything a learner does not own answers **404, not 403**. Telling somebody a record exists but is not
theirs confirms the id, which is itself a small leak. Applied consistently:

```
GET /groups/{someone elses}      →  404 GROUP_NOT_FOUND
GET /mock-tests/{someone elses}  →  404 TEST_NOT_FOUND
GET /ai/conversations/{not mine} →  404 CONVERSATION_NOT_FOUND
```

A malformed id returns the **same** 404 as a real one that is not yours, so the two cannot be told
apart by probing.

---

## 9. What a study group can see

The only feature where one learner reads anything derived from another's account. It got its own
tables and its own policies: **no policy on `concept_mastery`, `learner_profiles` or
`question_attempts` was loosened to build it.**

**Shared:** display name, questions answered, current streak, topics mastered.
**Not shared:** accuracy, weakest topics, wrong answers, per-topic mastery, tutor conversations,
goals, plans, email address.

The line is between *effort and achievement* on one side and *weakness* on the other. Publishing which
topics somebody is worst at, to their classmates, would make the honest answer to "should I practise my
weakest topic" become "not while my friends can see" — which would break the product to add a feature.

Three mechanisms hold it rather than one:

1. `SharedProgress` is a **type**, so adding a field is a visible change to a file named
   `groupEngine` rather than a column slipped into a query.
2. The repository **never selects** what it will not share. The safest way not to leak a field is to
   never fetch it.
3. Groups cannot be listed, searched or discovered. There is no endpoint for it and no policy
   permitting a lookup by invite code from a browser.

Verified with two real accounts, because a single account cannot prove anything about what somebody
else can see:

```
peer, not a member:
  GET /groups/{id}                    →  404
  GET /groups                         →  []
  browser → group_members             →  0 rows
  browser → study_groups              →  0 rows
  browser → concept_mastery           →  0 rows
  browser → learner_profiles          →  1 row, their own, id-matched
```

---

## 10. Input validation at both trust boundaries

zod validates HTTP bodies **and** model output. The second is easy to forget: a language model is an
untrusted input source, and its reply is parsed, schema-checked, business-checked, and then — for a
generated question — solved again by an independent request that has never seen the proposed answer.
A question becomes visible only when the two agree.

Twenty-one invalid-input cases were exercised against the live API. Every one returns 400 with a
message naming the field, and none reaches the database. Numeric bounds mirror the CHECK constraints,
so a bad value is a readable 400 rather than a database error the client cannot act on.

Timezones are validated against the platform's own timezone database rather than a hand-written list,
because a stored zone the server cannot format would silently corrupt every streak and revision date
for that learner.

---

## 11. Honest limitations

Written down deliberately. A security document that lists only strengths is not a security document.

- **Rate limiting is in-process.** Counters live in a `Map`, so they reset on deploy and are per
  instance. Correct on the single instance this runs on; moving to more than one requires moving the
  counter into Postgres or Redis first. The code says so at the top of the middleware.
- **Question verification is a second model call, not a human.** It is strictly better than no check
  and catches the common failure, but a question both calls agree on and both get wrong would still
  reach a learner. Unverified questions are retained rather than deleted so they can be reviewed.
- **Invite codes cannot be rotated.** A code shared too widely can only be escaped by leaving the
  group and making another. The 30-member cap limits the damage.
- **No audit log.** Elevated writes are not recorded separately from their effects. Nothing needs it
  yet — there are no admin actions and no moderation surface.
- **Email confirmation is currently enabled**, so a new account cannot sign in until the link is
  clicked. That is the safer default and it is worth knowing before a live demonstration, because the
  built-in mailer also limits how many messages an hour it will send.
- **The deployment is a free tier.** No WAF, no DDoS protection beyond what the hosts provide, and the
  backend cold-starts — the first request after a quiet period can be slow enough to look like a
  failure, which the client now handles with a timeout rather than hanging.

---

## Reproducing these checks

```bash
# Column grants on questions — correct_answer must be absent
psql "$DATABASE_URL" -c "select column_name, privilege_type
  from information_schema.column_privileges
  where table_name='questions' and grantee='authenticated' order by column_name;"

# Learners hold no table-level write grant anywhere
psql "$DATABASE_URL" -c "select count(*) from information_schema.role_table_grants
  where grantee='authenticated' and table_schema='public'
    and privilege_type in ('INSERT','UPDATE','DELETE');"

# RLS is on for every table
psql "$DATABASE_URL" -c "select relname, relrowsecurity from pg_class
  where relnamespace='public'::regnamespace and relkind='r' order by relname;"

# Try to read an answer key with a real signed-in token
curl "$SUPABASE_URL/rest/v1/questions?select=correct_answer&limit=1" \
  -H "apikey: $PUBLISHABLE_KEY" -H "Authorization: Bearer $LEARNER_TOKEN"
```

The SQL tests under `database/tests/` assert the same properties inside rolled-back transactions, so
they are safe to run repeatedly against a live database.
