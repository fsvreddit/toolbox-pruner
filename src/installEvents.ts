import { TriggerContext } from "@devvit/public-api";
import { AppInstall, AppUpgrade } from "@devvit/protos";
import { RedisKey, SchedulerJob } from "./constants.js";

export async function handleAppInstallUpgradeEvents (_: AppInstall | AppUpgrade, context: TriggerContext) {
    console.log("Detected an install or upgrade event. Rescheduling jobs.");
    const currentJobs = await context.scheduler.listJobs();
    const jobsToKeep = [
        SchedulerJob.CheckUserBatch,
        SchedulerJob.CheckUserBatchRecovery,
    ];

    await Promise.all(currentJobs.filter(job => !jobsToKeep.includes(job.name as SchedulerJob)).map(job => context.scheduler.cancelJob(job.id)));

    await context.scheduler.runJob({
        name: SchedulerJob.Monitoring,
        cron: "0 1 * * *",
    });

    await context.redis.del(RedisKey.PruneStage);
}
