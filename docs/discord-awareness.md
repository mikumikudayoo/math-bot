# Discord context and tools

The installed discord.js version is 14.27.0. This change uses documented bot APIs through that library; it adds no scraping, user tokens, self-bot endpoints, dependency or new public listener.

## Request identity

Both slash study submissions and mention/reply submissions capture the triggering Discord user's ID, username, display name, available guild nickname and guild ID. Metadata is bounded, stored with the accepted job in an additive `jobs.discordContext` SQLite column, and survives queue recovery. The service reconstructs identity from the authenticated submission's user/guild IDs, ignoring metadata's claimed IDs or creator status. Inference reconstructs it again from the job and places it in a separate system context. Older jobs have empty labels and retain their original IDs.

Only ID `821682594830614578` sets `isCreator=true`; the creator's configured name is emu. Names and nicknames are user-controlled labels, not instructions or authorization. Prompt text and retrieved content cannot change the requester, guild or creator flag. Aleph-Zero remains separate from emu. Rich roles/profile data is fetched only on demand, not included in every prompt.

The shared service token remains the gateway trust boundary, just as for job admission. Keep it private and the service on loopback. The model never receives the token or bot credentials.

## Executor and permissions

Inference can request `discord_member({userId?})` or `discord_search({query, limit?, authorId?, after?, before?})`. Missing member ID means the requester; other IDs select a target within the current guild, never the acting identity. Dates are ISO timestamps with an explicit timezone. Search matches a literal case-insensitive substring. `authorId` narrows results only. No requester, guild or channel override is accepted from tool arguments.

An in-memory broker on the existing authenticated HTTP service passes read-only tasks to the gateway's two-second polling worker. The worker rechecks the AI tester gate and development guild boundary. Each job permits at most two Discord tool calls within the existing tool/iteration budgets. Each broker request expires after 30 seconds; cancellation/shutdown removes outstanding requests. Read-only work may finish after timeout, but late results are discarded. A restart requeues jobs using the existing scheduler; no durable Discord tool queue or cross-process bot-token sharing is added.

For every execution, the gateway fetches the current guild, role definitions and requester membership. Both requester and bot need View Channel and Read Message History in the invoking channel and each searched channel. Private threads additionally require membership or Manage Threads, checked separately for the requester and bot. Parent permissions are checked too. Message results are checked again after fetching and before returning. Failed checks use generic responses without hidden names, IDs, totals or errors. Permissions are a point-in-time check, not a permanent access grant.

The existing response destination is unchanged: AI replies appear in the invoking channel. Use an appropriately private channel for questions about restricted server information; this is not a new ephemeral-answer feature.

## Bounded history and profile limitations

Search examines at most 60 candidate channels, reads at most six accessible text/announcement channels or active threads, and fetches at most two pages of 50 messages each per channel. The invoking thread can also be archived. The loop stops starting new pages after 20 seconds. It returns at most ten results with 600 characters per message, author ID/username, channel name, timestamp, ID and a host-built message link. No DM search, other-guild search, attachments, embedded message snapshots, whole-server export or archived-thread enumeration is performed. Forum/media posts are included when represented by accessible active threads; voice/stage chat is excluded. Discord.js manages REST rate limits. There is no added retry loop or history cache.

This is deliberately a recent-history scan, not an exhaustive historical search. Discord now documents [Search Guild Messages](https://docs.discord.com/developers/resources/message#search-guild-messages), but the installed library has no guild-message-search convenience method. This implementation uses its documented [channel history fetch](https://docs.discord.com/developers/resources/message#get-channel-messages) path with explicit channel authorization. Dates/author filters do not expand the scan window; "no matches" never proves a message does not exist. Wider historical search can be added separately with the same authorization checks.

Member lookup returns available username, guild display/nickname, up to 15 role names, account creation/join timestamps, avatar and global banner. It fetches only a specific guild member, not a member directory. General user bio/about-me is not exposed by the documented [Get User/User object](https://docs.discord.com/developers/resources/user#get-user) used here. The library's ability to edit the bot's own guild bio does not grant access to other users' bios. No workaround is attempted. [Private thread access rules](https://docs.discord.com/developers/topics/threads) remain enforced; failed membership lookup excludes the thread.

## Routing and setup

Explicit server-history/self-profile questions take a local Discord route. Other questions retain the existing router, public-web grounding and math behavior. The Discord tools are available even on internal/no-web routes; neither tool enables Tavily or arbitrary URL fetching. All returned text and labels are tagged as untrusted data. Clear Discord requests must attempt lookup before a final answer; unavailable tools produce an explicit failure instead of a guessed profile/history answer.

Enable **Message Content Intent** in the Discord Developer Portal and `MESSAGE_FEATURES_ENABLED=true` in the existing bot environment for history content. Guilds intent is already configured. The implementation uses individual member REST fetches, not bulk member listing or presence tracking; it does not add Guild Members or Presence gateway intents. Grant the bot View Channel and Read Message History where it should search. Private threads must be accessible to both bot and requester. No Administrator permission is required. Keep the existing tester allowlist configured. Missing history content/permissions is not bypassed.

For a later authorized rollout, update both bot and study-service code and restart both existing PM2 processes under mathbot in `/opt/math-bot`; the additive jobs column is created when the study store opens. No new secrets, slash-command definitions, PM2 processes, systemd units or migration to `/srv` are required. Back up SQLite normally before any rollout. This implementation has only mocked Discord validation, not live permission/API tests, and makes no commit, push, registration or deployment. Reliability unit tests inject fixture routing-sensor signals through the real router; production still uses its existing routing sensor.
