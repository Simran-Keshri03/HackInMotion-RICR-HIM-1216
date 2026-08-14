# Challenges — status

The five stretch goals from the problem statement, and where each one actually stands. Kept honest
on purpose: a row marked done means it was run and checked, not that code exists for it.

| # | Challenge | Status |
|---|-----------|--------|
| 1 | Adaptive Re-Planning | ✅ automatic on read — verified live |
| 2 | Spaced Repetition System | ✅ SM-2 intervals, exam-capped — verified live |
| 3 | Voice-Based Doubt Solving | ✅ browser speech APIs — zero server cost |
| 4 | Gamification | ✅ activity heatmap, streaks, badges — live and verified |
| 5 | Group Study Mode | ✅ invite-code groups, deliberate privacy cut — verified with two accounts |

Plus one thing the main brief asks for that is not on this list and that two of these depend on:

| — | Study plan generator | ✅ done — versioned plans, day-by-day sessions, no AI call |

---

## Order of work, and why it is not the order above

Challenge 1 adjusts a study plan. There is no study plan yet — `011_study_plans.sql` and
`012_study_sessions.sql` are empty files from the initial scaffold. So the plan itself has to come
first; it is also a core requirement of the brief rather than a stretch goal, so this is not a
detour.

Working order:

1. ~~**Gamification**~~ — done. The groundwork was already in the database and half-maintained, and
   it was showing a learner something untrue, so it was both the cheapest and the most overdue.
2. ~~**Study plan generator**~~ — done.
3. ~~**Adaptive Re-Planning**~~ — done.
4. ~~**Spaced Repetition**~~ — done.
5. ~~**Voice-Based Doubt Solving**~~ — done, and taken out of order because it depends on nothing.
6. ~~**Group Study Mode**~~ — done. **All five challenges complete.**

---

## What exists today, per challenge

### 4. Gamification — ✅ done

Four columns existed, the dashboard read them, and nothing ever wrote them. A learner twenty-one
questions in was being told their streak was zero: a wrong number rather than a missing one, which
is the sort of thing that makes somebody stop believing the rest of the screen.

Verified on a live attempt — before, then after one answer taking 45 seconds:

| Column | Before | After |
|---|---|---|
| `total_attempts` | 21 | 22 |
| `current_streak_days` | **0** | **1** |
| `longest_streak_days` | **0** | **1** |
| `consistency_score` | **null** | **100.00** |
| `avg_seconds_per_question` | **null** | **45.00** |

**`habitEngine.ts`** holds the arithmetic, pure and separate from the database like the mastery
engine, because these numbers end up in front of the learner and inside the readiness score.

The decision worth defending: a streak looks like it needs the history walked day by day, and it
does not. The previous streak plus the date it was last touched is enough — same day changes
nothing, yesterday adds one, anything older starts again at one. That is O(1) on a path that runs
after every single answer; walking the history there would mean re-reading every attempt a learner
has ever made in order to add one. The average answer time is a running mean for the same reason.

Consistency is the exception and genuinely needs the history, because a streak knows how many days
are unbroken now and nothing about the days that broke it. So it is the one part that reads the
attempts.

Details that are deliberate rather than incidental:

- **Twenty questions in one day is one day.** Otherwise the streak counts answers, not days, and
  somebody could sit at 40 without ever coming back.
- **A broken streak is broken, not erased.** `longest_streak_days` keeps the record. The database
  has a CHECK requiring current ≤ longest, so a test asserts the pair can never violate it — a
  violation would silently lose the answer's counters, not just the streak.
- **A clock in the future does not cost a learner their streak.** A last-active date later than
  today means the device or the row is wrong, not the person; the streak is left alone.
- **Answering time is capped at ten minutes.** A learner who opens practice and comes back an hour
  later did not think for an hour, and one such answer left uncapped drags the average far enough
  to make the "20 minutes" in a study plan meaningless.
- **The first day scores 100, not zero.** The span includes today, so day one is 1/1 — correct, and
  the kinder answer at the moment somebody is most likely to give up.

On screen: day streak and days-studied percentage sit next to volume and accuracy, and a learner
whose record beats their current run is told what it was. 17 unit tests cover the boundaries.

#### Second pass: the activity heatmap and badges

Asked for after seeing the first version — the numbers were right but a streak counter alone does not
motivate. Added `activityEngine.ts`, `badgeEngine.ts`, `GET /learner/activity`, and two components on
the dashboard.

