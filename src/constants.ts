export const MAX_WIKI_PAGE_SIZE = 1048576;

export enum RedisKey {
    PruneStage = "pruneStage",
    NotesBackup = "notesBackup",
    PrunableUsers = "prunableUsers",
    PruneStarted = "pruneStarted",
    PruneOptions = "pruneOptions",
    UserCheckQueue = "userCheckQueue",
    UserCheckTotalCount = "userCheckCount",
    UsersChecked = "usersChecked",
    RevisionAfterPrune = "revisionAfterPrune",
    UserBatchLastRun = "userBatchLastRun",
    AlertSent = "alertSent",
}

export enum SchedulerJob {
    CheckUserBatch = "checkUserBatchV2",
    CheckUserBatchRecovery = "checkUserBatchRecovery",
    Monitoring = "checkFreeSpace",
}
