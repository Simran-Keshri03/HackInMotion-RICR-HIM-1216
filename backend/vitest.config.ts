import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: { environment: 'node' },
    resolve: {
        alias: [
            // Mirrors tsconfig paths, and strips the .js extension that Node's ESM
            // resolution needs but Vitest resolves from source.
            { find: /^@\/(.*)\.js$/, replacement: path.resolve('./src') + '/$1' },
            { find: /^@\//, replacement: path.resolve('./src') + '/' },
        ],
    },
});
