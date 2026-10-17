import type { Context } from "hono";
import { TaskResponse } from "@devvit/web/server";
import { checkUserBatchRecovery } from "../core";

export type DelayedMessageJobData = {
    firstRun: boolean;
    jobGuid?: string;
};

export const handleCheckUserBatchRecoveryJob = async (c: Context): Promise<Response> => {
    await checkUserBatchRecovery();

    return c.json<TaskResponse>({ success: true }, 200);
};
