import { ScheduledJobEvent, SettingsFormField, TriggerContext, WikiPage } from "@devvit/public-api";
import { MAX_WIKI_PAGE_SIZE, PRUNE_STAGE } from "./constants.js";

enum MonitoringSetting {
    EnableFeature = "enableMonitoring",
    Threshold = "monitoringThreshold",
}

export const monitoringSettings: SettingsFormField = {
    type: "group",
    label: "Monitoring Options",
    helpText: "Allows app to alert mods if free space on Toolbox Usernotes page gets too low. Checks are made once a day.",
    fields: [
        {
            type: "boolean",
            name: MonitoringSetting.EnableFeature,
            label: "Enable Free Space Monitoring",
            defaultValue: false,
        },
        {
            type: "number",
            name: MonitoringSetting.Threshold,
            label: "Free space threshold (%)",
            helpText: "App will alert if free space drops below this level.",
            defaultValue: 5,
        },
    ],
};

export async function checkFreeSpace (_: ScheduledJobEvent, context: TriggerContext) {
    const settings = await context.settings.getAll();
    if (!settings[MonitoringSetting.EnableFeature]) {
        return;
    }

    const pruneStage = await context.redis.get(PRUNE_STAGE);
    if (pruneStage) {
        console.log("Monitoring: Notes prune is in progress. Skipping this task");
        return;
    }

    const subreddit = await context.reddit.getCurrentSubreddit();

    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(subreddit.name, "usernotes");
    } catch (error) {
        console.log("Monitoring: Error retrieving wiki page.");
        console.log(error);
        return;
    }

    const threshold = settings[MonitoringSetting.Threshold] as number | undefined ?? 10;
    const freeSpace = Math.round(100 * ((MAX_WIKI_PAGE_SIZE - wikiPage.content.length) / MAX_WIKI_PAGE_SIZE));

    const alertSentRedisKey = "alertSent";

    if (freeSpace >= threshold) {
        console.log(`Monitoring: There's enough space free (${freeSpace}%, threshold ${threshold}%).`);
        await context.redis.del(alertSentRedisKey);
        return;
    }

    console.log(`Monitoring: Insufficient space! (${freeSpace}%, threshold ${threshold}%).`);

    const alertSent = await context.redis.get(alertSentRedisKey);
    if (alertSent) {
        console.log(`Monitoring: We have previously sent an alert, quitting.`);
        return;
    }

    const appUser = await context.reddit.getAppUser();

    let message = `The Toolbox Usernotes wiki page is running low on space.\n\n`;
    message += `There is ${freeSpace}% free on the page, with ${MAX_WIKI_PAGE_SIZE - wikiPage.content.length} characters overhead remaining.\n\n`;
    message += `This app will not alert you again while the free space remains under the threshold.`;

    await context.redis.set(alertSentRedisKey, new Date().getTime().toString());
    await context.reddit.modMail.createConversation({
        subredditName: subreddit.name,
        body: message,
        subject: "Toolbox Notes wiki page is running low on space!",
        to: appUser.username,
    });
}
