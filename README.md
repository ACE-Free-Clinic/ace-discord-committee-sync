# ACE Discord Committee Sync

This companion service syncs approved Discord roles to the `Members` sheet. It uses an existing `Discord User ID` when available. During the initial sync, it can also link a member when their Discord nickname is an exact, unique match for the sheet's `First Name` + `Last Name`; ambiguous or weak matches are reported for review rather than guessed.

## Role mapping

| Discord role | Members.Committee |
| --- | --- |
| Board Members | Board |
| Clinical | Clinical |
| Finance | Finance |
| Health Education | Health Education |
| Internal Affairs | Internal Affairs |
| Mental Health | Mental Health |
| Nutrition | Nutrition |
| Social Outreach | Social Outreach |
| Women's Health | Women's Health |

If a member has several approved roles, all mapped committees are written as a comma-separated value, for example `Clinical, Finance`. Roles outside this list are never mapped. During a full sync, a member already linked by Discord User ID has their Committee cell cleared if they no longer have any approved committee role; members without an approved role and without a linked ID are ignored.

## Setup

1. Create a Discord application and bot. Enable the **Server Members Intent** under Bot settings.
2. Invite it with `bot` scope and `View Server Members` permission.
3. Create a Google service account and enable Google Sheets API.
4. Share the ACE spreadsheet with the service account email as Editor.
5. Copy `.env.example` to `.env` and fill in the values.
6. Run `npm install`.
7. Run `npm run sync-all`. Unique exact nickname/name matches will be linked automatically. Approved-role members that cannot be matched are printed in the terminal and saved to `unmatched-members.csv`; add their Discord User IDs to the right Members rows, then rerun the command.
8. For no-cost scheduled production sync, use the GitHub Actions workflow in `.github/workflows/committee-sync.yml`. It runs `npm run sync-all` every 15 minutes; `npm start` is for local testing only.

The bot does not store tokens or service-account keys in this repository. Use environment variables in the hosting provider's secret settings.

## No-cost cloud deployment: GitHub Actions

The workflow in `.github/workflows/committee-sync.yml` runs the existing Node sync on GitHub-hosted Linux every 15 minutes and can also be started manually from the **Actions** tab. It does not require Render, a Mac, or a continuously running bot process. Standard GitHub-hosted runners are free for public repositories; this makes the bot-only repository's source code public, but secrets remain in GitHub Actions secret storage and are not committed to the repository.