**The grid is a year of squares, the shape GitHub and LeetCode use.** Seeing the gaps alongside the
work motivates more than any single number: somebody looking at three weeks of green does not want to
be the one who breaks it.

Cost, measured: the shared bundle stayed at **98.30 kB gzip — unchanged**. The dashboard chunk grew
1.71 → 2.68 kB and the stylesheet 1.49 → 1.80 kB. About 1.3 kB gzip for the whole feature, because it
is 365 `div`s in a CSS grid rather than a charting library — one of those would have weighed more than
this app's entire own code, on a phone with 2-4 GB of RAM.

`grid-auto-flow: column` with seven rows does the week-bucketing in the browser, so the cells are
emitted in plain date order with no date maths in JS. The one thing that must be right is the leading
blanks: without them every square in the year sits one weekday row off — subtle enough to ship
unnoticed, wrong enough to make the grid meaningless.

**Streaks are recomputed from the grid, not read from `learner_profiles`.** The stored counter is
maintained forward one answer at a time, so it knows nothing about history written before it existed
and cannot be checked. Deriving both streaks from the day list means the number always agrees with the
squares beside it — a max streak that contradicts its own grid is something a learner notices at once
and cannot unsee. It also self-heals the accounts whose counter was never populated.

**A day with nothing answered *yet* does not break the current streak.** Somebody opening the app at
nine in the morning has not lost it; they have not had the chance to keep it. Telling them otherwise
is how an app talks a learner into giving up, which is why GitHub and LeetCode both count back from
yesterday when today is still empty.

**Badges are derived from the record, never stored.** There is no `badges` table and no award write,
which means a badge cannot be wrong: storage would be a second source of truth able to drift from the
attempts behind it — a failed write and it is missing, a replayed one and it is duplicated, a changed
threshold and every stored row is stale. What is given up is the "you just earned this!" moment and a
permanent award date if criteria change; both are worth less than the badges being true, and the date
is recoverable anyway, since the day a 7-day streak was reached is the seventh day of that run.

Sixteen tiers across five families — streak, volume, mastery, accuracy, revision. Details that are
decisions rather than defaults:

- **The first badge is three days, not thirty.** A ladder whose first rung is a month only rewards
  people who were already going to persist.
- **Accuracy badges need 30 answers behind them.** Four right out of four is a small sample, not
  accuracy, and a badge winnable in a minute means nothing.
- **Every lower tier is shown alongside the one just reached**, so the shelf a learner built is
  visible rather than collapsed to its highest point.
- **The mastery bar is 85 — the same number the planner stops allocating fresh time at.** A learner
  must not be told a topic is mastered by one screen while another still schedules work on it.
- **"Next up" is shown with earned badges, closest first.** A shelf is a record of the past; "two more
  days" is a reason to open the app tomorrow, and that is what the challenge actually asks for.

36 unit tests across the two engines, including one asserting badges are stable across repeated
recomputes — with no storage, that runs on every read and two reads a second apart must not differ.

### — Study plan generator — ✅ done

`011_study_plans.sql`, `012_study_sessions.sql`, `planEngine.ts`, `planService.ts`,
`GET /study-plan/current`, `POST /study-plan/generate`, and a `/plan` screen.

**No AI call.** Dividing a fixed number of minutes between topics by how much each needs and how much
each is worth is arithmetic. A plan out of a language model could not be reproduced, unit tested, or
explained to a learner asking why Tuesday looks like that — and it would cost money and twenty
seconds every time the plan changed. Generating a 179-day plan takes 4 seconds, all of it database.

**Plans are versioned, not edited.** A plan is a promise made on a date, and the point of
re-planning is that the promise changed; overwriting destroys the only evidence of what changed.
A partial unique index enforces one active plan per learner — in the database, because every screen
asks for "the" current plan and otherwise which one it got would depend on row order.

**Read-only to learners.** Both tables grant SELECT and nothing else. A learner who could write
their own plan could write an easy one, and every screen built on it would mean nothing. A trigger
takes `user_id` from the plan rather than the caller, so sessions cannot be attached to somebody
else's plan.

Verified live: version 1 built, version 2 built and version 1 correctly `superseded`, 358 session
rows across both, zero with a null `user_id`.

#### Two real bugs, both found by generating a plan rather than by reading the code

The unit tests had passed. Both of these were only visible against a real goal.

