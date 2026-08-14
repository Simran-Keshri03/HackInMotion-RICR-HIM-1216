import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '@/utils/http.js';

export interface GroupRow {
    id: string;
    name: string;
    invite_code: string;
    curriculum_id: string | null;
    created_by: string | null;
    created_at: string;
}

/**
 * Study groups and their membership.
 *
 * Writes need an elevated client: both tables grant learners SELECT and nothing else. That is what
 * makes the invite code mean something — a learner able to insert into `group_members` directly could
 * add themselves to any group whose id they learned, and the code would be decoration.
 *
 * The peer-progress reads below are the only place in this project where one learner's request touches
 * rows belonging to another. Each of them takes the caller's own id and refuses to run without a
 * membership check having already passed in the service. The `select` lists are deliberately short:
 * they are the privacy boundary, so a field that is not wanted on another learner's screen is not
 * fetched at all rather than fetched and dropped later.
 */
export class GroupRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    /** Groups this learner belongs to, with their role. */
    async findMyGroups(
        userId: string
    ): Promise<{ group: GroupRow; role: string; memberCount: number }[]> {
        const { data: memberships, error } = await this.db
            .from('group_members')
            .select('group_id, role')
            .eq('user_id', userId);

        if (error) throw error;

        const rows = (memberships ?? []) as { group_id: string; role: string }[];
        if (rows.length === 0) return [];

        const ids = rows.map((row) => row.group_id);

        const { data: groups, error: groupError } = await this.db
            .from('study_groups')
            .select('id, name, invite_code, curriculum_id, created_by, created_at')
            .in('id', ids);

        if (groupError) throw groupError;

        // Counted in one query for all the groups rather than one per group.
        const { data: counts, error: countError } = await this.db
            .from('group_members')
            .select('group_id')
            .in('group_id', ids);

        if (countError) throw countError;

        const size = new Map<string, number>();
        for (const row of (counts ?? []) as { group_id: string }[]) {
            size.set(row.group_id, (size.get(row.group_id) ?? 0) + 1);
        }

        const byId = new Map(((groups ?? []) as GroupRow[]).map((row) => [row.id, row]));

        return rows
            .map((row) => {
                const group = byId.get(row.group_id);
                return group
                    ? {
                          group,
                          role: row.role,
                          memberCount: size.get(row.group_id) ?? 1,
                      }
                    : null;
            })
            .filter(
                (row): row is { group: GroupRow; role: string; memberCount: number } => row !== null
            );
    }

    async findByInviteCode(code: string): Promise<GroupRow | null> {
        const { data, error } = await this.db
            .from('study_groups')
            .select('id, name, invite_code, curriculum_id, created_by, created_at')
            .eq('invite_code', code)
            .maybeSingle();

        if (error) throw error;
        return data as GroupRow | null;
    }

    async findGroup(groupId: string): Promise<GroupRow | null> {
        const { data, error } = await this.db
            .from('study_groups')
            .select('id, name, invite_code, curriculum_id, created_by, created_at')
            .eq('id', groupId)
            .maybeSingle();

        if (error) throw error;
        return data as GroupRow | null;
    }

    /**
     * Whether this learner is in this group.
     *
     * The gate in front of every peer read. Runs with the elevated client, which bypasses RLS, so
     * this check is the thing standing between a group id and somebody else's numbers — not a
     * convenience.
     */
    async isMember(groupId: string, userId: string): Promise<boolean> {
        const { data, error } = await this.db
            .from('group_members')
            .select('user_id')
            .eq('group_id', groupId)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;
        return data !== null;
    }

    async createGroup(group: {
        name: string;
        inviteCode: string;
        curriculumId: string | null;
        createdBy: string;
    }): Promise<GroupRow> {
        const { data, error } = await this.db
            .from('study_groups')
            .insert({
                name: group.name,
                invite_code: group.inviteCode,
                curriculum_id: group.curriculumId,
                created_by: group.createdBy,
            })
            .select('id, name, invite_code, curriculum_id, created_by, created_at')
            .single();

        if (error) throw error;
        return data as GroupRow;
    }

    async addMember(groupId: string, userId: string, role: 'owner' | 'member'): Promise<void> {
        const { error } = await this.db
            .from('group_members')
            .insert({ group_id: groupId, user_id: userId, role });

        if (error) {
            // 23505 is a unique violation: they are already in. Idempotent rather than an error,
            // because pasting a code twice is not a mistake worth a red banner.
            if ((error as { code?: string }).code === '23505') return;

            // Raised by the group-size trigger.
            if (String(error.message).includes('this group is full')) {
                throw new AppError(
                    409,
                    'GROUP_FULL',
                    'That group is full. Ask whoever runs it to make another one.'
                );
            }

            throw error;
        }
    }

    async removeMember(groupId: string, userId: string): Promise<void> {
        const { error } = await this.db
            .from('group_members')
            .delete()
            .eq('group_id', groupId)
            .eq('user_id', userId);

        if (error) throw error;
    }

    /** Member ids of a group, in join order. */
    async findMemberIds(groupId: string): Promise<{ userId: string; role: string }[]> {
        const { data, error } = await this.db
            .from('group_members')
            .select('user_id, role')
            .eq('group_id', groupId)
            .order('joined_at');

        if (error) throw error;

        return ((data ?? []) as { user_id: string; role: string }[]).map((row) => ({
            userId: row.user_id,
            role: row.role,
        }));
    }

    /**
     * The four shared numbers, for a set of members.
     *
     * Every `select` here is the privacy boundary in code. `learner_profiles` holds accuracy and
     * `concept_mastery` holds per-topic scores; neither is requested, because the safest way to not
     * leak a field is to never load it.
     */
    async findSharedProgress(
        userIds: string[],
        masteryBar: number
    ): Promise<
        Map<
            string,
            {
                displayName: string;
                questionsAnswered: number;
                currentStreakDays: number;
                topicsMastered: number;
            }
        >
    > {
        const result = new Map<
            string,
            {
                displayName: string;
                questionsAnswered: number;
                currentStreakDays: number;
                topicsMastered: number;
            }
        >();

        if (userIds.length === 0) return result;

        const [profiles, learnerProfiles, mastery] = await Promise.all([
            // Display name only. Not email — a group is classmates, not a contact list, and an email
            // address is the one field here somebody could be harmed by having shared.
            this.db.from('profiles').select('id, display_name').in('id', userIds),
            this.db
                .from('learner_profiles')
                .select('user_id, total_attempts, current_streak_days')
                .in('user_id', userIds),
            this.db
                .from('concept_mastery')
                .select('user_id, topic_id')
                .in('user_id', userIds)
                .gte('mastery_score', masteryBar),
        ]);

        if (profiles.error) throw profiles.error;
        if (learnerProfiles.error) throw learnerProfiles.error;
        if (mastery.error) throw mastery.error;

        const names = new Map(
            ((profiles.data ?? []) as { id: string; display_name: string | null }[]).map((row) => [
                row.id,
                row.display_name,
            ])
        );

        const stats = new Map(
            (
                (learnerProfiles.data ?? []) as {
                    user_id: string;
                    total_attempts: number;
                    current_streak_days: number;
                }[]
            ).map((row) => [row.user_id, row])
        );

        const mastered = new Map<string, number>();
        for (const row of (mastery.data ?? []) as { user_id: string }[]) {
            mastered.set(row.user_id, (mastered.get(row.user_id) ?? 0) + 1);
        }

        for (const userId of userIds) {
            const stat = stats.get(userId);

            result.set(userId, {
                // A learner who never set a name is shown as "Learner" rather than as a raw uuid,
                // which would be both ugly and an identifier worth not publishing.
                displayName: names.get(userId)?.trim() || 'Learner',
                questionsAnswered: Number(stat?.total_attempts ?? 0),
                currentStreakDays: Number(stat?.current_streak_days ?? 0),
                topicsMastered: mastered.get(userId) ?? 0,
            });
        }

        return result;
    }
}
