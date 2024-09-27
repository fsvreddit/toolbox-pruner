import { Context, FormOnSubmitEvent, MenuItemOnPressEvent, ScheduledJobEvent, Subreddit, TriggerContext, User, WikiPage } from "@devvit/public-api";
import { confirmationForm, restoreForm } from "./main.js";
import { compressBlob, decompressBlob, RawUsernotesUsers, ToolboxClient } from "toolbox-devvit";
import pluralize from "pluralize";
import { addSeconds, differenceInMinutes, formatDuration, intervalToDuration } from "date-fns";
import { CHECK_USER_BATCH_JOB_NAME, MAX_WIKI_PAGE_SIZE, PRUNE_STAGE } from "./constants.js";

const USER_CHECK_QUEUE = "userCheckQueue";
const PRUNABLE_USERS = "prunableUsers";
const USER_CHECK_TOTAL_COUNT = "userCheckCount";
const USERS_CHECKED = "usersChecked";
const NOTES_BACKUP = "notesBackup";
const REVISION_AFTER_PRUNE = "revisionAfterPrune";

export enum PruneStage {
    Stage1StoringUserList = "storingUserList",
    Stage2CheckingUsers = "checkingUsers",
    Stage3RemovingRedundantEntries = "removingRedundantEntries",
}

async function appAccountHasWikiAccess (subreddit: Subreddit, context: TriggerContext) {
    const appAccount = await context.reddit.getAppUser();
    const permissions = await appAccount.getModPermissionsForSubreddit(subreddit.name);
    return permissions.includes("all") || permissions.includes("wiki");
}