**A ten-minute day produced no plan at all.** `learning_goals` allows a daily budget as low as ten
minutes; the planner's session floor was a fixed fifteen. Every day was rejected as too short, so
the learner got an empty plan and the message *"there is not enough time before the exam"* — while
having 180 days of it. The floor now adapts: somebody who says ten minutes a day means it.

**One topic for the first twenty-five days.** Once a short day fits only one topic, the round-robin
gave that slot to the same queue until it emptied. The session cap could not help — at ten minutes
there is nothing to split — so the order rotates by one each day. Before: four days of *Number
Systems and Codes*. After: seven topics across the first seven days. Rotation changes only the
order, never the totals, so a weak topic still gets more days than a strong one.

A third design flaw was caught by a test before it ever ran: with a 60-minute day and a 60-minute
session cap, the cap did nothing and the weakest topic ate whole days. That is what
`topicsPerDayTarget` is for.

#### What the plan refuses to do

`planEngine.ts` is pure, and 19 tests hold it to promises a plan must not break: never overbook a
day past the learner's daily minutes, never schedule a session too short to teach anything, never
schedule past the exam, never put more than four topics in a day, never give a strong topic more
time than a weak one, and never silently drop a topic — anything that will not fit is named, with a
reason, on the screen.

### 1. Adaptive Re-Planning — ✅ done

`replanEngine.ts` (pure), plus reconciliation and rebuilding in `planService.refreshCurrent`.
Triggered by **reading** the plan, not by a button — a learner who comes back after a bad week sees a
plan that already accounts for it instead of a wall of things they failed to do.

Two steps on every load of `GET /study-plan/current`:

1. **Settle** every session whose date has passed, from the answers actually recorded. Only rows
   still `pending`, and only dates strictly before today — today's session is still live, and marking
   it missed at breakfast is the fastest way to make the feature look broken.
2. **Judge**, then rebuild if the plan has stopped describing reality.

Verified live. Four sessions were pushed into the past, then the plan was read:

```
sessions:    4 missed (settled from real attempts)
adjustment:  reason "missed_sessions"
             "You missed 4 sessions in the last 7 days, so the remaining work
              has been spread over the time you have left."
new plan:    1760 minutes over 8 topics, replacing 1790 over 7
```

#### Completion is recorded, never inferred

A session is settled from attempts on **that topic on that date** — not from "did they practise at
all that day". Somebody who spent an hour on a different topic was active and still did not do the
session, and the whole signal depends on telling those apart.

Nor is it self-marked. A learner who could mark their own sessions complete would make the
missed-session signal, and every re-plan built on it, worthless — which is why `study_sessions`
grants learners SELECT and nothing else, and why this read runs with the elevated client.

`partial` exists because it is the common case and it is not a failure. Three of five questions is
turning up. Folding it into `missed` would fire rebuilds at people who are studying.

#### What it refuses to do, which matters more than what it does

Re-planning triggers on read. Without restraint, a learner refreshing their plan five times on a bad
morning gets five versions, each one moving work they have not had a chance to attempt. A plan that
changes every time you look at it is not adaptive, it is unusable. So:

- **20 hours minimum between rebuilds.** Checked before any signal, because a plan just rebuilt
  cannot be out of date — and the signals are still true right after a rebuild, so checking them
  first would rebuild on every read. (20 rather than 24 so a morning studier is not blocked by having
  replanned slightly earlier yesterday.)
- **One missed day does nothing.** Three in a week is a pattern; one is a life. Rebuilding for one
  would move the remaining work *earlier* and make the plan harder exactly when somebody is already
  behind.
- **Missed sessions older than a week are ignored.** They were already absorbed by whatever plan came
  after them. Counting them forever would mean one bad week in June rebuilds the plan daily until the
  exam.
- **One struggling topic does nothing.** The adaptive engine already drops difficulty inside the
  session; the whole plan does not need rewriting. Two topics is the threshold.
- **Two wrong answers is not evidence.** A topic needs four recent attempts before its accuracy
  counts, or opening a new topic and missing the first question would rebuild the plan.
- **Missed sessions are reported ahead of poor performance** when both are true. "You did not do
  this" is a fact; "this is not working" is an inference from a handful of answers.
- **Never throws.** Opening the plan must return the plan. If adjusting fails, the existing plan is
  still workable, and an error screen because re-planning had a problem is worse than a plan a week
  out of date.

Every threshold lives in `REPLAN_CONFIG` where it can be argued with rather than buried in a
condition — a test asserts they stay there.

