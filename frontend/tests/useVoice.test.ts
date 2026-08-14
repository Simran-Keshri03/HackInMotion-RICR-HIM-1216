import { describe, expect, it } from 'vitest';
import { toUtterances } from '@/hooks/useVoice';

/**
 * The chunking that keeps a spoken answer from stopping halfway.
 *
 * Chrome silently truncates a long utterance — no error, the voice just stops mid-explanation, which
 * is exactly what a tutor's multi-paragraph answer is. Everything else about speech is the browser's
 * job and can only be judged by listening; this function is the part that can actually be checked,
 * so it is.
 */

const LIMIT = 180;

describe('toUtterances', () => {
    it('leaves a short answer as one piece', () => {
        expect(toUtterances('Array indexes start at zero.')).toEqual([
            'Array indexes start at zero.',
        ]);
    });

    it('breaks at sentence ends, not mid-sentence', () => {
        const chunks = toUtterances(
            'Array indexes start at zero. So the last index is nine. That is why arr[10] is out of bounds.'
        );

        expect(chunks).toHaveLength(3);
        // A break heard mid-sentence sounds like a fault; every piece should end where a speaker
        // would pause anyway.
        for (const chunk of chunks) {
            expect(chunk).toMatch(/[.!?]$/);
        }
    });

    it('keeps every piece short enough for the speech engine to finish', () => {
        // A single sentence with no punctuation to break on — the case that produced the truncation.
        const long = `${'the quick brown fox jumps over the lazy dog '.repeat(30)}and stops`;

        const chunks = toUtterances(long);

        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(LIMIT);
        }
    });

    it('splits a long sentence on a word boundary rather than mid-word', () => {
        const long = `${'complexity '.repeat(40)}matters`;
        const chunks = toUtterances(long);

        expect(chunks.length).toBeGreaterThan(1);

        // The test for "no word was cut" is that putting the pieces back together with a space
        // returns the original. A split inside a word would show up as a space inside it —
        // "complex ity" — which is exactly how it would sound.
        expect(chunks.join(' ')).toBe(long.trim());

        for (const chunk of chunks) {
            expect(chunk.trim()).toBe(chunk);
        }
    });

    it('loses none of the words', () => {
        const text =
            'First point here. Second one is longer and goes on for a while about arrays and indexes. Third.';

        const rejoined = toUtterances(text).join(' ');

        expect(rejoined.replace(/\s+/g, ' ')).toBe(text);
    });

    it('collapses the paragraph breaks the tutor writes', () => {
        // Tutor answers arrive as paragraphs separated by blank lines. Newlines read aloud as
        // nothing, but they do break the sentence splitting if left in.
        const chunks = toUtterances('One idea.\n\nAnother idea.\n\tIndented third.');

        expect(chunks).toEqual(['One idea.', 'Another idea.', 'Indented third.']);
    });

    it('returns nothing for nothing, rather than an empty utterance', () => {
        // An empty utterance makes the engine fire onend immediately, which would leave the UI
        // showing "Stop" with nothing playing.
        expect(toUtterances('')).toEqual([]);
        expect(toUtterances('   \n  ')).toEqual([]);
    });
});
