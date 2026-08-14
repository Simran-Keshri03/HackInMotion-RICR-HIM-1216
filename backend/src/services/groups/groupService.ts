import { randomBytes } from 'node:crypto';
import type { GroupRepository, GroupRow } from '@/repositories/groupRepository.js';
import { MASTERY_BAR } from '@/services/learner/badgeEngine.js';
import {
    type GroupComparison,
    makeInviteCode,
    normaliseInviteCode,
    rankMembers,
} from '@/services/groups/groupEngine.js';
import { AppError } from '@/utils/http.js';

export interface GroupSummary {
    id: string;
    name: string;
    /** Shown so a member can pass it on. */
    inviteCode: string;
    memberCount: number;
    role: string;
    createdAt: string;
}

export interface GroupDetail extends GroupSummary {
    comparison: GroupComparison;
}

/** How many groups one learner may be in. A study group is classmates, not a subscription list. */
const MAX_GROUPS_PER_LEARNER = 10;

/** Attempts at a unique invite code before giving up. Collisions are vanishingly rare at 32^6. */
const CODE_ATTEMPTS = 5;

/**
 * Study groups.
 *
 * The one rule this service exists to enforce: **every read of another learner's numbers is preceded
 * by a membership check in this file.** The repository runs with the elevated client and therefore
 * bypasses row-level security, so `assertMember` is not a convenience — it is the only thing standing
 * between a group id and somebody else's progress. There is no code path to peer data that does not
 * go through it.
 */
export class GroupService {
    private readonly groups: GroupRepository;

    constructor(groups: GroupRepository) {
        this.groups = groups;
    }

    async listMine(userId: string): Promise<GroupSummary[]> {
        const rows = await this.groups.findMyGroups(userId);

        return rows.map(({ group, role, memberCount }) => toSummary(group, role, memberCount));
    }

    /**
     * Creates a group and puts the creator in it.
     *
     * `curriculumId` is copied from their goal so the group screen can say what everybody is
     * preparing for — comparing progress only means something between people on the same syllabus.
     */
    async create(
        userId: string,
        name: string,
        curriculumId: string | null
    ): Promise<GroupSummary> {
        const trimmed = name.trim();

        if (trimmed.length < 2) {
            throw new AppError(400, 'INVALID_INPUT', 'Give the group a name.');
        }

        await this.assertRoomForAnotherGroup(userId);

        const group = await this.createWithUniqueCode(userId, trimmed, curriculumId);
        await this.groups.addMember(group.id, userId, 'owner');

        return toSummary(group, 'owner', 1);
    }

    /**
     * Joins by code.
     *
     * A wrong code and a code for a full group are told apart, but a wrong code is never told whether
     * it *nearly* matched anything — the response is the same for any code that does not resolve, so
     * the endpoint cannot be used to probe which codes exist.
     */
    async join(userId: string, rawCode: string): Promise<GroupSummary> {
        const code = normaliseInviteCode(rawCode);

        if (code.length !== 6) {
            throw new AppError(
                400,
                'INVALID_CODE',
                'An invite code is six characters. Check it and try again.'
            );
        }

        const group = await this.groups.findByInviteCode(code);

        if (!group) {
            throw new AppError(
                404,
                'GROUP_NOT_FOUND',
                'No group with that code. Check it with whoever sent it.'
            );
        }

        if (!(await this.groups.isMember(group.id, userId))) {
            await this.assertRoomForAnotherGroup(userId);
        }

        // Idempotent in the repository, so pasting a code twice is not an error.
        await this.groups.addMember(group.id, userId, 'member');

        const members = await this.groups.findMemberIds(group.id);

        return toSummary(group, 'member', members.length);
    }

    /** A group with everybody's shared progress, ranked. */
    async detail(userId: string, groupId: string): Promise<GroupDetail> {
        const group = await this.assertMember(userId, groupId);

        const members = await this.groups.findMemberIds(groupId);
        const progress = await this.groups.findSharedProgress(
            members.map((member) => member.userId),
            MASTERY_BAR
        );

        const comparison = rankMembers(
            members.map((member) => {
                const stats = progress.get(member.userId);

                return {
                    userId: member.userId,
                    displayName: stats?.displayName ?? 'Learner',
                    questionsAnswered: stats?.questionsAnswered ?? 0,
                    currentStreakDays: stats?.currentStreakDays ?? 0,
                    topicsMastered: stats?.topicsMastered ?? 0,
                    isYou: member.userId === userId,
                };
            })
        );

        const mine = members.find((member) => member.userId === userId);

        return {
            ...toSummary(group, mine?.role ?? 'member', members.length),
            comparison,
        };
    }

    /**
     * Leaves a group.
     *
     * The last member out takes the group with them, but that is left to the cascade rather than done
     * here: an empty group is harmless, and deleting one would mean deciding what happens to a group
     * whose owner leaves while others remain. Nobody can rejoin without the code either way.
     */
    async leave(userId: string, groupId: string): Promise<void> {
        await this.assertMember(userId, groupId);
        await this.groups.removeMember(groupId, userId);
    }

    /**
     * The gate. Returns the group only if this learner is in it.
     *
     * 404 rather than 403 on purpose: telling somebody a group exists but is not theirs confirms the
     * id, which is itself a small leak and the same reasoning used for conversations.
     */
    private async assertMember(userId: string, groupId: string): Promise<GroupRow> {
        const group = await this.groups.findGroup(groupId);

        if (!group || !(await this.groups.isMember(groupId, userId))) {
            throw new AppError(404, 'GROUP_NOT_FOUND', 'That group does not exist.');
        }

        return group;
    }

    private async assertRoomForAnotherGroup(userId: string): Promise<void> {
        const mine = await this.groups.findMyGroups(userId);

        if (mine.length >= MAX_GROUPS_PER_LEARNER) {
            throw new AppError(
                409,
                'TOO_MANY_GROUPS',
                `You are already in ${MAX_GROUPS_PER_LEARNER} groups. Leave one first.`
            );
        }
    }

    /**
     * Inserts with a fresh code, retrying on the unique index rather than checking first.
     *
     * Checking availability and then inserting is a race: two learners creating a group in the same
     * moment can both see a code as free. Letting the database refuse the duplicate and trying again
     * is both shorter and actually correct.
     */
    private async createWithUniqueCode(
        userId: string,
        name: string,
        curriculumId: string | null
    ): Promise<GroupRow> {
        for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
            try {
                return await this.groups.createGroup({
                    name,
                    inviteCode: makeInviteCode((n) => randomBytes(n)),
                    curriculumId,
                    createdBy: userId,
                });
            } catch (error) {
                const duplicate = (error as { code?: string }).code === '23505';

                if (!duplicate || attempt === CODE_ATTEMPTS - 1) throw error;
            }
        }

        throw new AppError(
            500,
            'CODE_GENERATION_FAILED',
            'Could not create a group just now. Try again.'
        );
    }
}

function toSummary(group: GroupRow, role: string, memberCount: number): GroupSummary {
    return {
        id: group.id,
        name: group.name,
        inviteCode: group.invite_code,
        memberCount,
        role,
        createdAt: group.created_at,
    };
}