export async function pruneMenuHandler (_: MenuItemOnPressEvent, context: Context) {
    const currentStage = await context.redis.get(PRUNE_STAGE);
    if (currentStage) {
        await showCurrentProgress(context);
        return;
    }

    const subreddit = await context.reddit.getCurrentSubreddit();
    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(subreddit.name, "usernotes");
    } catch {
        // TODO: Check to see if app has Wiki permissions. Do different errors based on the result.
        const appHasAccess = await appAccountHasWikiAccess(subreddit, context);
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

function getETA (processed: number, total: number): string {
    const estimatedFinish = addSeconds(new Date(), 35 * ((total - processed) / 50));
    if (differenceInMinutes(estimatedFinish, new Date()) < 2) {
        return ("about one minute");
    } else {
        return formatDuration(intervalToDuration({ start: new Date(), end: estimatedFinish }), { format: ["hours", "minutes"] });
    }
}

export async function showCurrentProgress (context: Context) {
    const usersProcessedStr = await context.redis.get(USERS_CHECKED);
    const totalUsersStr = await context.redis.get(USER_CHECK_TOTAL_COUNT);

    if (!usersProcessedStr || !totalUsersStr) {
        // This should be impossible.
        context.ui.showToast("Prune is in progress.");
        return;
    }

    const usersProcessed = parseInt(usersProcessedStr);
    const totalUsers = parseInt(totalUsersStr);

    const percentCompleted = Math.round(100 * (usersProcessed / totalUsers));

    context.ui.showToast(`Prune is in progress, ${getETA(usersProcessed, totalUsers)} remaining. Analyzed ${percentCompleted}%  of users.`);
}

export async function confirmationFormHandler (_: FormOnSubmitEvent, context: Context) {
    await context.redis.set(PRUNE_STAGE, PruneStage.Stage1StoringUserList);

    const toolbox = new ToolboxClient(context.reddit);
    const subreddit = await context.reddit.getCurrentSubreddit();
    const allUserNotes = await toolbox.getUsernotes(subreddit.name);
    const distinctUsers = Object.keys(decompressBlob(allUserNotes.toJSON().blob));
    if (distinctUsers.length === 0) {
        context.ui.showToast("The Toolbox user notes page contains no notes. Nothing to do.");
        await context.redis.del(PRUNE_STAGE);
        return;
    }

    // Delete previous app keys just in case.
    await context.redis.del(PRUNABLE_USERS);
    await context.redis.del(USER_CHECK_QUEUE);
    await context.redis.del(USERS_CHECKED);
    await context.redis.del(USER_CHECK_TOTAL_COUNT);
    await context.redis.del(REVISION_AFTER_PRUNE);

    await context.redis.zAdd(USER_CHECK_QUEUE, ...distinctUsers.map(user => ({ member: user, score: 0 })));
    await context.redis.set(USER_CHECK_TOTAL_COUNT, JSON.stringify(distinctUsers.length));

    context.ui.showToast(`Queued ${distinctUsers.length} ${pluralize("user", distinctUsers.length)} for processing. ${getETA(0, distinctUsers.length)} until finish.`);

    await context.redis.set(PRUNE_STAGE, PruneStage.Stage2CheckingUsers);

    await context.scheduler.runJob({
        name: CHECK_USER_BATCH_JOB_NAME,
        runAt: new Date(),
    });
}

export async function checkUserBatch (_: ScheduledJobEvent, context: TriggerContext) {
    console.log("Processing batch of users");

    const batchSize = 50;

    const userQueue = (await context.redis.zRange(USER_CHECK_QUEUE, 0, batchSize - 1)).map(item => item.member);

    if (userQueue.length === 0) {
        // Finished processing users. Now actually prune notes!
        await pruneNotes(context);
        return;
    }

    const prunableUsers: string[] = [];

    for (const username of userQueue) {
        let user: User | undefined;
        try {
            user = await context.reddit.getUserByUsername(username);
        } catch {
            //
        }

        if (!user) {
            prunableUsers.push(username);
        }
    }

    console.log(`${prunableUsers.length} out of ${userQueue.length} are suspended, shadowbanned or deleted`);
    if (prunableUsers.length > 0) {
        await context.redis.zAdd(PRUNABLE_USERS, ...prunableUsers.map(user => ({ member: user, score: 0 })));
    }

    await context.redis.zRem(USER_CHECK_QUEUE, userQueue);
    await context.redis.incrBy(USERS_CHECKED, userQueue.length);

    await context.scheduler.runJob({
        name: CHECK_USER_BATCH_JOB_NAME,
        runAt: addSeconds(new Date(), 30),
    });
}

export async function pruneNotes (context: TriggerContext) {
    console.log("Finished user check. Pruning notes.");

    await context.redis.set(PRUNE_STAGE, PruneStage.Stage3RemovingRedundantEntries);

    const prunableUsers = (await context.redis.zRange(PRUNABLE_USERS, 0, -1)).map(item => item.member);
    let message: string;

    const subreddit = await context.reddit.getCurrentSubreddit();

    if (prunableUsers.length > 0) {
        const toolbox = new ToolboxClient(context.reddit);
        const allUserNotes = await toolbox.getUsernotes(subreddit.name);
        const rawNotes = decompressBlob(allUserNotes.toJSON().blob);

        const usersToKeep = Object.keys(rawNotes).filter(username => !prunableUsers.includes(username));
        const newRawNotes: RawUsernotesUsers = {};

        for (const user of usersToKeep) {
            newRawNotes[user] = rawNotes[user];
        }

        const compressedBlob = compressBlob(newRawNotes).toString();

        const wikiPage = await context.reddit.getWikiPage(subreddit.name, "usernotes");
        await context.redis.set(NOTES_BACKUP, wikiPage.content);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const wikiContent = JSON.parse(wikiPage.content);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        wikiContent.blob = compressedBlob;

        const newPageContent = JSON.stringify(wikiContent);

        const newPage = await context.reddit.updateWikiPage({
            subredditName: subreddit.name,
            page: "usernotes",
            content: newPageContent,
            reason: `Pruned usernotes for ${prunableUsers.length} ${pluralize("user", prunableUsers.length)}`,
        });

        await context.redis.set(REVISION_AFTER_PRUNE, newPage.revisionId);

        const freeSpace = Math.round(100 * ((MAX_WIKI_PAGE_SIZE - newPageContent.length) / MAX_WIKI_PAGE_SIZE));
        message = `Toolbox notes prune has now completed. Notes for ${prunableUsers.length} ${pluralize("user", prunableUsers.length)} ${pluralize("has", prunableUsers.length)} been removed.\n\n`;
        message += `You now have ${freeSpace}% free space on the Toolbox wiki page.`;
    } else {
        message = "Toolbox notes prune has now completed. There were no suspended, deleted or shadowbanned users with usernotes, so no changes have been made.";
    }

    const appUser = await context.reddit.getAppUser();
    await context.reddit.modMail.createConversation({
        subredditName: subreddit.name,
        body: message,
        subject: "Toolbox Notes Prune has been completed.",
        to: appUser.username,
    });

    await context.redis.del(PRUNE_STAGE);
    await context.redis.del(PRUNABLE_USERS);
    await context.redis.del(USER_CHECK_QUEUE);
    await context.redis.del(USERS_CHECKED);
    await context.redis.del(USER_CHECK_TOTAL_COUNT);

    console.log("Notes have been pruned!");
}

export async function restoreMenuHandler (_: MenuItemOnPressEvent, context: Context) {
    const appStage = await context.redis.get(PRUNE_STAGE);
    if (appStage) {
        context.ui.showToast("A notes prune appears to be in progress. Cannot restore backup.");
        return;
    }

    const revisionAfterPrune = await context.redis.get(REVISION_AFTER_PRUNE);
    const backupContent = await context.redis.get(NOTES_BACKUP);
    if (!revisionAfterPrune || !backupContent) {
        context.ui.showToast("There have been no usernote backups taken by this app.");
        return;
    }

    const subreddit = await context.reddit.getCurrentSubreddit();
    const wikiPage = await context.reddit.getWikiPage(subreddit.name, "usernotes");

    let message: string;
    if (wikiPage.revisionId !== revisionAfterPrune) {
        message = "Warning: New notes have been created since the backup was taken. Do you want to continue?";
    } else {
        message = "Do you want to restore usernotes? This will reinstate notes for suspended/deleted/shadowbanned users.";
    }

    context.ui.showForm(restoreForm, {
        description: message,
    });
}

export async function restoreFormHandler (_: FormOnSubmitEvent, context: Context) {
    const backupContent = await context.redis.get(NOTES_BACKUP);

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