The learner is told, in words, on the screen: *"Plan updated — you missed 4 sessions in the last 7
days, so the remaining work has been spread over the time you have left."* Framed as the plan
adapting, not as the learner failing.

16 unit tests, most of them about restraint.

#### Honest gap

The brief says "performs poorly on a topic **re-test**". There are no re-tests yet — `017_mock_tests`
is still empty. The available signal is recent accuracy per topic from ordinary practice, which is
what is used. A formal re-test would be a stronger trigger and is not built.

### 2. Spaced Repetition System — ✅ done

`013_revision_schedule.sql`, `srsEngine.ts` (pure), `revisionRepository.ts`, revision slots in the
plan, and `GET /revision/due`.

The interval arithmetic is the **SM-2 / SuperMemo family** — the algorithm Anki and Mnemosyne use, and
the "proven memory-retention technique" the brief asks for. A good review multiplies the gap by an
ease factor; a bad one collapses it to a day. Ease drifts per topic, so a topic *this* learner finds
hard returns sooner than one they find easy at the same mastery score.

#### Two adaptations, and why an off-the-shelf scheduler would have been wrong

**The unit is a topic, not a card.** SM-2 takes a 0-5 grade from the learner about their own recall.
A topic is a set of questions with an accuracy the app already measures — so the grade is measured
rather than self-reported, which is strictly better evidence. People are famously poor judges of what
they know; this is the same reasoning that makes session completion read from attempts rather than
from a checkbox.

**The exam caps the interval.** Anki assumes you want to remember something forever, so its intervals
grow without limit. Here there is a date after which none of it matters, and a review scheduled 60
days out for an exam 30 days away is not a scheduling decision — it is dropping the topic without
saying so. Intervals are clamped to land before the exam, a final review is pulled in rather than
skipped, and a topic with no room left is reported as *finished for this goal* instead of sitting in
the list looking permanently overdue.

Verified live, on a topic seeded to a 30-day interval and then failed:

```
before:  interval 30 days   ease 2.50   lapses 0   due 2 days ago
after 3 wrong answers:
         interval  1 day    ease 2.35   lapses 1   due tomorrow   accuracy 33%
```

And in the plan (60 min/day, 3 topics due):

```
2026-08-14 (60 min)
  [REVISE] 15min  Machine Instructions and Addressing Modes — has slipped 2 times
  [REVISE] 15min  Control Unit Design — has slipped 2 times
  [learn ] 30min  Instruction Pipelining and Hazards — has not been started yet
```

#### Three real bugs, all found by running it rather than reading it

The unit tests passed through all three.

**1. The first-sighting write always failed, silently.** A CHECK constraint asserted
`review_count = 0 ⟺ last_reviewed_on IS NULL`. But the first time a topic is studied it is *learned*,
not reviewed — so the schedule records the date it was seen while the review count stays at zero,
which the constraint rejected. Because a failed schedule update is treated as survivable, the
rejection was swallowed and that path never worked once. The constraint now only asserts the half
that is true: a review count implies a date.

**2. The grade was diluted by history, so a failed review made the interval grow.** The review was
graded on the rolling recent-accuracy window. Three consecutive wrong answers scored 50% — older
correct answers pulled it up — which landed in the "shaky" band and grew the interval from 30 days to
36. Growing after a failed session is indefensible. SM-2 grades *the review that just happened*; the
history is already carried by the interval and the ease factor, so folding it into the grade counts
it twice. Now graded on today's answers on that topic.

**3. A topic due for revision was scheduled twice on the same day.** A due topic is also in the
goal's scope, so the learning pass scheduled it again — and `study_sessions_unique_slot` is unique on
(plan, date, topic), so the *entire* plan insert failed with a duplicate key and the learner saw
"Something went wrong". The database constraint caught a design gap the tests had missed, because
every test had disjoint learn and revision lists. The learning pass now skips a slot revision has
claimed, and the topic keeps its full allocation on a later day rather than losing a session.

#### A fourth bug, outside this feature, found the same way

**The server was using the UTC date as "today".** At 00:56 IST on 14 August it believed the date was
the 13th. Nothing errored. What broke was quieter: a learner studying at 01:00 and again at 10:00 the
same morning crosses UTC midnight in between, so it counted as **two days** — the streak inflated and
the revision schedule stepped twice for one sitting, pushing a topic weeks out for a single good
session. `profiles.timezone` already existed, `not null default 'Asia/Kolkata'`, and was simply never
read. `utils/dates.ts` now derives the learner's own date with `Intl.DateTimeFormat` — the platform's
own timezone database, so no dependency — and every place that asks "what day is it" goes through it.
This also corrected the Gamification streak, which had the same fault.

