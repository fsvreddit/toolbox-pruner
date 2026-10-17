import { ModeratorPermission, reddit, scheduler } from "@devvit/web/server";

export async function hasPermissions (opts: {
    subredditName: string;
    username: string;
    requiredPerms: ModeratorPermission[];
}): Promise<boolean> {
    const user = await reddit.getUserByUsername(opts.username);
    const permissions = await user?.getModPermissionsForSubreddit(opts.subredditName);
    if (!permissions) {
        return false;
    }
    return permissions.includes("all") || opts.requiredPerms.every(perm => permissions.includes(perm));
}

export async function cancelExistingJobs (jobName: string): Promise<number> {
    const currentJobs = await scheduler.listJobs();
    for (const job of currentJobs) {
        if (job.name === jobName) {
            await scheduler.cancelJob(job.id);
        }
    }
    return currentJobs.length;
}
