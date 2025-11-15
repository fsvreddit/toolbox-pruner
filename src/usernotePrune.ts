import { Context, FormFunction, FormOnSubmitEvent, JobContext, JSONObject, MenuItemOnPressEvent, ScheduledJobEvent, TriggerContext, User, WikiPage } from "@devvit/public-api";
import { confirmationForm, restoreForm } from "./main.js";
import { compressBlob, decompressBlob, LATEST_KNOWN_USERNOTES_SCHEMA, RawUsernotesUsers, ToolboxClient } from "toolbox-devvit";
import pluralize from "pluralize";
import { addHours, addMilliseconds, addMinutes, addSeconds, differenceInMilliseconds, differenceInMinutes, formatDuration, intervalToDuration, subMonths, subYears } from "date-fns";
import { MAX_WIKI_PAGE_SIZE, RedisKey, SchedulerJob } from "./constants.js";
import { cancelExistingJobs, hasPermissions } from "devvit-helpers";
import json2md from "json2md";
import { chunk } from "lodash";

enum PruneStage {
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

enum PruneOption {
    PruneNotesOlderThan = "pruneNotesOlderThan",
    PruneNotesOlderThanPeriod = "pruneNotesOlderThanPeriod",
    PruneDeletedUsers = "pruneDeletedUsers",
    PruneInactiveUsers = "pruneInactiveUsers",
    PruneInactivePeriod = "pruneInactivePeriod",
}

interface PruneOptions {
    pruneNotesOlderThan: boolean;
    pruneNotesOlderThanPeriod: TimePeriod;
    pruneDeletedUsers: boolean;
    pruneInactiveUsers: boolean;
    pruneInactivePeriod: TimePeriod;
}

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

export const pruneForm: FormFunction = data => ({
    title: "Toolbox Usernotes Prune",
    description: data.description as string,
    fields: [
        {
            type: "boolean",
            name: PruneOption.PruneDeletedUsers,
            label: "Prune notes for suspended, deleted or shadowbanned users (slow!)",
            defaultValue: true,
        },
        {
            type: "group",
            label: "Prune old notes options",
            fields: [
                {
                    type: "boolean",
                    name: PruneOption.PruneNotesOlderThan,
                    label: "Prune notes older than a specific period (fast!)",
                    defaultValue: false,
                },
                {
                    type: "select",
                    name: PruneOption.PruneNotesOlderThanPeriod,
                    label: "Select time period",
                    options: Object.values(TimePeriod).map(period => ({ label: period, value: period })),
                    defaultValue: [TimePeriod.SixMonths],
                    multiSelect: false,
                    required: true,
                },
            ],
        },
        {
            type: "group",
            label: "Prune inactive users options",
            fields: [
                {
                    type: "boolean",
                    name: PruneOption.PruneInactiveUsers,
                    label: "Prune notes for users inactive for a specific period (slow!)",
                    helpText: "Users with no history at all will be ignored, as this may indicate a profile curator.",
                    defaultValue: false,
                },
                {
                    type: "select",
                    name: PruneOption.PruneInactivePeriod,
                    label: "Select time period",
                    options: Object.values(TimePeriod).map(period => ({ label: period, value: period })),
                    defaultValue: [TimePeriod.SixMonths],
                    multiSelect: false,
                    required: true,
                },
            ],
        },
    ],
});

export async function pruneMenuHandler (_: MenuItemOnPressEvent, context: Context) {
    const currentStage = await context.redis.get(RedisKey.PruneStage);
    if (currentStage) {
        await showCurrentProgress(context);
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, "usernotes");
    } catch {
        // TODO: Check to see if app has Wiki permissions. Do different errors based on the result.
        const appHasAccess = await hasPermissions(context.reddit, { username: context.appName, subredditName, requiredPerms: "wiki" });
        if (appHasAccess) {
            context.ui.showToast("Cannot retrieve Toolbox Usernotes wiki page. This app only works on subreddits that use Toolbox usernotes.");
        } else {
            context.ui.showToast("/u/toolbox-pruner needs access to the wiki to continue.");
        }

        return;
    }

    const freeSpace = Math.round(100 * ((MAX_WIKI_PAGE_SIZE - wikiPage.content.length) / MAX_WIKI_PAGE_SIZE));

    context.ui.showForm(confirmationForm, {
        description: `You have ${freeSpace}% free on the Toolbox wiki page. Do you want to continue?`,
    });
}

