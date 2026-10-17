import { context, reddit, redis, scheduler, User } from "@devvit/web/server";
import { compressBlob, decompressBlob, RawUsernotesUsers, ToolboxClient } from "toolbox-devvit";
import pluralize from "pluralize";
import { addHours, addMinutes, addSeconds, subMonths, subYears } from "date-fns";
import { cancelExistingJobs, MAX_WIKI_PAGE_SIZE, RedisKey, SchedulerJob } from ".";
import json2md from "json2md";
import { chunk } from "lodash";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { TaskRequest } from "@devvit/web/server";

export enum PruneStage {
    Stage1StoringUserList = "storingUserList",
    Stage2CheckingUsers = "checkingUsers",
    Stage3RemovingRedundantEntries = "removingRedundantEntries",
}

export enum TimePeriod {
    SixMonths = "6 Months",
    OneYear = "1 Year",
    TwoYears = "2 Years",
    ThreeYears = "3 Years",
    FourYears = "4 Years",
}

export enum PruneOption {
    PruneNotesOlderThan = "pruneNotesOlderThan",
    PruneNotesOlderThanPeriod = "pruneNotesOlderThanPeriod",
    PruneDeletedUsers = "pruneDeletedUsers",
    PruneInactiveUsers = "pruneInactiveUsers",
    PruneInactivePeriod = "pruneInactivePeriod",
}

export type PruneOptions = {
    pruneNotesOlderThan: boolean;
    pruneNotesOlderThanPeriod: TimePeriod;
    pruneDeletedUsers: boolean;
    pruneInactiveUsers: boolean;
    pruneInactivePeriod: TimePeriod;
    jobGuid?: string;
};

export function timePeriodToTimeStamp (period: TimePeriod): Date {
    switch (period) {
        case TimePeriod.SixMonths:
            return subMonths(new Date(), 6);
        case TimePeriod.OneYear:
            return subYears(new Date(), 1);
        case TimePeriod.TwoYears:
            return subYears(new Date(), 2);
        case TimePeriod.ThreeYears:
            return subYears(new Date(), 3);
        case TimePeriod.FourYears:
            return subYears(new Date(), 4);
    }
}