Create an organization-owned **public** repository named `ace-discord-committee-sync`, then upload only the contents of this bot folder needed to run it: `.github/workflows/committee-sync.yml`, `src/`, `package.json`, `package-lock.json`, and `.gitignore`. Do not upload `.env`, `node_modules/`, `unmatched-members.csv`, or the Mac LaunchAgent plist. The workflow requires these repository Actions secrets: `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and `GOOGLE_PRIVATE_KEY`. Add them under **Settings → Secrets and variables → Actions**; never put secret values in source, issues, or logs.

After adding the secrets, open **Actions → Discord committee sync → Run workflow** for the initial test. Confirm the run logs `Initial sync complete`, then change a test member's approved Discord role and verify the Members sheet updates on the next scheduled run. GitHub scheduled jobs can be delayed, so allow some time beyond the 15-minute interval. Only after the cloud workflow succeeds should the Mac LaunchAgent be stopped. Do not install the Apps Script trigger while it fails with Discord HTTP 40333 (`Cloudflare is blocking your request`); the Apps Script request continued to receive that response even after adding Discord's recommended User-Agent and retrying alternate API hosts.

### Previous Apps Script trigger instructions (historical; currently blocked)

The Apps Script sync code remains in the ACE project, but live `UrlFetchApp` calls to Discord currently fail with HTTP 40333 from Discord's Cloudflare protection. Do not install its five-minute trigger unless a manual `syncDiscordCommitteeRolesNow` run succeeds first. The Node/GitHub Actions workflow above is the current no-cost cloud deployment path.

The trigger always runs as the Google account that created it. If this Apps Script route becomes usable in the future, use an organization-controlled account with editor access to the spreadsheet and script, store the bot token in Script Properties, and restrict Apps Script editor access to trusted maintainers.

<!-- Historical Apps Script setup retained for reference; do not follow unless the manual sync succeeds. -->

#### Historical one-time setup

1. In the Discord Developer Portal, open the ACE bot application → **Bot** → confirm **Server Members Intent** is enabled. If the bot token was ever exposed, click **Reset Token** and use only the replacement.
2. Sign into Google as the organization-controlled account that should own the trigger. It must have Editor access to the ACE database spreadsheet and Apps Script project. Installable triggers run as the account that creates them; other editors cannot manage that account's triggers.
3. Open the ACE database spreadsheet, then choose **Extensions → Apps Script**. If a permission screen appears, ask the current Apps Script owner to add the organization account as an Editor first.
4. In the Apps Script editor's left sidebar, click **Project Settings** (gear icon). Under **Script Properties**, click **Add script property** and enter:
	- `ACE_DISCORD_COMMITTEE_BOT_TOKEN` = the current Discord bot token
	- `ACE_DISCORD_COMMITTEE_GUILD_ID` = the Discord server ID
	Enter both values directly in Google; do not put the token in a sheet cell, README, or chat.
5. In Apps Script, use **Project Settings → Script Properties → Add script property** to add `ACE_DISCORD_COMMITTEE_BOT_TOKEN` with the bot token and `ACE_DISCORD_COMMITTEE_GUILD_ID` with the Discord server ID. Press **Save script properties**. Do not paste the token in chat or a sheet.
6. At the top editor toolbar, choose `syncDiscordCommitteeRolesNow` from the function dropdown and click **Run**. The first run asks for authorization: select the organization account, review the requested scopes, and click **Allow**. It fetches the current server roster, adds `Discord User ID` and `Discord Nickname` headers if needed, exact-matches unique names, updates committees, clears committees for linked users with no approved role, and logs unmatched approved-role members. Check **Executions** for the result; do not install the trigger until this one-time run succeeds.
7. Choose `getDiscordCommitteeSyncStatus` and click **Run**. Confirm it reports `configured: true`; it never returns the token.
8. Choose `installDiscordCommitteeSyncTrigger` and click **Run**. Approve any additional authorization prompt. It verifies Discord access, deletes duplicate triggers owned by this same account, and creates one five-minute trigger.
9. In the Apps Script editor's left sidebar, click **Triggers** (clock icon). Confirm there is one trigger for `syncDiscordCommitteeRolesFromTrigger`, event source **Time-driven**, type **Minutes timer**, interval **Every 5 minutes**.
10. Wait for a trigger run, then use `getDiscordCommitteeSyncStatus` or the **Executions** page to confirm a recent `lastSuccess` and no `lastError`. Test one committee-role change and check the sheet after the next run.
11. Only after that test succeeds, stop/remove the temporary Mac LaunchAgent. The Apps Script trigger runs on Google's servers; no computer needs to remain awake.

#### Historical Apps Script trigger ownership and limits

- Triggers are per-creator account, run as that account, and are not automatically transferred when project ownership changes. When the responsible account changes, the successor must be an Apps Script editor, add/verify the two Script Properties, run `installDiscordCommitteeSyncTrigger` from their account, verify it, then the former trigger owner should run `removeDiscordCommitteeSyncTrigger` from their account.
- Current published Apps Script limits list 90 minutes of trigger runtime/day for consumer accounts and 6 hours/day for Workspace accounts, with a 6-minute maximum per execution. At 288 five-minute runs/day, a consumer account averages at most about 18.75 seconds per run before reaching the 90-minute daily cap. Check **Executions** after enabling; if typical runs approach that threshold, use a 10-minute trigger or an organization Workspace account.
- Google can change quotas, and triggers can be delayed or fail. Apps Script sends failure notices to the trigger creator. Check the Apps Script **Executions** page periodically.
- The existing `https://www.googleapis.com/auth/script.external_request` scope allows Discord API requests. The manifest also includes `script.scriptapp` for trigger management.

## Organization ownership and optional paid Render alternative

The Mac LaunchAgent is temporary and depends on one officer's Mac and login. For a durable handoff, the organization should control the source repository, Discord application, Google Cloud project/service account, Render account, billing, and recovery contacts. Give at least two current officers administrator access to every one of these systems.

### 1. Create a private, bot-only GitHub organization repository

Do not upload the entire ACE Portal project for this bot deployment. The portal repository contains unrelated files and may contain operational data. Make a private repository containing only the contents of this `discord-bot` folder; do not include `.env`, `node_modules`, downloaded Google JSON keys, or `unmatched-members.csv`.

1. Sign in to GitHub using an account that belongs to the organization's GitHub organization.
2. Click the profile icon (upper right) → **Your organizations** → open the organization's page.
3. Click **Repositories** → **New repository**.
4. Set **Owner** to the organization, name it `ace-discord-committee-sync`, select **Private**, and click **Create repository**.
5. Add at least one other continuing officer as an organization/repository owner or administrator. Confirm that officer can sign in and open the private repo.
6. Upload the bot source files from this folder only: `src/`, `package.json`, `package-lock.json`, `render.yaml`, `.gitignore`, and `README.md`. Use **Add file → Upload files**, then commit. `.env` is deliberately excluded by `.gitignore`; never upload secrets.

### 2. Put Discord bot ownership under the organization