export async function showCurrentProgress (context: Context) {
    const usersProcessedStr = await context.redis.get(RedisKey.UsersChecked);
    const totalUsersStr = await context.redis.get(RedisKey.UserCheckTotalCount);
    const pruneStartedStr = await context.redis.get(RedisKey.PruneStarted);

    if (!usersProcessedStr || !totalUsersStr || !pruneStartedStr) {
        // This should be impossible.
        context.ui.showToast("Prune is in progress.");
        return;
    }

    const usersProcessed = parseInt(usersProcessedStr);
    const totalUsers = parseInt(totalUsersStr);
    const pruneStarted = new Date(parseInt(pruneStartedStr));

    if (totalUsers === 0) {
        context.ui.showToast("Prune will finish imminently.");
        return;
    }

    const percentCompleted = Math.round(100 * (usersProcessed / totalUsers));

    // Prevent division by zero if usersProcessed >= totalUsers
    const elapsedMillis = differenceInMilliseconds(new Date(), pruneStarted);
    const estimatedFinishMillis = (usersProcessed > 0)
        ? (elapsedMillis / usersProcessed) * (totalUsers - usersProcessed)
        : 0;

    if (usersProcessed >= totalUsers) {
        context.ui.showToast("Prune is complete or finishing up.");
        return;
    }

    const estimatedFinish = addMilliseconds(new Date(), estimatedFinishMillis);

    let eta: string;
    if (differenceInMinutes(estimatedFinish, new Date()) < 2) {
        eta = "about one minute";
    } else {
        eta = formatDuration(intervalToDuration({ start: new Date(), end: estimatedFinish }), { format: ["hours", "minutes"] });
    }

    context.ui.showToast(`Prune is in progress, ${eta} remaining. Analyzed ${percentCompleted}%  of users.`);
}

export async function confirmationFormHandler (event: FormOnSubmitEvent<JSONObject>, context: Context) {
    const pruneNotesOlderThanPeriod = event.values[PruneOption.PruneNotesOlderThanPeriod] as TimePeriod[];
    const pruneInactivePeriod = event.values[PruneOption.PruneInactivePeriod] as TimePeriod[];

    const pruneOptions: PruneOptions = {
        pruneDeletedUsers: event.values[PruneOption.PruneDeletedUsers] as boolean,
        pruneNotesOlderThan: event.values[PruneOption.PruneNotesOlderThan] as boolean,
        pruneNotesOlderThanPeriod: pruneNotesOlderThanPeriod[0],
        pruneInactiveUsers: event.values[PruneOption.PruneInactiveUsers] as boolean,
        pruneInactivePeriod: pruneInactivePeriod[0],
    };

    await context.redis.set(RedisKey.PruneStage, PruneStage.Stage1StoringUserList, { expiration: addHours(new Date(), 6) });

    const toolbox = new ToolboxClient(context.reddit);
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const allUserNotes = await toolbox.getUsernotes(subredditName).then(notes => notes.toJSON());

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (allUserNotes.ver !== LATEST_KNOWN_USERNOTES_SCHEMA) {
        // Unlikely, but possible if Toolbox has updated their schema since this app was last updated.
        context.ui.showToast("Cannot proceed: Unsupported Toolbox usernotes format. Please notify the app developer.");
        await context.redis.del(RedisKey.PruneStage);
        return;
    }

    const rawNotes = decompressBlob(allUserNotes.blob);
    const distinctUsers = Object.keys(rawNotes);

    if (distinctUsers.length === 0) {
        context.ui.showToast("The Toolbox user notes page contains no notes. Nothing to do.");
        await context.redis.del(RedisKey.PruneStage);
        return;
    }

    // Delete previous app keys just in case.
    await context.redis.del(RedisKey.PrunableUsers);
    await context.redis.del(RedisKey.UserCheckQueue);
    await context.redis.del(RedisKey.UsersChecked);
    await context.redis.del(RedisKey.UserCheckTotalCount);
    await context.redis.del(RedisKey.RevisionAfterPrune);

    if (!pruneOptions.pruneDeletedUsers && !pruneOptions.pruneInactiveUsers) {
        // Can skip straight to pruning notes.
        await pruneNotes(pruneOptions, context);
        return;
    }

    await context.redis.zAdd(RedisKey.UserCheckQueue, ...distinctUsers.map(user => ({ member: user, score: 0 })));
    await context.redis.set(RedisKey.UserCheckTotalCount, JSON.stringify(distinctUsers.length));

    context.ui.showToast(`Queued ${distinctUsers.length} ${pluralize("user", distinctUsers.length)} for processing. Press the option again in a while to get an ETA.`);

    await context.redis.set(RedisKey.PruneStage, PruneStage.Stage2CheckingUsers, { expiration: addHours(new Date(), 6) });
    await context.redis.set(RedisKey.PruneOptions, JSON.stringify(pruneOptions));
    await context.redis.set(RedisKey.PruneStarted, new Date().getTime().toString());

    await context.scheduler.runJob({
        name: SchedulerJob.CheckUserBatch,
        data: { ...pruneOptions },
        runAt: new Date(),
    });

    await context.scheduler.runJob({
        name: SchedulerJob.CheckUserBatchRecovery,
        cron: "*/5 * * * *",
    });
}

