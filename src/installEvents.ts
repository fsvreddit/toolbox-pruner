import { TriggerContext } from "@devvit/public-api";
import { AppInstall, AppUpgrade } from "@devvit/protos";
import { CHECK_USER_BATCH_JOB_NAME } from "./constants.js";

export async function handleAppInstallUpgradeEvents (_: AppInstall | AppUpgrade, context: TriggerContext) {
    console.log("Detected an install or upgrade event. Rescheduling jobs.");
    const currentJobs = await context.scheduler.listJobs();
    await Promise.all(currentJobs.filter(job => job.name !== CHECK_USER_BATCH_JOB_NAME).map(job => context.scheduler.cancelJob(job.id)));

    await context.scheduler.runJob({
        name: "checkFreeSpace",
        cron: "0 1 * * *",
    });
}
