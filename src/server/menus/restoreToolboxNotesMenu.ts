import { context, reddit, redis } from "@devvit/web/server";
import { UiResponse } from "@devvit/web/shared";
import type { Context } from "hono";
import { FormName, RedisKey } from "../core";

export const handleRestoreToolboxNotesMenu = async (c: Context): Promise<Response> => {
    console.log("Handling prune toolbox notes menu");

    const appStage = await redis.get(RedisKey.PruneStage);
    if (appStage) {
        return c.json<UiResponse>({
            showToast: "A notes prune appears to be in progress. Cannot restore backup.",
        });
    }

    const revisionAfterPrune = await redis.get(RedisKey.RevisionAfterPrune);
    const backupContent = await redis.get(RedisKey.NotesBackup);
    if (!revisionAfterPrune || !backupContent) {
        return c.json<UiResponse>({
            showToast: "There have been no usernote backups taken by this app.",
        });
    }

    const subredditName = context.subredditName;
    const wikiPage = await reddit.getWikiPage(subredditName, "usernotes");

    let message: string;
    if (wikiPage.revisionId !== revisionAfterPrune) {
        message = "Warning: New notes have been created since the backup was taken. Do you want to continue?";
    } else {
        message = "Do you want to restore usernotes? This will reinstate notes deleted during the last prune operation.";
    }

    return c.json<UiResponse>({
        showForm: {
            name: FormName.RestoreUsernotes,
            form: {
                title: "Restore Pruned Usernotes",
                description: message,
                fields: [],
                acceptLabel: "Yes",
                cancelLabel: "Cancel",
            },
        },
    });
};
