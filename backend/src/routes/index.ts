import { Router } from 'express';
import { sendOk } from '@/utils/http.js';

/** All v1 routes hang off this router. Feature routers get mounted here. */
export const v1Router = Router();

v1Router.get('/health', (_req, res) => {
    sendOk(res, { status: 'ok', uptime: Math.round(process.uptime()) });
});
