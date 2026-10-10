# ACE Discord Committee Sync

Syncs approved Discord roles into the ACE Portal `Members` sheet. GitHub Actions runs the cloud sync every 15 minutes; no Mac or paid hosting service is required.

## Committee mapping

| Discord role | Members sheet value |
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

Members with multiple approved committee roles receive comma-separated committee names. Existing Discord User ID links are authoritative. Initial auto-linking only uses exact, unique matches between portal name and Discord server nickname/global name; ambiguous matches are never auto-linked.

## Portal status and Discord roles

| Portal state | Discord roles managed by the sync |
| --- | --- |
| Active | `Active Member`; remove `Inactive Member` and `Status Flag` unless restoring a saved flag |
| Probation | `Active Member` + `Status Flag`; remove `Inactive Member` |
| Inactive or archived | Add `Inactive Member`; remove all other roles the bot can remove except a previously present `Status Flag` |
| Has `Alumni <3` | Alumni, not inactive: roles are left untouched and `Inactive Member` is removed if present. The portal archives the member automatically within about an hour of the next sync |
| Reactivated/restored | Remove `Inactive Member`, add `Active Member`, restore saved `Status Flag`; committee roles are not automatically restored |

The bot records whether `Status Flag` existed before deactivation so repeated runs do not lose its restoration state. Discord-managed roles, `@everyone`, and roles at/above the bot's highest role cannot be changed. The bot needs **Manage Roles**, and its role must be above `Active Member`, `Inactive Member`, `Status Flag`, committee roles, and all roles intended for removal. Because inactive processing removes every role the bot can manage, test with one non-admin member first.

### Safety gate and rollout

Status-role changes are disabled unless GitHub Actions variable `DISCORD_ROLE_SYNC_ENABLED` is set to `true`. The sync can still update committee data and refresh the review sheet while this is off.

1. In GitHub repo **Settings → Secrets and variables → Actions → Variables**, leave `DISCORD_ROLE_SYNC_ENABLED` unset/false initially.
2. Run **Actions → Discord committee sync → Run workflow**. This syncs the roster and creates/refreshes `Discord_Match_Review` without changing status roles.
3. Verify the three exact Discord role names and the bot's Manage Roles/hierarchy settings.
4. Set `DISCORD_STATUS_ROLE_TEST_USER_ID` to one non-admin test member's Discord ID and set `DISCORD_ROLE_SYNC_ENABLED` to `true`.
5. Test Active, Probation, Inactive, and restore behavior on that one linked person.
6. When satisfied, clear `DISCORD_STATUS_ROLE_TEST_USER_ID`; status-role sync then applies to all linked portal members.

## Discord account matching

Each successful scheduled sync refreshes `Discord_Match_Review` with Discord ID, username, global name, server nickname, current roles, suggestions, and last-seen time. It also lists portal rows without links and saved IDs no longer found in the guild.

President/Dev admins can use **Admin Tools → Member Database → Match Discord Accounts** in the portal to search and link active or archived portal records. The UI displays all Discord identifiers and roles and asks for confirmation. Existing links can be explicitly replaced; replacements are audited in `Discord_Match_Audit`. A Discord ID already linked to another portal UID is rejected. A subsequent cloud sync reconciles the linked member.

## GitHub Actions and secrets

The workflow is `.github/workflows/committee-sync.yml`. It runs every 15 minutes (`*/15 * * * *`, UTC; GitHub may delay scheduled starts) and can be manually dispatched. Standard GitHub-hosted runners are free for public repositories; source is public, secrets remain in Actions secret storage.

Add these **Repository secrets** under **Settings → Secrets and variables → Actions**:

- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`
- `GOOGLE_SPREADSHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`

The Google service account needs Editor access to the spreadsheet and the Google Sheets API enabled. Never commit `.env`, credential JSON, private keys, or secret values. `.gitignore` excludes `.env`, `node_modules/`, and `unmatched-members.csv`.

To change the interval, edit the workflow cron expression and commit. Examples: `*/5 * * * *` every 5 minutes; `*/30 * * * *` every 30 minutes; `0 * * * *` hourly. Keep it at least 5 minutes.

## Local testing

Copy `.env.example` to `.env`, configure it privately, run `npm install`, then `npm test` for policy tests or `npm run sync-all` for a live sync. `npm start` is the persistent local listener and is not needed for cloud production.
