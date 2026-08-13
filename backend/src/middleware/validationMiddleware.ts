import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '@/utils/http.js';

/**
 * Checks a request body against a schema before any controller sees it.
 *
 * Validation lives at the edge so services can trust their inputs, and so a bad request
 * produces one clear 400 instead of a confusing failure three layers down.
 */
export function validateBody<T>(schema: ZodType<T>) {
    return (req: Request, _res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.body);

        if (!result.success) {
            const first = result.error.issues[0];
            const where = first?.path.join('.');

            next(
                new AppError(
                    400,
                    'INVALID_INPUT',
                    where
                        ? `${where}: ${first?.message}`
                        : (first?.message ?? 'Invalid request body.')
                )
            );
            return;
        }

        // Replaced with the parsed value, so defaults and coercions reach the controller.
        req.body = result.data;
        next();
    };
}
