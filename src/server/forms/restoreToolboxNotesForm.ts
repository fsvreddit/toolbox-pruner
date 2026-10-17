import { context, reddit, redis } from "@devvit/web/server";
import { UiResponse } from "@devvit/web/shared";
import type { Context } from "hono";
import { RedisKey } from "../core";

export const handleRestoreToolboxNotesForm = async (c: Context): Promise<Response> => {
    const backupContent = await redis.get(RedisKey.NotesBackup);

    if (!backupContent) {
        return c.json<UiResponse>({
            showToast: "There have been no usernote backups taken by this app.",
        });
    }

    console.log("Restore Starting");

    await reddit.updateWikiPage({
        subredditName: context.subredditName,
        page: "usernotes",
        content: backupContent,
        reason: "Restored usernotes from backup",
    });

    console.log("Restore Complete");

    return c.json<UiResponse>({
        showToast: "Usernotes backup has been restored.",
    });
};
