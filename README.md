# Adigam AI

**AI-Powered Adaptive Learning Assistant** — HackInMotion 2026 · Theme: Education & EdTech

> Status: Phase 3 of 20 (repository scaffold). This README grows with the project;
> the full submission version is written in Phase 19.

## Problem

Every student gets the same content and the same schedule, regardless of what they
already know, how fast they learn, or how much time they have left. Adigam AI builds a
model of the individual learner from their actual attempts — not their self-rating — and
uses it to decide what they should do next.

## Approach

Deterministic backend logic owns every learning calculation. Claude is a reasoning and
explanation layer on top, never the source of truth.

```
Attempts → Learner Model → Mastery / Mistake / Retention →
Adaptive Engine → Next Best Action → Study Plan / Practice / Revision / Mock Test →
Performance → Learner Model update → Re-plan → Exam Readiness
```

## Stack

| Part | Tech |
|---|---|
| Frontend | React 19, TypeScript, Vite |
| Backend | Node, Express 5, TypeScript (layered: routes → controllers → services → repositories) |
| Database | Supabase / PostgreSQL with Row Level Security |
| AI | Anthropic Claude behind an `IAIProvider` abstraction (server-side only) |

## Repository layout

```
frontend/   React SPA. No secrets, no heavy computation, talks only to our API.
backend/    Express API. Owns the learner model, adaptive engine, planner and all AI calls.
database/   Migrations, schema and seed data.   (added in Phase 5)
docs/       Architecture, security, AI and adaptive-learning notes.   (added in Phase 19)
```

## Running locally

```bash
# backend
cd backend && cp .env.example .env   # fill in Supabase keys
npm install && npm run dev           # http://localhost:4000/api/v1/health

# frontend
cd frontend && cp .env.example .env
npm install && npm run dev           # http://localhost:5173
```

The backend refuses to start if required environment variables are missing — that is
deliberate.

## Environment variables

Secrets live only in `backend/.env`. `ANTHROPIC_API_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` are server-side only and are never sent to the browser.
The frontend receives only `VITE_`-prefixed public values. See the two `.env.example`
files.

## API conventions

All routes are under `/api/v1`. Every response uses one of two shapes:

```json
{ "success": true,  "data": { }, "error": null }
{ "success": false, "data": null, "error": { "code": "NOT_FOUND", "message": "..." } }
```


## Team Details

- HARSH KUMAR
- AYUSH KUMAR
- SOUMYA RAGHUWANSHI
- SIMRAN KUMARI KESHRI
  
- Screenshots, architecture diagram, deployment URLs
- `docs/`, `api-documentation.md`, presentation

## License

Copyright © 2026 Adigam AI. All rights reserved. See [LICENSE](LICENSE).