#### Restraint, again

- **Once per topic per day.** SM-2 steps per *review*, and a review here is a session, not one
  question. Stepping per answer would multiply the interval five times in one sitting.
- **Within a day the step can only get worse.** A later answer may still collapse a review that has
  turned into a failure, but a bad opening cannot be talked back up. So a session that opens with one
  lucky right answer cannot lock in a long interval, and the scheduler errs toward revising more —
  the safe direction for it to be wrong in.
- **Revision takes at most half a day** before new learning gets any. A plan showing nothing but
  revision does not move the learner forward, and the exam is not made only of what they have seen.
- **A backlog spreads over days** rather than stacking one impossible morning.
- **Read-only to learners.** Somebody who could push their own due dates out could remove every topic
  they found difficult from their revision list — precisely the topic the schedule exists to bring
  back.

25 unit tests on the engine, 6 on the date helper, 8 on revision slots in the plan.

### 3. Voice-Based Doubt Solving — ✅ done

`useVoice.ts` wraps the browser's own `SpeechRecognition` and `speechSynthesis`, wired into the
existing tutor. Speak a question, hear the answer.

**Nothing was added to the bundle and nothing is spent per use.** Measured: the shared chunk stayed
at exactly 98.30 kB gzip, and the tutor screen went from 1.55 kB to 2.59 kB. A speech library would
have been larger than the entire rest of the frontend — which matters on the 2-4 GB phones this has
to run on. No audio leaves the device either; what reaches the server is the same text a typed
question would have sent.

#### The failures that are invisible unless you look for them

Both APIs fail quietly, and each of these is handled rather than hoped about:

- **Firefox has no speech recognition at all.** Support is detected, not assumed, and the microphone
  is not rendered where it would do nothing. A dead button is worse than an absent one. Typing is
  always there.
- **Chrome truncates long utterances.** No error — the voice simply stops mid-explanation, which is
  precisely what a tutor's multi-paragraph answer is. Text is spoken in sentence-sized pieces.
  `toUtterances` is the one part of this that can be checked without a human listening, so it has 7
  tests: break at sentence ends and not mid-sentence, never exceed the safe length, split a
  punctuation-free run on a word boundary, lose no words, collapse the blank lines the tutor writes,
  and return nothing for nothing.
- **A refused microphone arrives as an error event, not a rejected promise.** Blocked permission,
  silence and general failure each get their own sentence, and all three end by pointing at the
  keyboard.
- **Neither API stops when the page changes.** Without cleanup a learner who navigates away
  mid-answer keeps hearing the tutor on the dashboard, with the microphone indicator still lit. Both
  are aborted on unmount.
- **Listening while speaking** would feed the tutor's own voice back in as the question, so speech is
  cancelled before the microphone opens.

#### Two decisions worth defending

**`en-IN`, not `en-US`.** Not cosmetic: US recognition mishears Indian-accented English often enough
that voice input becomes more annoying than typing, which is the same as not shipping the feature.

**The answer is spoken only when the question was spoken.** Reading every answer aloud talks over
somebody who typed theirs in a library; staying silent after somebody spoke theirs looks
half-finished. Asking how the question arrived answers both. A `🔊 Listen` button on any tutor
message covers the rest.

Interim results are shown while talking, because several seconds of a silent screen reads as broken
and people start over. Finishing a sentence sends the question — speaking is one action, not
speak-then-press-send.

#### Honest note

This needs a real browser and a microphone to judge; a unit test cannot hear. `toUtterances` is
tested, support detection and cleanup are written to fail safe, and the rest wants two minutes with
Chrome. Firefox will show no microphone — that is correct behaviour, not a bug.

### 5. Group Study Mode — ✅ done

`022_study_groups.sql`, `groupEngine.ts` (pure), `groupRepository.ts`, `groupService.ts`, five
endpoints and a `/groups` screen.

The only feature where one learner reads anything derived from another's account, and every other
table is locked to its owner by row-level security. So it got its own tables and its own policies:
**no policy on `concept_mastery`, `learner_profiles` or `question_attempts` was changed.** Peer reads
go through the elevated client with an explicit membership check in front of them — a narrower blast
radius than broadening an existing policy would have been.

