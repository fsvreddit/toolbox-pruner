import type { Context } from "hono";
import { TriggerResponse } from "@devvit/web/shared";
import { handleAppInstallUpgradeEvents } from "../core";

export const onAppInstall = async (c: Context): Promise<Response> => {
    console.log("App Install: Triggered");

    await handleAppInstallUpgradeEvents();

    return c.json<TriggerResponse>({ message: "app installed" }, 200);
};
