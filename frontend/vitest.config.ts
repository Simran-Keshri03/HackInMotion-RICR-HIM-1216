import { defineConfig } from 'vitest/config';

/**
 * Tests for the frontend's pure logic only.
 *
 * `environment: 'node'` on purpose: there is no jsdom and nothing here needs one. What is worth
 * testing on this side is the plain functions — text chunking for speech, date arithmetic — not
 * React rendering, which a browser check covers better than a simulated DOM would.
 */
export default defineConfig({
    test: { environment: 'node', include: ['tests/**/*.test.ts'] },
    resolve: {
        alias: { '@': new URL('./src/', import.meta.url).pathname },
    },
});
