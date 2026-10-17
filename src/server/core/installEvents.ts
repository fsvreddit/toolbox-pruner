import { redis, scheduler } from "@devvit/web/server";
import { RedisKey, SchedulerJob } from ".";

export async function handleAppInstallUpgradeEvents () {
    console.log("Detected an install or upgrade event. Rescheduling jobs.");
    const currentJobs = await scheduler.listJobs();
    const jobsToKeep = [
        SchedulerJob.CheckUserBatch,
        SchedulerJob.CheckUserBatchRecovery,
    ];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
    await Promise.all(currentJobs.filter(job => !jobsToKeep.includes(job.name as SchedulerJob)).map(job => scheduler.cancelJob(job.id)));

    await scheduler.runJob({
        name: SchedulerJob.Monitoring,
        cron: "0 1 * * *",
    });

    if (await redis.exists(RedisKey.PruneStage)) {
        await redis.expire(RedisKey.PruneStage, 6 * 60 * 60); // 6 hours in seconds
    }
}
