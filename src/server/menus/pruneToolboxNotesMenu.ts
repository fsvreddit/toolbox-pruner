import { context, reddit, redis, WikiPage } from "@devvit/web/server";
import { UiResponse } from "@devvit/web/shared";
import type { Context } from "hono";
import { FormName, hasPermissions, MAX_WIKI_PAGE_SIZE, PruneOption, RedisKey, TimePeriod } from "../core";
import { addMilliseconds, differenceInMilliseconds, differenceInMinutes, formatDuration, intervalToDuration } from "date-fns";

export const handlePruneToolboxNotesMenu = async (c: Context): Promise<Response> => {
    console.log("Handling prune toolbox notes menu");

    const currentStage = await redis.get(RedisKey.PruneStage);
    if (currentStage) {
        return c.json<UiResponse>(await showCurrentProgress());
    }

    const subredditName = context.subredditName;
    let wikiPage: WikiPage;
    try {
        wikiPage = await reddit.getWikiPage(subredditName, "usernotes");
    } catch {
        // TODO: Check to see if app has Wiki permissions. Do different errors based on the result.
        const appHasAccess = await hasPermissions({ username: context.appSlug, subredditName, requiredPerms: ["wiki"] });
        if (appHasAccess) {
            return c.json<UiResponse>({
                showToast: "Cannot retrieve Toolbox Usernotes wiki page. This app only works on subreddits that use Toolbox usernotes.",
            });
        } else {
            return c.json<UiResponse>({
                showToast: "/u/toolbox-pruner needs access to the wiki to continue.",
            });
        }
    }

    const freeSpace = Math.round(100 * ((MAX_WIKI_PAGE_SIZE - wikiPage.content.length) / MAX_WIKI_PAGE_SIZE));

    return c.json<UiResponse>({
        showForm: {
            name: FormName.PruneToolboxNotes,
            form: {
                title: "Toolbox Usernotes Prune",
                description: `You have ${freeSpace}% free on the Toolbox wiki page. Do you want to continue?`,
                fields: [
                    {
                        type: "boolean",
                        name: PruneOption.PruneDeletedUsers,
                        label: "Prune notes for suspended, deleted or shadowbanned users",
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
            },
        },
    });
};

export async function showCurrentProgress (): Promise<UiResponse> {
    const usersProcessedStr = await redis.get(RedisKey.UsersChecked);
    const totalUsersStr = await redis.get(RedisKey.UserCheckTotalCount);
    const pruneStartedStr = await redis.get(RedisKey.PruneStarted);

    if (!usersProcessedStr || !totalUsersStr || !pruneStartedStr) {
        // This should be impossible.
        return {
            showToast: "Prune is in progress.",
        };
    }

    const usersProcessed = parseInt(usersProcessedStr);
    const totalUsers = parseInt(totalUsersStr);
    const pruneStarted = new Date(parseInt(pruneStartedStr));

    if (totalUsers === 0) {
        return {
            showToast: "Prune will finish imminently.",
        };
    }

    const percentCompleted = Math.round(100 * (usersProcessed / totalUsers));

    // Prevent division by zero if usersProcessed >= totalUsers
    const elapsedMillis = differenceInMilliseconds(new Date(), pruneStarted);
    const estimatedFinishMillis = (usersProcessed > 0)
        ? (elapsedMillis / usersProcessed) * (totalUsers - usersProcessed)
        : 0;

    if (usersProcessed >= totalUsers) {
        return {
            showToast: "Prune is complete or finishing up.",
        };
    }

    const estimatedFinish = addMilliseconds(new Date(), estimatedFinishMillis);

    let eta: string;
    if (differenceInMinutes(estimatedFinish, new Date()) < 2) {
        eta = "about one minute";
    } else {
        eta = formatDuration(intervalToDuration({ start: new Date(), end: estimatedFinish }), { format: ["hours", "minutes"] });
    }

    return {
        showToast: `Prune is in progress, ${eta} remaining. Analyzed ${percentCompleted}%  of users.`,
    };
}
