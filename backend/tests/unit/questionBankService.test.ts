import { describe, expect, it, vi } from 'vitest';
import type { QuestionRepository } from '@/repositories/questionRepository.js';
import type { IAIProvider } from '@/services/ai/IAIProvider.js';
import { QuestionBankService } from '@/services/questions/questionBankService.js';

/**
 * Filling an empty topic on demand, and specifically not paying for it twice.
 *
 * Every generation here is four real AI calls in production, so the thing worth testing is not
 * that questions come out — it is how many times the model gets asked. A bug that generates twice
 * is invisible in the response and shows up only on the bill.
 *
 * Stubs stand in for the database and the model. Neither is needed to test the decision, and the
 * one behaviour that matters is a race, which a live database would make harder to provoke rather
 * than easier.
 */

/** A generation that takes a moment, so concurrent callers genuinely overlap. */
function slowProvider(delayMs = 20) {
    const generateJson = vi.fn(async (request: { system: string }) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        // The checker and the author share this stub; which one is being asked is read off the
        // system prompt, because the checker's reply has to agree for a question to be stored.
        const isChecker = /check|solve/i.test(request.system);

        return {
            data: isChecker
                ? {
                      correctOptionIndexes: [0],
                      confidence: 'high' as const,
                      unanswerable: false,
                  }
                : {
                      questions: [
                          {
                              questionType: 'mcq' as const,
                              body: 'In C, what is the index of the last element of int arr[10]?',
                              options: ['9', '10', '11', 'It depends on the compiler'],
                              correctOptionIndexes: [0],
                              explanation:
                                  'Array indexes in C start at zero, so a ten-element array runs from 0 to 9.',
                              difficulty: 'easy' as const,
                          },
                      ],
                  },
            usage: { inputTokens: 10, outputTokens: 10 },
            model: 'stub',
        };
    });

    return {
        provider: { name: 'stub', generateJson, generateText: vi.fn() } as unknown as IAIProvider,
        generateJson,
    };
}

/** A topic that starts empty and remembers what gets written to it. */
function emptyBank() {
    const stored: string[] = [];

    const repo = {
        countVerifiedForTopic: vi.fn(async () => stored.length),
        findTopicWithSubject: vi.fn(async () => ({
            name: 'Arrays',
            subjectName: 'Programming',
        })),
        findBodiesForTopic: vi.fn(async () => [...stored]),
        insertGenerated: vi.fn(async (question: { body: string }) => {
            stored.push(question.body);
            return { id: `q-${stored.length}` };
        }),
    } as unknown as QuestionRepository;

    return { repo, stored };
}

const input = {
    topicId: 'topic-1',
    difficulty: 'easy' as const,
    count: 3,
    userId: 'user-1',
};

describe('QuestionBankService.fillIfEmpty', () => {
    it('writes questions for a topic that has none', async () => {
        const { provider } = slowProvider();
        const { repo, stored } = emptyBank();

        const filled = await new QuestionBankService(provider, repo).fillIfEmpty(input);

        expect(filled).toBe(true);
        expect(stored).toHaveLength(1);
    });

    /**
     * The regression this exists for.
     *
     * The first version checked the database for existing questions before claiming the topic.
     * Three simultaneous requests each read zero, each saw no claim, and each generated: three
     * generations, three bills, for one topic. Verified against the real service, which wrote
     * eight questions where it should have written three.
     *
     * Note what is asserted — the number of times the model was asked, not the number of questions.
     * Duplicate generations are invisible in the response, so only the call count catches this.
     */
    it('generates once when several requests arrive together', async () => {
        const { provider, generateJson } = slowProvider();
        const { repo } = emptyBank();
        const service = new QuestionBankService(provider, repo);

        const results = await Promise.all([
            service.fillIfEmpty(input),
            service.fillIfEmpty(input),
            service.fillIfEmpty(input),
        ]);

        // Everybody is told the topic is ready, not just the request that did the work.
        expect(results).toEqual([true, true, true]);

        // One authoring call plus one answer check for the question it produced.
        expect(generateJson).toHaveBeenCalledTimes(2);
    });

    it('does not generate for a topic that already has questions', async () => {
        const { provider, generateJson } = slowProvider();
        const { repo } = emptyBank();
        repo.countVerifiedForTopic = vi.fn(async () => 12);

        const filled = await new QuestionBankService(provider, repo).fillIfEmpty(input);

        expect(filled).toBe(true);
        expect(generateJson).not.toHaveBeenCalled();
    });

    /**
     * A model outage must not become an error on the practice screen. The learner sees the same
     * "nothing here yet" they saw before, which is true, and the recommendation endpoint stays a
     * read that always answers.
     */
    it('reports failure quietly when the model is unavailable', async () => {
        const { repo } = emptyBank();
        const provider = {
            name: 'broken',
            generateJson: vi.fn(async () => {
                throw new Error('AI is unavailable');
            }),
            generateText: vi.fn(),
        } as unknown as IAIProvider;

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(new QuestionBankService(provider, repo).fillIfEmpty(input)).resolves.toBe(
            false
        );

        warn.mockRestore();
    });

    /** A failed attempt must release the claim, or the topic is stuck empty until a restart. */
    it('lets a later request try again after a failure', async () => {
        const { repo } = emptyBank();
        let attempts = 0;

        const generateJson = vi.fn(async () => {
            attempts += 1;
            throw new Error('AI is unavailable');
        });

        const service = new QuestionBankService(
            { name: 'broken', generateJson, generateText: vi.fn() } as unknown as IAIProvider,
            repo
        );

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await service.fillIfEmpty(input);
        await service.fillIfEmpty(input);

        expect(attempts).toBe(2);
        warn.mockRestore();
    });
});
