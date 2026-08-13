import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Every VITE_ variable the app cannot run without.
 *
 * These are checked at build time because of a failure mode that is otherwise invisible. Vite
 * replaces `import.meta.env.VITE_X` with a literal at build time, so when a variable is missing it
 * becomes `undefined` — and the guard in lib/supabase.ts turns into an unconditional throw. Rollup
 * then sees everything after it as unreachable and tree-shakes the auth client away entirely.
 *
 * The result is a build that succeeds, weighs 25 kB less, and white-screens on load. Measured on
 * this project: 98 kB gzip with the variables present, 73 kB without, both reported as a clean
 * build. On a host, forgetting one variable would go green and ship a dead site.
 *
 * So: fail here, loudly, naming what is missing.
 */
const REQUIRED_ENV = [
    'VITE_API_URL',
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_PUBLISHABLE_KEY',
] as const;

export default defineConfig(({ mode, command }) => {
    // loadEnv reads .env files the same way Vite itself does, and process.env covers a host that
    // injects variables directly rather than through a file.
    const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };

    const missing = REQUIRED_ENV.filter((key) => !env[key]);

    // Only on build: `vite dev` should still start so a developer can be told what to set by the
    // app's own error message rather than by a failed command.
    if (command === 'build' && missing.length > 0) {
        throw new Error(
            `Cannot build without: ${missing.join(', ')}.\n` +
                'These are compiled into the bundle, so a missing one produces a build that ' +
                'succeeds and then fails to start. Set them in the host dashboard, or copy ' +
                '.env.example to .env for a local build.'
        );
    }

    return {
        plugins: [react()],
        resolve: {
            alias: { '@': path.resolve(__dirname, './src') },
        },
    };
});
