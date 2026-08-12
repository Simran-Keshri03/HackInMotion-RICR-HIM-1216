import 'dotenv/config';
import { z } from 'zod';

/**
 * Fail fast at boot if the environment is wrong.
 * A missing SUPABASE_SERVICE_ROLE_KEY should crash the process, not surface
 * as a confusing 500 on the first request.
 */
const schema = z.object({
    NODE_ENV: z
        .enum(['development', 'production', 'test'])
        .default('development'),
    PORT: z.coerce.number().default(4000),
    // Comma-separated list of origins allowed to call this API.
    CORS_ORIGINS: z.string().default('http://localhost:5173'),

    SUPABASE_URL: z.string().url(),
    SUPABASE_ANON_KEY: z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

    // Optional until Phase 11 (Claude integration).
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
    console.error(
        'Invalid environment:',
        z.flattenError(parsed.error).fieldErrors
    );
    process.exit(1);
}

export const env = {
    ...parsed.data,
    corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((o) => o.trim()),
    isProd: parsed.data.NODE_ENV === 'production',
};
