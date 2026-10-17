import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { checkUserBatch, PruneOptions } from "../core";

export const handleCheckUserBatchJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<PruneOptions>>();

    await checkUserBatch(request);

    return c.json<TaskResponse>({ success: true }, 200);
};
