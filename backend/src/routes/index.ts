import { Router } from 'express';
import { attemptsRouter } from '@/routes/attempts.routes.js';
import { recommendationsRouter } from '@/routes/adaptive.routes.js';
import { learnerRouter } from '@/routes/learner.routes.js';
import { questionsRouter } from '@/routes/questions.routes.js';
import { sendOk } from '@/utils/http.js';

/** All v1 routes hang off this router. Feature routers get mounted here. */
export const v1Router = Router();

v1Router.get('/health', (_req, res) => {
    sendOk(res, { status: 'ok', uptime: Math.round(process.uptime()) });
});

v1Router.use('/learner', learnerRouter);
v1Router.use('/attempts', attemptsRouter);
v1Router.use('/recommendations', recommendationsRouter);
v1Router.use('/questions', questionsRouter);
