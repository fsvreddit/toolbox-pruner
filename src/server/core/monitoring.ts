import { context, reddit, redis, settings, WikiPage } from "@devvit/web/server";
import { AppSetting, MAX_WIKI_PAGE_SIZE, RedisKey } from ".";
import json2md from "json2md";
import { addWeeks } from "date-fns";

export async function checkFreeSpace () {
    const appSettings = await settings.getAll();
    if (!appSettings[AppSetting.EnableFeature]) {
        return;
    }

    const pruneStage = await redis.get(RedisKey.PruneStage);
    if (pruneStage) {
        console.log("Monitoring: Notes prune is in progress. Skipping this task");
        return;
    }

    const subredditName = context.subredditName;

    let wikiPage: WikiPage;
    try {
        wikiPage = await reddit.getWikiPage(subredditName, "usernotes");
    } catch (error) {
        console.log("Monitoring: Error retrieving wiki page.");
        console.log(error);
        return;
    }

    const threshold = appSettings[AppSetting.Threshold] as number | undefined ?? 10;
    const freeSpace = Math.round(100 * ((MAX_WIKI_PAGE_SIZE - wikiPage.content.length) / MAX_WIKI_PAGE_SIZE));

    if (freeSpace >= threshold) {
        console.log(`Monitoring: There's enough space free (${freeSpace}%, threshold ${threshold}%).`);
        await redis.del(RedisKey.AlertSent);
        return;
    }

    console.log(`Monitoring: Insufficient space! (${freeSpace}%, threshold ${threshold}%).`);

    const alertSent = await redis.get(RedisKey.AlertSent);
    if (alertSent) {
        console.log(`Monitoring: We have previously sent an alert, quitting.`);
        return;
    }
    const message: json2md.DataObject[] = [
        { p: `The Toolbox Usernotes wiki page is running low on space.` },
        { p: `There is ${freeSpace}% free on the page, with ${MAX_WIKI_PAGE_SIZE - wikiPage.content.length} characters overhead remaining.` },
        { p: `This app will not alert you again for another week.` },
    ];

    await redis.set(RedisKey.AlertSent, new Date().getTime().toString(), { expiration: addWeeks(new Date(), 1) });

    await reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: "Toolbox Notes wiki page is running low on space!",
        bodyMarkdown: json2md(message),
    });
}
