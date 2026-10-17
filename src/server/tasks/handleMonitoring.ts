import { TaskResponse } from "@devvit/web/server";
import { Context } from "hono";
import { checkFreeSpace } from "../core";

export const handleMonitoringJob = async (c: Context): Promise<Response> => {
    await checkFreeSpace();

    return c.json<TaskResponse>({ message: "Handled monitoring job." }, 200);
};