#### The privacy cut, and why it is where it is

Shared: **display name, questions answered, current streak, topics mastered.**
Not shared: accuracy, weakest topics, wrong answers, per-topic mastery, tutor conversations, goals,
plans, email.

The line is between *effort and achievement* on one side and *weakness* on the other. A leaderboard of
how much people have done motivates. Publishing which topics somebody is worst at, to their
classmates, is a reason to stop using the app — and worse, it would make the honest answer to "should
I practise my weakest topic" become "not while my friends can see". LeetCode makes the same cut: it
shows how many problems you solved, never how many you got wrong.

Three things enforce it rather than one:

- **`SharedProgress` is a type, not a convention.** It is the complete list of what one learner can
  learn about another, so adding a field is a visible change to a file called `groupEngine` rather
  than an extra column slipped into a query.
- **The repository never loads what it will not share.** `learner_profiles` holds accuracy and
  `concept_mastery` holds per-topic scores; neither appears in any `select`. The safest way not to
  leak a field is to never fetch it.
- **The screen says so before anybody joins.** What the group can and cannot see is on the page at the
  moment somebody decides whether to be in one, not in a policy document.

#### Ranking on effort, not accuracy

Ranked by questions answered. Ranking on accuracy would reward answering only easy questions and
punish the learner grinding through the topic they find hardest — the exact behaviour the rest of the
app exists to encourage. A test asserts the grinder outranks the cherry-picker, so this cannot be
"improved" later without failing the suite.

Ties share a rank; inventing an order between identical numbers would be arbitrary and, on a screen
people compare themselves on, unkind for no reason. The final tiebreak is the name rather than
database order, so the board does not reshuffle between refreshes.

The group's combined total sits **above** the ranking. A study group that is only a leaderboard makes
four people feel behind one; a shared number is something they add to together.

#### Security details that are decisions

- **Groups cannot be listed, searched or discovered.** No endpoint for it, and no policy allowing a
  group to be found by its invite code from a browser — joining goes through the service, so a code
  cannot be brute-forced against the table directly.
- **Join is rate limited to 30/hour**, the tightest limit in the app, and not because it costs money.
  Six characters from a 31-symbol alphabet is ~900 million codes; unlimited attempts turn that into a
  guessing game whose prize is standing inside a stranger's group.
- **Invite codes avoid O/0, I/1 and L.** They get read aloud across a room; an ambiguous character
  means a learner who cannot join and has no idea why. Generated with rejection sampling rather than
  modulo, so no symbol is likelier than another.
- **Codes are inserted and retried on the unique index**, not checked for availability first — the
  check-then-insert version is a race two simultaneous creators can both win.
- **A group that is not yours returns 404, not 403.** Telling somebody a group exists but is not
  theirs confirms the id. A malformed group id returns the same 404, so the two cannot be told apart.
- **`is_group_member` is `security definer`.** The obvious policy — "read `group_members` rows for
  groups you belong to" — has to consult `group_members` to decide whether it may read
  `group_members`, and Postgres refuses with `infinite recursion detected in policy`. The function
  answers exactly one boolean and takes both ids, so it cannot be used to enumerate anything.
- **Group size is capped at 30 by a trigger**, not by the service. An invite code posted publicly
  otherwise turns one group into a mailing list.
- **Joining twice is idempotent.** Pasting a code again is not a mistake worth a red banner.

#### Verified with two real accounts

A second learner was created for this, because the whole feature is about what somebody *else* can see
and one account cannot prove anything about that.

```
peer, NOT a member of the group:
  GET /groups/{id}                 404 GROUP_NOT_FOUND
  GET /groups                      empty
  browser -> group_members         0 rows   (RLS)
  browser -> study_groups          0 rows   (RLS)
  browser -> concept_mastery       0 rows   (RLS)
  browser -> learner_profiles      1 row — their own, id-matched and confirmed

peer joins with the code in lower case and trailing spaces:  accepted
peer joins again:                                            idempotent, no duplicate
peer tries ZZZZZZ:                                           404

both members then see the same board:
  #1 Ayush — 36 answered, 2 day streak, 0 mastered
  #2 Priya —  0 answered, 0 day streak, 0 mastered

  fields exposed about a peer: displayName, questionsAnswered, currentStreakDays,
                              topicsMastered, rank, userId, isYou
  private fields exposed:     NONE
```

15 unit tests on the engine, covering the ranking rules and the invite-code alphabet.
