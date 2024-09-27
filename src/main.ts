import { Devvit } from "@devvit/public-api";
import { checkUserBatch, confirmationFormHandler, pruneMenuHandler, restoreFormHandler, restoreMenuHandler } from "./usernotePrune.js";
import { checkFreeSpace, monitoringSettings } from "./monitoring.js";
import { handleAppInstallUpgradeEvents } from "./installEvents.js";
import { CHECK_USER_BATCH_JOB_NAME, MONITORING_JOB_NAME } from "./constants.js";

Devvit.addSettings([
    monitoringSettings,
]);

Devvit.addMenuItem({
    label: "Prune Toolbox Notes",
    forUserType: "moderator",
    location: "subreddit",
    onPress: pruneMenuHandler,
});

export const confirmationForm = Devvit.createForm(data => ({
    title: "Prune Usernotes",
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    description: data.description,
    fields: [],
}), confirmationFormHandler);

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
    name: CHECK_USER_BATCH_JOB_NAME,
    onRun: checkUserBatch,
});

Devvit.addSchedulerJob({
    name: MONITORING_JOB_NAME,
    onRun: checkFreeSpace,
});

Devvit.configure({
    redditAPI: true,
    redis: true,
});

export default Devvit;
