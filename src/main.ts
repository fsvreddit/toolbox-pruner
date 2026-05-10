import { Devvit } from "@devvit/public-api";
import { checkUserBatch, checkUserBatchRecovery, confirmationFormHandler, pruneForm, pruneMenuHandler, restoreFormHandler, restoreMenuHandler } from "./usernotePrune.js";
import { checkFreeSpace, monitoringSettings } from "./monitoring.js";
import { handleAppInstallUpgradeEvents } from "./installEvents.js";
import { SchedulerJob } from "./constants.js";

Devvit.addSettings([
    monitoringSettings,
]);

Devvit.addMenuItem({
    label: "Prune Toolbox Notes",
    forUserType: "moderator",
    location: "subreddit",
    onPress: pruneMenuHandler,
});

export const confirmationForm = Devvit.createForm(pruneForm, confirmationFormHandler);

Devvit.addMenuItem({
    label: "Restore Usernotes",
    forUserType: "moderator",
    location: "subreddit",
    onPress: restoreMenuHandler,
});

export const restoreForm = Devvit.createForm(data => ({
    title: "Restore Pruned Usernotes",
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    description: data.description,
    fields: [],
    acceptLabel: "Yes",
    cancelLabel: "Cancel",
}), restoreFormHandler);

Devvit.addTrigger({
    events: ["AppInstall", "AppUpgrade"],
    onEvent: handleAppInstallUpgradeEvents,
});

Devvit.addSchedulerJob({
    name: SchedulerJob.CheckUserBatch,
    onRun: checkUserBatch,
});

Devvit.addSchedulerJob({
    name: SchedulerJob.CheckUserBatchRecovery,
    onRun: checkUserBatchRecovery,
});

Devvit.addSchedulerJob({
    name: SchedulerJob.Monitoring,
    onRun: checkFreeSpace,
});

Devvit.configure({
    redditAPI: true,
    redis: true,
});

export default Devvit;
