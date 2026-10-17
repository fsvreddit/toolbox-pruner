import { context, reddit, redis, scheduler } from "@devvit/web/server";
import { UiResponse } from "@devvit/web/shared";
import type { Context } from "hono";
import { pruneNotes, PruneOptions, PruneStage, RedisKey, SchedulerJob, TimePeriod } from "../core";
import { addHours } from "date-fns";
import { decompressBlob, LATEST_KNOWN_USERNOTES_SCHEMA, ToolboxClient } from "toolbox-devvit";
import pluralize from "pluralize";

interface PruneFormData {
    pruneDeletedUsers: boolean;
    pruneNotesOlderThan: boolean;
    pruneNotesOlderThanPeriod: TimePeriod[];
    pruneInactiveUsers: boolean;
    pruneInactivePeriod: TimePeriod[];
}

export const handlePruneToolboxNotesForm = async (c: Context): Promise<Response> => {
    const data = await c.req.json<PruneFormData>();

    const pruneOptions: PruneOptions = {
        pruneDeletedUsers: data.pruneDeletedUsers,
        pruneNotesOlderThan: data.pruneNotesOlderThan,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        pruneNotesOlderThanPeriod: data.pruneNotesOlderThanPeriod[0]!,
        pruneInactiveUsers: data.pruneInactiveUsers,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        pruneInactivePeriod: data.pruneInactivePeriod[0]!,
    };

    await redis.set(RedisKey.PruneStage, PruneStage.Stage1StoringUserList, { expiration: addHours(new Date(), 6) });

    const toolbox = new ToolboxClient(reddit);
    const subredditName = context.subredditName;
    const allUserNotes = await toolbox.getUsernotes(subredditName).then(notes => notes.toJSON());

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (allUserNotes.ver !== LATEST_KNOWN_USERNOTES_SCHEMA) {
        // Unlikely, but possible if Toolbox has updated their schema since this app was last updated.
        await redis.del(RedisKey.PruneStage);
        return c.json<UiResponse>({
            showToast: "Cannot proceed: Unsupported Toolbox usernotes format. Please notify the app developer.",
        });
    }

    const rawNotes = decompressBlob(allUserNotes.blob);
    const distinctUsers = Object.keys(rawNotes);

    if (distinctUsers.length === 0) {
        await redis.del(RedisKey.PruneStage);
        return c.json<UiResponse>({
            showToast: "The Toolbox user notes page contains no notes. Nothing to do.",
        });
    }

    // Delete previous app keys just in case.
    await redis.del(RedisKey.PrunableUsers, RedisKey.UserCheckQueue, RedisKey.UsersChecked, RedisKey.UserCheckTotalCount, RedisKey.RevisionAfterPrune);

    if (!pruneOptions.pruneDeletedUsers && !pruneOptions.pruneInactiveUsers) {
        // Can skip straight to pruning notes.
        await pruneNotes(pruneOptions);
        return c.json<UiResponse>({
            showToast: "Pruning notes has been completed - see modmail for results.",
        });
    }

    await redis.zAdd(RedisKey.UserCheckQueue, ...distinctUsers.map(user => ({ member: user, score: 0 })));
    await redis.set(RedisKey.UserCheckTotalCount, JSON.stringify(distinctUsers.length));

    await redis.set(RedisKey.PruneStage, PruneStage.Stage2CheckingUsers, { expiration: addHours(new Date(), 6) });
    await redis.set(RedisKey.PruneOptions, JSON.stringify(pruneOptions));
    await redis.set(RedisKey.PruneStarted, new Date().getTime().toString());

    await scheduler.runJob({
        name: SchedulerJob.CheckUserBatch,
        data: { ...pruneOptions, jobGuid: crypto.randomUUID() },
        runAt: new Date(),
    });

    await scheduler.runJob({
        name: SchedulerJob.CheckUserBatchRecovery,
        cron: "*/5 * * * *",
    });

    return c.json<UiResponse>({
        showToast: `Queued ${distinctUsers.length} ${pluralize("user", distinctUsers.length)} for processing. Press the option again in a while to get an ETA.`,
    });
};
