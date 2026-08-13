# Deployment

Frontend on Vercel, backend on Render, database already on Supabase. Follow the parts in order —
each one needs a URL from the step before it.

Committed configuration: `render.yaml` (repository root) and `frontend/vercel.json`. Neither
contains a secret; every secret is entered once in the host's dashboard.

---

## Before you start

Both hosts deploy from GitHub, so the code has to be pushed first. **That means a commit** —
which, per the project's own rule, happens from the venue and only when you decide to.

You will also need the values already in `backend/.env`:

```
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY          ⚠️ never paste this anywhere public
ANTHROPIC_API_KEY
```

`DATABASE_URL` is **not** needed in production. It exists for running migrations and SQL tests
from a laptop; the backend talks to Supabase over HTTPS with the keys above.

---

## Part 1 — Backend on Render

1. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**.
2. Connect the GitHub repository. Render finds `render.yaml` and proposes a service called
   `adigam-api`.
3. It will ask for each `sync: false` variable. Fill in the four Supabase / Anthropic values.
   For `CORS_ORIGINS`, put `http://localhost:5173` for now — Part 3 replaces it with the real
   frontend URL.
4. **Apply**. The first build takes 2-4 minutes.
5. Copy the service URL, which looks like `https://adigam-api.onrender.com`, and check it:

```bash
curl https://adigam-api.onrender.com/api/v1/health
# {"success":true,"data":{"status":"ok","uptime":…},"error":null}
```

If that returns JSON, the backend is live.

---

## Part 2 — Frontend on Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the same repository.
2. Set **Root Directory** to `frontend`. Vercel detects Vite; leave the build command and
   output directory alone.
3. Add three environment variables:

| Name | Value |
|---|---|
| `VITE_API_URL` | `https://adigam-api.onrender.com/api/v1` — the Render URL **plus `/api/v1`** |
| `VITE_SUPABASE_URL` | same as `SUPABASE_URL` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | same as `SUPABASE_PUBLISHABLE_KEY` |

**Never add `SUPABASE_SECRET_KEY` or `ANTHROPIC_API_KEY` here.** Everything prefixed `VITE_`
is compiled into the JavaScript the browser downloads — a secret there is a secret published
on the internet.

4. **Deploy**, then copy the URL (`https://adigam-xyz.vercel.app`).

---

## Part 3 — Point the backend at the frontend

Until this is done, every browser request is blocked by CORS and the app looks broken while
both halves are actually fine.

In Render → `adigam-api` → **Environment**, set:

```
CORS_ORIGINS = https://adigam-xyz.vercel.app
```

No trailing slash. Save; Render redeploys automatically. Then open the Vercel URL and sign in.

To allow both the deployed site and local development at once, comma-separate them:

```
CORS_ORIGINS = https://adigam-xyz.vercel.app,http://localhost:5173
```

---

## Part 4 — Keep the backend awake (do not skip this)

Render's free plan **stops the service after 15 minutes with no traffic**, and the next request
waits roughly 50 seconds while it starts again. If a judge opens the app cold, that is what they
see first.

The fix is a free ping every 10 minutes:

1. [cron-job.org](https://cron-job.org) → create a free account → **Create cronjob**.
2. URL: `https://adigam-api.onrender.com/api/v1/health`
3. Schedule: every 10 minutes.
4. Save and enable.

`/api/v1/health` needs no authentication, touches no database and returns a few bytes, so this
costs nothing.

**Belt and braces on the day:** open the app yourself 2-3 minutes before presenting. Even with
the cron running, a warm service is one less thing to hope for.

---

## Part 5 — Supabase settings for a live demo

Two dashboard changes, both found by testing signup for real:

1. **Authentication → Sign In / Providers → turn off *Confirm email*.** With it on, signing up
   sends an email and returns no session, and Supabase's built-in mailer allows only a couple of
   messages per hour on the free plan — the third person to sign up at the venue gets
   `email rate limit exceeded`. With it off, sign-up signs the learner straight in.
2. **Use a real email domain when signing up.** Supabase rejects `@example.com`, `@adigam.test`
   and similar reserved domains with `email_address_invalid`.

Supabase's own URL configuration does not need changing for this app: it uses password sign-in,
not magic links or OAuth redirects, so there is no callback URL to allow-list.

---

## Verifying the deployment

```bash
API=https://adigam-api.onrender.com/api/v1
SITE=https://adigam-xyz.vercel.app

# 1. backend alive
curl -s $API/health

# 2. auth is enforced — must be 401, not 200
curl -s -o /dev/null -w '%{http_code}\n' $API/learner/summary

# 3. CORS allows the real frontend — must echo the site URL
curl -s -D- -o /dev/null -X OPTIONS $API/learner/summary \
  -H "Origin: $SITE" -H "Access-Control-Request-Method: GET" | grep -i access-control-allow-origin

# 4. SPA routing — opening a deep link directly must serve the app, not a 404
curl -s -o /dev/null -w '%{http_code}\n' $SITE/dashboard

# 5. no secret leaked into the bundle — must print nothing
curl -s $SITE/assets/*.js 2>/dev/null | grep -c 'sb_secret\|sk-ant' || true
```

Then in a browser: sign in, reach the dashboard, answer a question, and watch the mastery number
move. That last step is the only one that proves the whole stack.

---

## If something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| Site loads, every request fails, console says CORS | `CORS_ORIGINS` does not exactly match the site origin | Set it in Render with no trailing slash and no path |
| First request takes ~50 seconds | Render free plan spun the service down | Part 4 |
| Reloading `/dashboard` gives 404 | SPA rewrite missing | `frontend/vercel.json` is committed — confirm Root Directory is `frontend` |
| Backend exits immediately on deploy | A required environment variable is missing | Intentional: `config/environment.ts` refuses to boot on bad config. The Render log names the variable |
| Sign-up says `email rate limit exceeded` | Supabase's mailer cap | Part 5, item 1 |
| Sign-up says `email_address_invalid` | Reserved test domain | Part 5, item 2 |
| Question generation returns 503 | `ANTHROPIC_API_KEY` not set on Render | Add it in Render → Environment |
| Everything works but mastery never changes | The frontend is talking to a different backend | Check `VITE_API_URL` includes `/api/v1` |
