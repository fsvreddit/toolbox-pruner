import { Hono } from "hono";
import { createServer, getServerPort } from "@devvit/web/server";
import { getRequestListener } from "@hono/node-server";
import { onAppInstall, onAppUpgrade } from "./triggers";
import { handleCheckUserBatchJob, handleCheckUserBatchRecoveryJob, handleMonitoringJob } from "./tasks";
import { handlePruneToolboxNotesMenu, handleRestoreToolboxNotesMenu } from "./menus";
import { handlePruneToolboxNotesForm, handleRestoreToolboxNotesForm } from "./forms";

const application = new Hono();

// Triggers
application.post("/internal/triggers/app-install", onAppInstall);
application.post("/internal/triggers/app-upgrade", onAppUpgrade);

// Scheduler jobs
application.post("/internal/tasks/check-free-space", handleMonitoringJob);
application.post("/internal/tasks/check-user-batch-v2", handleCheckUserBatchJob);
application.post("/internal/tasks/check-user-batch-recovery", handleCheckUserBatchRecoveryJob);

// Menus
application.post("/internal/menu/prune-toolbox-notes", handlePruneToolboxNotesMenu);
application.post("/internal/menu/restore-toolbox-notes", handleRestoreToolboxNotesMenu);

// Form handlers
application.post("/internal/forms/prune-toolbox-notes", handlePruneToolboxNotesForm);
application.post("/internal/forms/restore-toolbox-notes", handleRestoreToolboxNotesForm);

const server = createServer(getRequestListener(application.fetch));
server.on("error", (err) => {
    console.error(`server error; ${err.stack}`);
});

const port = getServerPort();
server.listen(port);