export async function checkUserBatch (event: ScheduledJobEvent<JSONObject | undefined>, context: TriggerContext) {
    const pruneOptions = event.data as PruneOptions | undefined;
    if (!pruneOptions) {
        throw new Error("No prune options provided to checkUserBatch job.");
    }

    if (!pruneOptions.pruneDeletedUsers && !pruneOptions.pruneInactiveUsers) {
        // It should be impossible to get here, but just in case.
        console.warn("checkUserBatch called with no user prune options enabled. Skipping to pruneNotes.");
        await pruneNotes(pruneOptions, context);
        return;
    }

    await context.redis.set(RedisKey.UserBatchLastRun, new Date().getTime().toString(), { expiration: addMinutes(new Date(), 2) });
    const runLimit = addSeconds(new Date(), 15);

    console.log("Processing batch of users");

    const batchSize = 50;

    const userQueue = await context.redis.zRange(RedisKey.UserCheckQueue, 0, batchSize - 1).then(items => items.map(item => item.member));

    if (userQueue.length === 0) {
        // Finished processing users. Now actually prune notes!
        await pruneNotes(pruneOptions, context);
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
                    user = await context.reddit.getUserByUsername(username);
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
                    const userHistory = await context.reddit.getCommentsAndPostsByUser({
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
        await context.redis.zAdd(RedisKey.PrunableUsers, ...prunableUsers.map(user => ({ member: user, score: 0 })));
    }

    await context.redis.zRem(RedisKey.UserCheckQueue, usersChecked);
    await context.redis.incrBy(RedisKey.UsersChecked, usersChecked.length);

    await context.scheduler.runJob({
        name: SchedulerJob.CheckUserBatch,
        data: { ...pruneOptions },
        runAt: addSeconds(new Date(), 1),
    });
}

export async function checkUserBatchRecovery (_: unknown, context: JobContext) {
    if (await context.redis.exists(RedisKey.UserBatchLastRun)) {
        // Last run was recent enough, no need to recover.
        return;
    }

    if (!await context.redis.exists(RedisKey.PruneStage)) {
        // Prune is not in progress, nothing to recover. Cancel this recovery job.
        await cancelExistingJobs(context.scheduler, SchedulerJob.CheckUserBatchRecovery);
        return;
    }
}

export async function pruneNotes (options: PruneOptions, context: TriggerContext) {
    console.log("Finished user check. Pruning notes.");

    await context.redis.set(RedisKey.PruneStage, PruneStage.Stage3RemovingRedundantEntries, { expiration: addHours(new Date(), 6) });

    const prunableUsers = (await context.redis.zRange(RedisKey.PrunableUsers, 0, -1)).map(item => item.member);
    const message: json2md.DataObject[] = [];

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    if (prunableUsers.length > 0 || options.pruneNotesOlderThan) {
        console.log(`Pruning notes for ${prunableUsers.length} users. Prune old notes: ${options.pruneNotesOlderThan}.`);
        const toolbox = new ToolboxClient(context.reddit);
        const allUserNotes = await toolbox.getUsernotes(subredditName);
        const rawNotes = decompressBlob(allUserNotes.toJSON().blob);
        const allUsers = Object.keys(rawNotes);

        const usersToKeep = Object.keys(rawNotes).filter(username => !prunableUsers.includes(username));
        const newRawNotes: RawUsernotesUsers = {};
        let notesPrunedCount = 0;

        const cutoffEpochSeconds = options.pruneNotesOlderThan ? timePeriodToTimeStamp(options.pruneNotesOlderThanPeriod).getTime() / 1000 : undefined;

        for (const user of allUsers) {
            if (usersToKeep.includes(user)) {
                const notes = rawNotes[user];
                if (cutoffEpochSeconds) {
                    notes.ns = [...notes.ns.filter(note => note.t >= cutoffEpochSeconds)];
                }
                if (notes.ns.length > 0) {
                    newRawNotes[user] = notes;
                }

                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (newRawNotes[user]) {
                    notesPrunedCount += (notes.ns.length - newRawNotes[user].ns.length);
                } else {
                    notesPrunedCount += notes.ns.length;
                }
            } else {
                notesPrunedCount += rawNotes[user].ns.length;
            }
        }

        const compressedBlob = compressBlob(newRawNotes).toString();

        const wikiPage = await context.reddit.getWikiPage(subredditName, "usernotes");
        await context.redis.set(RedisKey.NotesBackup, wikiPage.content);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const wikiContent = JSON.parse(wikiPage.content);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        wikiContent.blob = compressedBlob;

        const newPageContent = JSON.stringify(wikiContent);

        const newPage = await context.reddit.updateWikiPage({
            subredditName,
            page: "usernotes",
            content: newPageContent,
            reason: `Pruned ${notesPrunedCount} ${pluralize("note", notesPrunedCount)}`,
        });

        await context.redis.set(RedisKey.RevisionAfterPrune, newPage.revisionId);

        const freeSpace = Math.round(100 * ((MAX_WIKI_PAGE_SIZE - newPageContent.length) / MAX_WIKI_PAGE_SIZE));
        message.push({ p: `Toolbox notes prune has now completed. ${notesPrunedCount} notes ${pluralize("has", notesPrunedCount)} been removed.` });
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

    await context.reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: "Toolbox Notes Prune has been completed.",
        bodyMarkdown: json2md(message),
    });

    await context.redis.del(RedisKey.PruneStage);
    await context.redis.del(RedisKey.PrunableUsers);
    await context.redis.del(RedisKey.UserCheckQueue);
    await context.redis.del(RedisKey.UsersChecked);
    await context.redis.del(RedisKey.UserCheckTotalCount);
    await context.redis.del(RedisKey.PruneStarted);
    await context.redis.del(RedisKey.PruneOptions);
    await context.redis.del(RedisKey.UserBatchLastRun);

    await cancelExistingJobs(context.scheduler, SchedulerJob.CheckUserBatchRecovery);

    console.log("Notes have been pruned!");
}

export async function restoreMenuHandler (_: MenuItemOnPressEvent, context: Context) {
    const appStage = await context.redis.get(RedisKey.PruneStage);
    if (appStage) {
        context.ui.showToast("A notes prune appears to be in progress. Cannot restore backup.");
        return;
    }

    const revisionAfterPrune = await context.redis.get(RedisKey.RevisionAfterPrune);
    const backupContent = await context.redis.get(RedisKey.NotesBackup);
    if (!revisionAfterPrune || !backupContent) {
        context.ui.showToast("There have been no usernote backups taken by this app.");
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const wikiPage = await context.reddit.getWikiPage(subredditName, "usernotes");

    let message: string;
    if (wikiPage.revisionId !== revisionAfterPrune) {
        message = "Warning: New notes have been created since the backup was taken. Do you want to continue?";
    } else {
        message = "Do you want to restore usernotes? This will reinstate notes deleted during the last prune operation.";
    }

    context.ui.showForm(restoreForm, {
        description: message,
    });
}

export async function restoreFormHandler (_: FormOnSubmitEvent<JSONObject>, context: Context) {
    const backupContent = await context.redis.get(RedisKey.NotesBackup);

    if (!backupContent) {
        context.ui.showToast("There have been no usernote backups taken by this app.");
        return;
    }

    console.log("Restore Starting");

    const subreddit = await context.reddit.getCurrentSubreddit();
    await context.reddit.updateWikiPage({
        subredditName: subreddit.name,
        page: "usernotes",
        content: backupContent,
        reason: "Restored usernotes from backup",
    });

    context.ui.showToast("Usernotes backup has been restored.");
    console.log("Restore Complete");
}
