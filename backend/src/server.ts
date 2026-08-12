import cors from 'cors';
import express from 'express';
import { env } from '@/config/environment.js';
import { v1Router } from '@/routes/index.js';
import { errorHandler, sendError } from '@/utils/http.js';

const app = express();

app.use(cors({ origin: env.corsOrigins, credentials: true }));
// Cap body size: no endpoint here needs more, and it blocks trivial abuse.
app.use(express.json({ limit: '100kb' }));

app.use('/api/v1', v1Router);

app.use((_req, res) => {
    sendError(res, 404, 'NOT_FOUND', 'Route not found.');
});

app.use(errorHandler);

app.listen(env.PORT, () => {
    console.log(`Adigam API listening on http://localhost:${env.PORT}/api/v1`);
});