export async function checkUserBatch (event: TaskRequest<PruneOptions | undefined>) {
    const pruneOptions = event.data;
    if (!pruneOptions) {
        throw new Error("No prune options provided to checkUserBatch job.");
    }

    if (pruneOptions.jobGuid && await hasEventBeenHandled(`job:${pruneOptions.jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`checkUserBatch job with guid ${pruneOptions.jobGuid} has already been handled. Skipping.`);
        return;
    }

    if (!pruneOptions.pruneDeletedUsers && !pruneOptions.pruneInactiveUsers) {
        // It should be impossible to get here, but just in case.
        console.warn("checkUserBatch called with no user prune options enabled. Skipping to pruneNotes.");
        await pruneNotes(pruneOptions);
        return;
    }

    await redis.set(RedisKey.UserBatchLastRun, new Date().getTime().toString(), { expiration: addMinutes(new Date(), 2) });
    const runLimit = addSeconds(new Date(), 15);

    console.log("Processing batch of users");

    const batchSize = 50;

    const userQueue = await redis.zRange(RedisKey.UserCheckQueue, 0, batchSize - 1).then(items => items.map(item => item.member));

    if (userQueue.length === 0) {
        // Finished processing users. Now actually prune notes!
        await pruneNotes(pruneOptions);
        return;
    }

    const prunableUsers: string[] = [];
    const usersChecked: string[] = [];

    const chunks = chunk(userQueue, 5);

    while (chunks.length > 0 && new Date() < runLimit) {
        const chunk = chunks.shift();
        if (!chunk) {
            break;
        }

        await Promise.all(chunk.map(async (username) => {
            let isPrunable = false;
            if (pruneOptions.pruneDeletedUsers) {
                let user: User | undefined;
                try {
                    user = await reddit.getUserByUsername(username);
                } catch {
                // Error retrieving user
                }

                if (!user) {
                    console.log(`User ${username} appears to be deleted, suspended or shadowbanned.`);
                    isPrunable = true;
                }
            }

            if (!isPrunable && pruneOptions.pruneInactiveUsers) {
                try {
                    const userHistory = await reddit.getCommentsAndPostsByUser({
                        username,
                        limit: 10,
                        sort: "new",
                    }).all().then(items => items.filter(item => !item.stickied));

                    isPrunable = userHistory.length > 0 && !userHistory.some(item => item.createdAt >= timePeriodToTimeStamp(pruneOptions.pruneInactivePeriod));
                    if (isPrunable) {
                        console.log(`User ${username} has no recent history.`);
                    }
                } catch {
                    console.log(`Error retrieving history for user ${username}, assuming prunable.`);
                    isPrunable = true;
                }
            }

            if (isPrunable) {
                prunableUsers.push(username);
            }
            usersChecked.push(username);
        }));
    }

    console.log(`${prunableUsers.length} out of ${usersChecked.length} are prunable in this batch.`);
    if (prunableUsers.length > 0) {
        await redis.zAdd(RedisKey.PrunableUsers, ...prunableUsers.map(user => ({ member: user, score: 0 })));
    }

    await redis.zRem(RedisKey.UserCheckQueue, usersChecked);
    await redis.incrBy(RedisKey.UsersChecked, usersChecked.length);

    await scheduler.runJob<PruneOptions>({
        name: SchedulerJob.CheckUserBatch,
        data: { ...pruneOptions, jobGuid: crypto.randomUUID() },
        runAt: addSeconds(new Date(), 1),
    });
}

export async function checkUserBatchRecovery () {
    if (await redis.exists(RedisKey.UserBatchLastRun)) {
        // Last run was recent enough, no need to recover.
        return;
    }

    if (!await redis.exists(RedisKey.PruneStage)) {
        // Prune is not in progress, nothing to recover. Cancel this recovery job.
        await cancelExistingJobs(SchedulerJob.CheckUserBatchRecovery);
        return;
    }

    // Last run was too long ago, and prune is in progress. Restart the checkUserBatch job.
    const pruneOptionsStr = await redis.get(RedisKey.PruneOptions);
    if (!pruneOptionsStr) {
        console.error("Prune options not found in Redis. Cannot recover checkUserBatch job.");
        return;
    }

    const pruneOptions = JSON.parse(pruneOptionsStr) as PruneOptions;

    console.log("Recovering checkUserBatch job.");
    await scheduler.runJob<PruneOptions>({
        name: SchedulerJob.CheckUserBatch,
        data: { ...pruneOptions, jobGuid: crypto.randomUUID() },
        runAt: new Date(),
    });
}

export async function pruneNotes (options: PruneOptions) {
    console.log("Finished user check. Pruning notes.");

    await redis.set(RedisKey.PruneStage, PruneStage.Stage3RemovingRedundantEntries, { expiration: addHours(new Date(), 6) });

    const prunableUsers = (await redis.zRange(RedisKey.PrunableUsers, 0, -1)).map(item => item.member);
    const message: json2md.DataObject[] = [];

    const subredditName = context.subredditName;

    if (prunableUsers.length > 0 || options.pruneNotesOlderThan) {
        console.log(`Pruning notes for ${prunableUsers.length} users. Prune old notes: ${options.pruneNotesOlderThan}.`);
        const toolbox = new ToolboxClient(reddit);
        const allUserNotes = await toolbox.getUsernotes(subredditName);
        const rawNotes = decompressBlob(allUserNotes.toJSON().blob);
        const allUsers = Object.keys(rawNotes);

        const usersToKeep = Object.keys(rawNotes).filter(username => !prunableUsers.includes(username));
        const newRawNotes: RawUsernotesUsers = {};
        let notesPrunedCount = 0;

        const cutoffEpochSeconds = options.pruneNotesOlderThan ? timePeriodToTimeStamp(options.pruneNotesOlderThanPeriod).getTime() / 1000 : undefined;

        for (const user of allUsers) {
            if (usersToKeep.includes(user)) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const notes = rawNotes[user]!;
                if (cutoffEpochSeconds) {
                    notes.ns = [...notes.ns.filter(note => note.t >= cutoffEpochSeconds)];
                }
                if (notes.ns.length > 0) {
                    newRawNotes[user] = notes;
                }

                if (newRawNotes[user]) {
                    notesPrunedCount += (notes.ns.length - newRawNotes[user].ns.length);
                } else {
                    notesPrunedCount += notes.ns.length;
                }
            } else {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                notesPrunedCount += rawNotes[user]!.ns.length;
            }
        }

        const compressedBlob = compressBlob(newRawNotes).toString();

        const wikiPage = await reddit.getWikiPage(subredditName, "usernotes");
        await redis.set(RedisKey.NotesBackup, wikiPage.content);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const wikiContent = JSON.parse(wikiPage.content);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        wikiContent.blob = compressedBlob;

        const newPageContent = JSON.stringify(wikiContent);

        const newPage = await reddit.updateWikiPage({
            subredditName,
            page: "usernotes",
            content: newPageContent,
            reason: `Pruned ${notesPrunedCount} ${pluralize("note", notesPrunedCount)}`,
        });

        await redis.set(RedisKey.RevisionAfterPrune, newPage.revisionId);

        const freeSpace = Math.round(100 * ((MAX_WIKI_PAGE_SIZE - newPageContent.length) / MAX_WIKI_PAGE_SIZE));
        message.push({ p: `Toolbox notes prune has now completed. ${notesPrunedCount.toLocaleString()} notes ${pluralize("has", notesPrunedCount)} been removed.` });
        message.push({ p: `You now have ${freeSpace}% free space on the Toolbox wiki page.` });
        message.push({ p: "Options chosen:" });
        const bullets: string[] = [];
        if (options.pruneDeletedUsers) {
            bullets.push("Pruned notes for suspended, deleted or shadowbanned users");
        }
        if (options.pruneInactiveUsers) {
            bullets.push(`Pruned notes for users inactive for ${options.pruneInactivePeriod}`);
        }
        if (options.pruneNotesOlderThan) {
            bullets.push(`Pruned notes older than ${options.pruneNotesOlderThanPeriod}`);
        }
        message.push({ ul: bullets });
    } else {
        console.log("Nothing to do!");
        message.push({ p: "Toolbox notes prune has now completed. There were no notes that needed pruning, so no changes were made." });
    }

    await reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: "Toolbox Notes Prune has been completed.",
        bodyMarkdown: json2md(message),
    });

    await redis.del(RedisKey.PruneStage, RedisKey.PrunableUsers, RedisKey.UserCheckQueue, RedisKey.UsersChecked);
    await redis.del(RedisKey.UserCheckTotalCount, RedisKey.PruneStarted, RedisKey.PruneOptions, RedisKey.UserBatchLastRun);

    await cancelExistingJobs(SchedulerJob.CheckUserBatchRecovery);

    console.log("Notes have been pruned!");
}
