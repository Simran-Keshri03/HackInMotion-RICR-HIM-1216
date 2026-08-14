import { Router } from 'express';
import { aiRouter } from '@/routes/ai.routes.js';
import { attemptsRouter } from '@/routes/attempts.routes.js';
import { recommendationsRouter } from '@/routes/adaptive.routes.js';
import { curriculaRouter } from '@/routes/curricula.routes.js';
import { goalsRouter } from '@/routes/goals.routes.js';
import { groupRouter } from '@/routes/group.routes.js';
import { learnerRouter } from '@/routes/learner.routes.js';
import { mockTestRouter } from '@/routes/mockTest.routes.js';
import { planRouter } from '@/routes/plan.routes.js';
import { revisionRouter } from '@/routes/revision.routes.js';
import { questionsRouter } from '@/routes/questions.routes.js';
import { sendOk } from '@/utils/http.js';

/** All v1 routes hang off this router. Feature routers get mounted here. */
export const v1Router = Router();

v1Router.get('/health', (_req, res) => {
    sendOk(res, { status: 'ok', uptime: Math.round(process.uptime()) });
});

v1Router.use('/ai', aiRouter);
v1Router.use('/curricula', curriculaRouter);
v1Router.use('/goals', goalsRouter);
v1Router.use('/learner', learnerRouter);
v1Router.use('/groups', groupRouter);
v1Router.use('/study-plan', planRouter);
v1Router.use('/mock-tests', mockTestRouter);
v1Router.use('/revision', revisionRouter);
v1Router.use('/attempts', attemptsRouter);
v1Router.use('/recommendations', recommendationsRouter);
v1Router.use('/questions', questionsRouter);
