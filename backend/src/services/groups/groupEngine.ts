/**
 * What a study group is allowed to say about its members, and in what order.
 *
 * The interesting decision here is not the ranking — it is the shape of `SharedProgress`. That type
 * is the privacy boundary of the whole feature: it is the complete list of what one learner can learn
 * about another, and it is a type rather than a convention so that adding a field is a visible change
 * to a file called groupEngine rather than an extra column slipped into a query.
 *
 * What is shared: name, questions answered, current streak, topics mastered.
 * What is not: accuracy, weakest topics, wrong answers, per-topic mastery, tutor conversations,
 * goals, plans.
 *
 * The cut is between *effort and achievement* on one side and *weakness* on the other. A leaderboard
 * of how much people have done is motivating. Publishing which topics somebody is worst at, to their
 * classmates, is a reason to stop using the app — and it would make the honest answer to "should I
 * practise my weak topics" become "not while my friends can see". LeetCode makes the same cut: it
 * shows how many problems you solved and never how many you got wrong.
 *
 * Pure, so the ranking is testable and the boundary is visible in one place.
 */

/** Everything one group member may know about another. The privacy boundary, as a type. */
export interface SharedProgress {
    userId: string;
    displayName: string;
    /** Lifetime questions answered. Effort, not correctness. */
    questionsAnswered: number;
    currentStreakDays: number;
    topicsMastered: number;
    /** True for the learner reading the screen, so the client can mark their own row. */
    isYou: boolean;
}

export interface RankedMember extends SharedProgress {
    /** 1-based. Ties share a rank, so two learners on 40 questions are both 3rd. */
    rank: number;
}

export interface GroupComparison {
    members: RankedMember[];
    /** Where the reader sits, for the "you are 3rd of 6" line. */
    yourRank: number | null;
    memberCount: number;
    /** Group totals — the part that makes it collaborative rather than only competitive. */
    totals: { questionsAnswered: number; topicsMastered: number };
    /** The longest current streak in the group, and who holds it. */
    topStreak: { displayName: string; days: number } | null;
}

/**
 * Ranks a group by questions answered.
 *
 * Effort rather than accuracy, deliberately. Ranking on accuracy would reward answering only easy
 * questions and punish the learner working through the topic they find hardest — the exact behaviour
 * the rest of the app is built to encourage.
 *
 * Ties share a rank. Inventing an order between two learners on identical numbers would be arbitrary
 * and, on a screen people compare themselves on, unkind for no reason.
 */
export function rankMembers(members: SharedProgress[]): GroupComparison {
    const sorted = [...members].sort(
        (a, b) =>
            b.questionsAnswered - a.questionsAnswered ||
            b.topicsMastered - a.topicsMastered ||
            b.currentStreakDays - a.currentStreakDays ||
            // Final tiebreak on name so the order is stable between reads rather than depending on
            // whatever order the database returned.
            a.displayName.localeCompare(b.displayName)
    );

    const ranked: RankedMember[] = [];
    let lastScore: number | null = null;
    let lastRank = 0;

    for (const [index, member] of sorted.entries()) {
        const rank =
            lastScore !== null && member.questionsAnswered === lastScore ? lastRank : index + 1;

        ranked.push({ ...member, rank });
        lastScore = member.questionsAnswered;
        lastRank = rank;
    }

    const you = ranked.find((member) => member.isYou) ?? null;

    const withStreak = [...ranked]
        .filter((member) => member.currentStreakDays > 0)
        .sort((a, b) => b.currentStreakDays - a.currentStreakDays);

    return {
        members: ranked,
        yourRank: you?.rank ?? null,
        memberCount: ranked.length,
        totals: {
            questionsAnswered: ranked.reduce((sum, member) => sum + member.questionsAnswered, 0),
            topicsMastered: ranked.reduce((sum, member) => sum + member.topicsMastered, 0),
        },
        topStreak: withStreak[0]
            ? {
                  displayName: withStreak[0].displayName,
                  days: withStreak[0].currentStreakDays,
              }
            : null,
    };
}

/**
 * Alphabet for invite codes.
 *
 * No O, 0, I, 1 or L. These codes get read aloud across a room and copied off a screen, and an
 * ambiguous character means a learner who cannot join and has no idea why. 32 symbols over 6
 * characters is about a billion codes, which with a unique index is plenty.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 6;

/**
 * Generates an invite code.
 *
 * `randomBytes` is passed in rather than imported so this stays pure and the test can feed it a
 * known sequence. Uses rejection sampling — taking `byte % 31` would make the first symbols of the
 * alphabet slightly likelier, which is a small bias but a free one to avoid.
 */
export function makeInviteCode(randomBytes: (n: number) => Uint8Array): string {
    const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
    let code = '';

    while (code.length < INVITE_CODE_LENGTH) {
        // Ask for more than needed so a run of rejected bytes rarely needs a second call.
        for (const byte of randomBytes(INVITE_CODE_LENGTH * 2)) {
            if (byte >= limit) continue;

            code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
            if (code.length === INVITE_CODE_LENGTH) break;
        }
    }

    return code;
}

/** Tidies a typed code: people type lower case and paste spaces. */
export function normaliseInviteCode(input: string): string {
    return input.trim().toUpperCase().replace(/\s+/g, '');
}