Discord applications belong to Discord accounts/teams, not GitHub. Ensure at least two continuing officers can manage the application and reset its token.

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and sign in with the account that owns `ACE Committee Sync`.
2. Select the application → **General Information** and record its name/application ID in the organization's private runbook.
3. Under **Bot**, reset the token during the ownership handoff; copy the new token directly into the hosting provider later. Do not put it in GitHub or the runbook.
4. On **Bot**, confirm **Server Members Intent** is enabled.
5. Add the second officer through the application's team/access controls if available. If the application is not team-owned and cannot be transferred to an organization-controlled team, create a replacement application owned by a shared organization-controlled account, invite the replacement bot to the server, and test it before retiring the old one.
6. In the Discord server, use **Server Settings → Roles** to ensure the bot role is high enough to see server members. The bot only reads member roles; it does not need permission to manage roles.

### 3. Make Google Sheets access organization-owned

The bot needs a Google service account shared on the spreadsheet. The organization should own the Cloud project and control key rotation.

1. Sign into an organization-controlled Google account and open [Google Cloud Console](https://console.cloud.google.com/).
2. Select the organization's Cloud project. Open **APIs & Services → Enabled APIs & services** and confirm **Google Sheets API** is enabled.
3. Open **☰ → IAM & Admin → Service Accounts**. Create an organization-owned service account if the current one is controlled by a departing officer.
4. If creating a key is permitted, open the service account → **Keys → Add key → Create new key → JSON**. Store that downloaded JSON securely in the organization's password manager or secret store; do not upload it to GitHub or this chat.
5. In the Google Sheet, click **Share**, add the service-account email, and grant **Editor**. Confirm the service account can access the spreadsheet.
6. Record the Cloud project owner and key-rotation procedure in the private runbook, but never record the private-key value there.

### 4. Create a Render Cron Job that syncs every five minutes

A Cron Job fits if a short delay is acceptable: each scheduled run connects to Discord, fetches the current member roles, updates changed sheet rows, and exits. It does not need a persistent Discord connection or Redis. A role change should appear on the next successful run, normally within five minutes. If a run fails or Render is unavailable, the following run reconciles to current roles.

This is **not completely free**. Render's current Cron Job documentation sets a **$1/month minimum per Cron Job**. A Hobby workspace has no base subscription fee; compute is billed by run duration, with the $1 minimum likely applying to this small job. There is no $10 Redis service and no always-on Background Worker charge. Confirm the amount Render shows before deploying, since prices may change.

1. Sign into [Render](https://dashboard.render.com/) using an organization-controlled account. Use a **Hobby** workspace (no workspace base fee) and invite a second officer through **Workspace Settings → Members**.
2. Click **New + → Blueprint**.
3. If prompted, click **Configure account** and authorize Render to access the private organization repo `ace-discord-committee-sync`.
4. Select its default branch and click **Apply**. The Blueprint should preview `ace-discord-committee-sync` with service type **Cron Job**.
5. Confirm the schedule reads `*/5 * * * *` and the command is `npm run sync-all`. This runs every five minutes in UTC. Do not use `npm start`; that is the local persistent listener.
6. In the environment-variable fields, enter `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and `GOOGLE_PRIVATE_KEY`; set `MEMBERS_SHEET_NAME` to `Members`. Enter secrets only in Render, not in GitHub or `render.yaml`. Paste the entire private key; the program handles literal `\\n` sequences.
7. Review the compute price and the $1/month minimum. Continue only if the organization approves the displayed billing, then click **Apply/Deploy**.
8. Open the Cron Job's **Runs** page and select the latest run to inspect its logs. Confirm it finishes successfully and prints `Initial sync complete`.
9. Change one test member's approved Discord role. Wait for the next successful run and confirm the sheet's Committee value changes. A member previously linked by Discord ID who has no approved roles will have Committee cleared. Members with no approved role and no saved Discord ID are ignored.
10. Once the hosted run is verified, stop the Mac LaunchAgent as described below. Cron runs are short-lived, so leave only the scheduled Render service active.

### 5. Verify handoff and remove personal dependencies

Before you leave, have the next officer sign into GitHub, Discord Developer Portal, Google Cloud, the Google Sheet, and Render from their own account and demonstrate they can view Cron Job runs/logs and manage access. Confirm the organization owns billing and recovery email/2FA. Rotate any credential that was ever exposed, store active secrets only in Render, and revoke superseded keys/tokens. Keep the private runbook focused on owners, links, billing contact, redeploy, log access, and rotation steps—not secret values.

After scheduled Render sync is verified, the account that installed the local LaunchAgent can stop and remove it:

```sh
launchctl bootout "gui/$(id -u)/com.ace.discord-committee-sync"
rm "$HOME/Library/LaunchAgents/com.ace.discord-committee-sync.plist"
```

Do not remove your access or delete an account/credential until the successor has verified that the organization-owned scheduled sync works. This transfers the Discord committee-sync service; the Apps Script portal, spreadsheet, and Drive files also need their own organization ownership/admin handoff.