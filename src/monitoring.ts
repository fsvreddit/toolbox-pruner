import { SettingsFormField, TriggerContext, WikiPage } from "@devvit/public-api";
import { MAX_WIKI_PAGE_SIZE, RedisKey } from "./constants.js";
import json2md from "json2md";
import { addWeeks } from "date-fns";

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

export async function checkFreeSpace (_: unknown, context: TriggerContext) {
    const settings = await context.settings.getAll();
    if (!settings[MonitoringSetting.EnableFeature]) {
        return;
    }

    const pruneStage = await context.redis.get(RedisKey.PruneStage);
    if (pruneStage) {
        console.log("Monitoring: Notes prune is in progress. Skipping this task");
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, "usernotes");
    } catch (error) {
        console.log("Monitoring: Error retrieving wiki page.");
        console.log(error);
        return;
    }

    const threshold = settings[MonitoringSetting.Threshold] as number | undefined ?? 10;
    const freeSpace = Math.round(100 * ((MAX_WIKI_PAGE_SIZE - wikiPage.content.length) / MAX_WIKI_PAGE_SIZE));

    if (freeSpace >= threshold) {
        console.log(`Monitoring: There's enough space free (${freeSpace}%, threshold ${threshold}%).`);
        await context.redis.del(RedisKey.AlertSent);
        return;
    }

    console.log(`Monitoring: Insufficient space! (${freeSpace}%, threshold ${threshold}%).`);

    const alertSent = await context.redis.get(RedisKey.AlertSent);
    if (alertSent) {
        console.log(`Monitoring: We have previously sent an alert, quitting.`);
        return;
    }
    const message: json2md.DataObject[] = [
        { p: `The Toolbox Usernotes wiki page is running low on space.` },
        { p: `There is ${freeSpace}% free on the page, with ${MAX_WIKI_PAGE_SIZE - wikiPage.content.length} characters overhead remaining.` },
        { p: `This app will not alert you again for another week.` },
    ];

    await context.redis.set(RedisKey.AlertSent, new Date().getTime().toString(), { expiration: addWeeks(new Date(), 1) });

    await context.reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: "Toolbox Notes wiki page is running low on space!",
        bodyMarkdown: json2md(message),
    });
}
