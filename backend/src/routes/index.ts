import { Router } from 'express';
import { adminDb } from '@/config/database.js';
import { aiRouter } from '@/routes/ai.routes.js';
import { attemptsRouter } from '@/routes/attempts.routes.js';
import { recommendationsRouter } from '@/routes/adaptive.routes.js';
import { assessmentRouter } from '@/routes/assessment.routes.js';
import { curriculaRouter } from '@/routes/curricula.routes.js';
import { goalsRouter } from '@/routes/goals.routes.js';
import { groupRouter } from '@/routes/group.routes.js';
import { learnerRouter } from '@/routes/learner.routes.js';
import { mockTestRouter } from '@/routes/mockTest.routes.js';
import { planRouter } from '@/routes/plan.routes.js';
import { readinessRouter } from '@/routes/readiness.routes.js';
import { revisionRouter } from '@/routes/revision.routes.js';
import { questionsRouter } from '@/routes/questions.routes.js';
import { asyncRoute, sendError, sendOk } from '@/utils/http.js';

/** All v1 routes hang off this router. Feature routers get mounted here. */
export const v1Router = Router();

v1Router.get('/health', (_req, res) => {
    sendOk(res, { status: 'ok', uptime: Math.round(process.uptime()) });
});

/**
 * GET /api/v1/health/deep — is the process up *and* is the database reachable?
 *
 * The shallow check above answers neither of the two questions that actually matter in this deployment,
 * and both have a free-tier deadline attached:
 *
 * - The backend host spins the instance down after about fifteen minutes without a request, so the next
 *   visitor waits through a cold start long enough to look like a broken site.
 * - The database provider pauses a free project after a week without activity, and a paused database is
 *   not a slow app, it is a dead one.
 *
 * A ping that only touched Express would solve the first and quietly leave the second, so this does one
 * cheap read. `head: true` asks Postgres for a count and no rows, against a two-row table, which is
 * about as small as a query gets while still being a real round trip.
 *
 * Unauthenticated on purpose — a scheduled job has no session — and it returns nothing but a status, an
 * uptime and whether the database answered. There is no data here to leak.
 *
 * 503 when the database is unreachable rather than 200, so this is a health check rather than a
 * keep-alive that lies. Something watching it should be able to tell the difference.
 */
v1Router.get(
    '/health/deep',
    asyncRoute(async (_req, res) => {
        const startedAt = Date.now();

        const { error } = await adminDb
            .from('curricula')
            .select('id', { count: 'exact', head: true });

        const latencyMs = Date.now() - startedAt;

        if (error) {
            console.error('Deep health check failed:', error.message);

            sendError(res, 503, 'DATABASE_UNREACHABLE', 'The database did not answer.');
            return;
        }

        sendOk(res, {
            status: 'ok',
            database: 'reachable',
            latencyMs,
            uptime: Math.round(process.uptime()),
        });
    })
);

v1Router.use('/ai', aiRouter);
v1Router.use('/assessments', assessmentRouter);
v1Router.use('/curricula', curriculaRouter);
v1Router.use('/goals', goalsRouter);
v1Router.use('/learner', learnerRouter);
v1Router.use('/groups', groupRouter);
v1Router.use('/study-plan', planRouter);
v1Router.use('/mock-tests', mockTestRouter);
v1Router.use('/revision', revisionRouter);
v1Router.use('/readiness', readinessRouter);
v1Router.use('/attempts', attemptsRouter);
v1Router.use('/recommendations', recommendationsRouter);
v1Router.use('/questions', questionsRouter);
