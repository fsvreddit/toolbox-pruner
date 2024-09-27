A Devvit app to remove historic notes from users who are suspended, shadowbanned or deleted.

While Toolbox does include a similar function, it is often not reliable on subreddits where it is truly needed (subreddits with tens of thousands of notes, at imminent risk of running out of space) due to API limits.

This app takes a different approach, deliberately checking users slowly in order to stay well within rate limits. While this means it may take a few hours to run on subreddits with the largest user note counts, it should be reliable no matter how large your usernotes page is.

## Prune process

This app is triggered from the subreddit context menu - choose "Prune Toolbox Notes".

The app will tell you how much space you have free on the Toolbox notes page. If you choose to continue, the app will check every user with Toolbox notes in the background. This will take some time, and on some subreddits with a very large number of notes it may take several hours to check users.

An estimate of how long is left can be obtained during this stage by pressing the "Prune Toolbox Notes" button again while the checking process is ongoing.

Once all users have been checked, the Toolbox wiki page is opened by the app, and notes for all users that were found to be suspended, shadowbanned or deleted will be removed in one go. Usernotes that were added between the prune starting and the user checks finishing will not be lost.

Finally, the app will send modmail to the sub confirming that it has completed its task (it will appear in Mod Discussions). Once you are happy that everything is working as it should, the app may be uninstalled if you wish.

## Restore

While it's unlikely to be needed, the app also includes a "restore" function. When pruning notes, a backup of the usernotes wiki page is taken internally.

Restores can be undertaken from the subreddit context menu - choose "Restore Usernotes". You will be warned if any new notes were added since the backup was taken, and should be careful about restoring backups too long after the initial prune was completed. If you choose to continue, the Toolbox usernotes page content will be replaced with a copy of what was there immediately before notes were removed.

## Space Monitoring

This app can also be used to monitor free space on your Toolbox wiki page. If enabled, checks are made once a day at 01:00 UTC, and will create a Mod Discussion in modmail if the free space is under the threshold configured.

Once an alert has been sent, further alerts will not be sent again until the space free is above the alerting threshold again. Alerts will also not be sent if a notes prune job is currently in progress.

Monitoring is disabled by default, because if the mod team are installing the app to do a one-off cleanup it may not be desirable to have this running.

## Notes

Old Reddit reports the Toolbox wiki page limit as 524,288 characters. However, the true limit for the Toolbox Usernotes wiki page is actually double this (1,048,576 characters). As a result, the "free space" reported by the app may not be what you expect it to be.

## Source code and licence

This app is free and open source under the BSD 3-Clause licence. The source code can be found on Github [here](https://github.com/fsvreddit/toolbox-pruner).
