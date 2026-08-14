import 'dotenv/config';
import { z } from 'zod';

/**
 * Fail fast at boot if the environment is wrong.
 * A missing SUPABASE_SECRET_KEY should crash the process, not surface
 * as a confusing 500 on the first request.
 */
const schema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(4000),
    // Comma-separated list of origins allowed to call this API.
    CORS_ORIGINS: z.string().default('http://localhost:5173'),

    SUPABASE_URL: z.string().url(),
    SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    SUPABASE_SECRET_KEY: z.string().min(1),

    // Optional until Phase 11 (Claude integration).
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
});

// A variable written as `KEY=` in .env arrives as an empty string, not as missing, and
// an empty string is never a valid value for anything here. Dropping the blanks lets
// optional variables stay genuinely optional and turns a blank required one into a plain
// "required" error instead of a confusing length complaint.
const presentEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== '')
);

const parsed = schema.safeParse(presentEnv);

if (!parsed.success) {
    console.error('Invalid environment:', z.flattenError(parsed.error).fieldErrors);
    process.exit(1);
}

export const env = {
    ...parsed.data,
    corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((o) => o.trim()),
    isProd: parsed.data.NODE_ENV === 'production',
};
