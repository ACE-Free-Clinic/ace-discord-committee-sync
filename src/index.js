require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { google } = require('googleapis');

const ROLE_MAP = new Map([
  ['Board Members', 'Board'],
  ['Clinical', 'Clinical'],
  ['Finance', 'Finance'],
  ['Health Education', 'Health Education'],
  ['Internal Affairs', 'Internal Affairs'],
  ['Mental Health', 'Mental Health'],
  ['Nutrition', 'Nutrition'],
  ['Social Outreach', 'Social Outreach'],
  ["Women's Health", "Women's Health"]
]);

const STATUS_FLAG_SNAPSHOT_HEADER = 'Discord Status Flag Snapshot';
const DISCORD_MEMBER_HEADERS = [
  'Discord User ID',
  'Discord Username',
  'Discord Global Name',
  'Discord Nickname',
  STATUS_FLAG_SNAPSHOT_HEADER
];
const MEMBER_HEADERS = ['Committee', ...DISCORD_MEMBER_HEADERS];
const MATCH_REVIEW_HEADERS = [
  'Record Type', 'Discord User ID', 'Discord Username', 'Discord Global Name',
  'Discord Server Nickname', 'Discord Roles', 'Portal UID', 'Portal Name',
  'Portal Status', 'Match Status', 'Last Seen UTC'
];
const MATCH_REVIEW_SHEET_NAME = 'Discord_Match_Review';
const DISCORD_STATUS_ROLE_NAMES = {
  active: 'Active Member',
  inactive: 'Inactive Member',
  flag: 'Status Flag',
  alumni: 'Alumni <3'
};
const config = {
  token: process.env.DISCORD_BOT_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID,
  spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
  serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  privateKey: String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  membersSheetName: process.env.MEMBERS_SHEET_NAME || 'Members',
  statusRoleSyncEnabled: String(process.env.DISCORD_ROLE_SYNC_ENABLED || '').trim().toLowerCase() === 'true',
  statusRoleTestUserId: String(process.env.DISCORD_STATUS_ROLE_TEST_USER_ID || '').trim()
};

function requireConfig() {
  const missing = Object.entries({
    DISCORD_BOT_TOKEN: config.token,
    DISCORD_GUILD_ID: config.guildId,
    GOOGLE_SPREADSHEET_ID: config.spreadsheetId,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: config.serviceAccountEmail,
    GOOGLE_PRIVATE_KEY: config.privateKey
  }).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

function createSheetsClient() {
  const auth = new google.auth.JWT({
    email: config.serviceAccountEmail,
    key: config.privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

async function loadMembersSheet(sheets, sheetName = config.membersSheetName) {
  const range = `'${sheetName.replace(/'/g, "''")}'!A:ZZ`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range });
  const values = response.data.values || [];
  if (!values.length) throw new Error(`Sheet ${sheetName} has no header row.`);
  return { values, headers: values[0].map(value => String(value || '').trim()) };
}

async function ensureHeaders(sheets, headers, sheetName = config.membersSheetName) {
  const loaded = await loadMembersSheet(sheets, sheetName);
  const missing = headers.filter(header => !loaded.headers.some(existing => existing.toLowerCase() === header.toLowerCase()));
  if (!missing.length) return loaded;

  const startColumn = loaded.headers.length;
  const endColumn = startColumn + missing.length;
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(columnCount)))'
  });
  const sheetProperties = (metadata.data.sheets || []).map(sheet => sheet.properties).find(properties => properties.title === sheetName);
  if (!sheetProperties) throw new Error(`Could not find sheet tab ${sheetName}.`);
  const currentColumnCount = Number(sheetProperties.gridProperties?.columnCount || 0);
  const columnsToAppend = Math.max(0, endColumn - currentColumnCount);
  if (columnsToAppend > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { requests: [{ appendDimension: { sheetId: sheetProperties.sheetId, dimension: 'COLUMNS', length: columnsToAppend } }] }
    });
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName.replace(/'/g, "''")}'!${columnLetter(startColumn + 1)}1:${columnLetter(endColumn)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [missing] }
  });
  return loadMembersSheet(sheets, sheetName);
}

async function loadOptionalSheet(sheets, sheetName) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: 'sheets(properties(title))'
  });
  if (!(metadata.data.sheets || []).some(sheet => sheet.properties?.title === sheetName)) return null;
  return loadMembersSheet(sheets, sheetName);
}

async function ensureSheetTab(sheets, sheetName, headers) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: 'sheets(properties(title))'
  });
  const exists = (metadata.data.sheets || []).some(sheet => sheet.properties?.title === sheetName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
    });
  }
  let loaded;
  try {
    loaded = await loadMembersSheet(sheets, sheetName);
  } catch (_) {
    loaded = { values: [], headers: [] };
  }
  if (!loaded.headers.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `'${sheetName.replace(/'/g, "''")}'!A1:${columnLetter(headers.length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
  }
  return loadMembersSheet(sheets, sheetName);
}

function getHeaderIndex(headers, name) {
  return headers.findIndex(header => header.toLowerCase() === name.toLowerCase());
}

function getCommitteeFromMember(member) {
  const approvedRoles = new Set(member.roles.cache.map(role => role.name).filter(roleName => ROLE_MAP.has(roleName)));
  const committees = [];
  for (const roleName of ROLE_MAP.keys()) if (approvedRoles.has(roleName)) committees.push(ROLE_MAP.get(roleName));
  return committees.length ? committees.join(', ') : null;
}

function getMemberNickname(member) {
  return String(member.nickname || member.user.globalName || member.user.username || '').trim();
}

function getDiscordIdentity(member) {
  return {
    id: String(member.id),
    username: String(member.user.username || ''),
    globalName: String(member.user.globalName || ''),
    nickname: String(member.nickname || '')
  };
}

function normalizeName(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function findMemberRow(loaded, member) {
  const uidIndex = getHeaderIndex(loaded.headers, 'Discord User ID');
  const firstNameIndex = getHeaderIndex(loaded.headers, 'First Name');
  const lastNameIndex = getHeaderIndex(loaded.headers, 'Last Name');
  const idMatch = loaded.values.slice(1).findIndex(row => String(row[uidIndex] || '').trim() === member.id);
  if (idMatch >= 0) return { rowIndex: idMatch + 2, matchedBy: 'id' };
  if (firstNameIndex < 0 || lastNameIndex < 0) return null;
  const candidates = [member.nickname, member.user.globalName].map(normalizeName).filter(Boolean);
  const matches = [];
  loaded.values.slice(1).forEach((row, index) => {
    const name = normalizeName(`${row[firstNameIndex] || ''} ${row[lastNameIndex] || ''}`);
    if (name && candidates.includes(name)) matches.push(index + 2);
  });
  return matches.length === 1 ? { rowIndex: matches[0], matchedBy: 'name' } : null;
}

async function updateMemberRow(sheets, loaded, member, batchWrites = null) {
  const committee = getCommitteeFromMember(member);
  const nicknameIndex = getHeaderIndex(loaded.headers, 'Discord Nickname');
  const usernameIndex = getHeaderIndex(loaded.headers, 'Discord Username');
  const globalNameIndex = getHeaderIndex(loaded.headers, 'Discord Global Name');
  const committeeIndex = getHeaderIndex(loaded.headers, 'Committee');
  const discordIdIndex = getHeaderIndex(loaded.headers, 'Discord User ID');
  const statusIndex = getHeaderIndex(loaded.headers, 'Status');
  const match = committee ? findMemberRow(loaded, member) : (() => {
    const index = loaded.values.slice(1).findIndex(row => String(row[discordIdIndex] || '').trim() === member.id);
    return index >= 0 ? { rowIndex: index + 2, matchedBy: 'id' } : null;
  })();
  if (!committee && !match) return { updated: false, ignored: true, userId: member.id };
  if (!match) return { updated: false, unmatched: true, userId: member.id, nickname: getMemberNickname(member), committee };

  const rowIndex = match.rowIndex;
  const row = (loaded.values[rowIndex - 1] || []).slice();
  while (row.length < loaded.headers.length) row.push('');
  const identity = getDiscordIdentity(member);
  const inactive = String(statusIndex >= 0 ? row[statusIndex] || '' : '').trim().toLowerCase() === 'inactive';
  const changes = String(row[discordIdIndex] || '').trim() !== identity.id
    || String(row[nicknameIndex] || '').trim() !== identity.nickname
    || String(usernameIndex >= 0 ? row[usernameIndex] || '' : '').trim() !== identity.username
    || String(globalNameIndex >= 0 ? row[globalNameIndex] || '' : '').trim() !== identity.globalName
    || (!inactive && String(row[committeeIndex] || '').trim() !== (committee || ''));
  if (!changes) return { updated: false, unchanged: true, matchedBy: match.matchedBy, userId: member.id, nickname: identity.nickname, committee };
  row[discordIdIndex] = identity.id;
  row[nicknameIndex] = identity.nickname;
  if (usernameIndex >= 0) row[usernameIndex] = identity.username;
  if (globalNameIndex >= 0) row[globalNameIndex] = identity.globalName;
  if (!inactive) row[committeeIndex] = committee || '';
  const write = { range: `${config.membersSheetName}!A${rowIndex}:${columnLetter(loaded.headers.length)}${rowIndex}`, values: [row] };
  if (batchWrites) batchWrites.push(write);
  else await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId, range: write.range, valueInputOption: 'RAW', requestBody: { values: write.values }
  });
  return { updated: true, matchedBy: match.matchedBy, userId: member.id, nickname: identity.nickname, committee: committee || '' };
}

function columnLetter(number) {
  let result = '';
  for (let current = number; current > 0; current = Math.floor((current - 1) / 26)) {
    result = String.fromCharCode(65 + ((current - 1) % 26)) + result;
  }
  return result;
}

async function syncMember(member) {
  const sheets = createSheetsClient();
  return updateMemberRow(sheets, await ensureHeaders(sheets, MEMBER_HEADERS), member);
}

function buildPortalRecords(loaded, sheetName) {
  const uidIndex = getHeaderIndex(loaded.headers, 'UID');
  const firstIndex = getHeaderIndex(loaded.headers, 'First Name');
  const lastIndex = getHeaderIndex(loaded.headers, 'Last Name');
  const statusIndex = getHeaderIndex(loaded.headers, 'Status');
  const discordIndex = getHeaderIndex(loaded.headers, 'Discord User ID');
  return loaded.values.slice(1).map((row, index) => ({
    loaded, sheetName, rowIndex: index + 2, row,
    uid: String(row[uidIndex] || '').trim(),
    name: `${row[firstIndex] || ''} ${row[lastIndex] || ''}`.trim(),
    status: String(row[statusIndex] || '').trim(),
    discordId: String(row[discordIndex] || '').trim(),
    isArchived: sheetName === 'Archived_Members'
  })).filter(record => record.uid);
}

function setRowValue(row, headers, name, value) {
  const index = getHeaderIndex(headers, name);
  if (index >= 0) row[index] = value;
}

function suggestPortalRecord(records, member) {
  const names = [member.nickname, member.user.globalName].map(normalizeName).filter(Boolean);
  const matches = records.filter(record => !record.discordId && names.includes(normalizeName(record.name)));
  return matches.length === 1 ? matches[0] : null;
}

function getPortalStatusRolePlan(statusValue, isArchived, snapshotValue, currentlyHasStatusFlag, hasAlumniRole = false) {
  const status = String(statusValue || '').trim().toLowerCase();
  const snapshot = String(snapshotValue || '').trim().toLowerCase();
  if (hasAlumniRole) return { alumni: true, inactive: false, snapshotToSave: '', preserveStatusFlag: true, shouldHaveStatusFlag: Boolean(currentlyHasStatusFlag) };
  const inactive = Boolean(isArchived) || status === 'inactive';
  if (inactive) return {
    inactive: true,
    snapshotToSave: snapshot ? '' : (currentlyHasStatusFlag ? 'Yes' : 'No'),
    preserveStatusFlag: snapshot === 'yes' || (!snapshot && currentlyHasStatusFlag),
    shouldHaveStatusFlag: snapshot === 'yes' || (!snapshot && currentlyHasStatusFlag)
  };
  return { inactive: false, snapshotToSave: '', preserveStatusFlag: false, shouldHaveStatusFlag: status === 'probation' || snapshot === 'yes' };
}

function shouldSyncStatusRoleForUser(discordUserId, testUserId) {
  const testId = String(testUserId || '').trim();
  return !testId || String(discordUserId || '').trim() === testId;
}

async function reconcilePortalStatusRole(sheets, member, record, row, roles) {
  const snapshotIndex = getHeaderIndex(record.loaded.headers, STATUS_FLAG_SNAPSHOT_HEADER);
  const snapshotValue = String(snapshotIndex >= 0 ? row[snapshotIndex] || '' : '').trim();
  const hasFlag = member.roles.cache.has(roles.flag.id);
  const plan = getPortalStatusRolePlan(record.status, record.isArchived, snapshotValue, hasFlag, member.roles.cache.has(roles.alumni.id));
  if (plan.alumni) {
    if (member.roles.cache.has(roles.inactive.id)) await member.roles.remove(roles.inactive, 'ACE Portal alumni are not inactive');
    return;
  }
  if (plan.inactive) {
    if (plan.snapshotToSave && snapshotIndex >= 0) {
      row[snapshotIndex] = plan.snapshotToSave;
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${record.sheetName.replace(/'/g, "''")}'!${columnLetter(snapshotIndex + 1)}${record.rowIndex}`,
        valueInputOption: 'RAW', requestBody: { values: [[row[snapshotIndex]]] }
      });
    }
    const failures = [];
    for (const role of member.roles.cache.values()) {
      if (role.id === member.guild.id || role.id === roles.inactive.id || (plan.preserveStatusFlag && role.id === roles.flag.id)) continue;
      if (role.managed || !role.editable) { failures.push(role.name); continue; }
      try { await member.roles.remove(role, 'ACE Portal member inactive or archived'); }
      catch (_) { failures.push(role.name); }
    }
    if (!member.roles.cache.has(roles.inactive.id)) await member.roles.add(roles.inactive, 'ACE Portal member inactive or archived');
    if (!plan.preserveStatusFlag && member.roles.cache.has(roles.flag.id)) await member.roles.remove(roles.flag, 'ACE Portal inactive status flag policy');
    if (failures.length) console.warn(`Could not remove non-editable roles from ${member.id}: ${failures.join(', ')}`);
    return;
  }
  if (member.roles.cache.has(roles.inactive.id)) await member.roles.remove(roles.inactive, 'ACE Portal member active or probation');
  if (!member.roles.cache.has(roles.active.id)) await member.roles.add(roles.active, 'ACE Portal member active or probation');
  if (plan.shouldHaveStatusFlag && !member.roles.cache.has(roles.flag.id)) await member.roles.add(roles.flag, 'ACE Portal probation or restored status flag');
  else if (!plan.shouldHaveStatusFlag && member.roles.cache.has(roles.flag.id)) await member.roles.remove(roles.flag, 'ACE Portal member active status');
  if (snapshotIndex >= 0 && snapshotValue) row[snapshotIndex] = '';
}

async function writeMatchReviewSheet(sheets, rows) {
  const loaded = await ensureSheetTab(sheets, MATCH_REVIEW_SHEET_NAME, MATCH_REVIEW_HEADERS);
  const values = [MATCH_REVIEW_HEADERS, ...rows];
  if (loaded.values.length > values.length) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: config.spreadsheetId,
      range: `'${MATCH_REVIEW_SHEET_NAME}'!A${values.length + 1}:K${loaded.values.length}`
    });
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `'${MATCH_REVIEW_SHEET_NAME}'!A1:K${values.length}`,
    valueInputOption: 'RAW', requestBody: { values }
  });
}

async function syncAll(guild) {
  await guild.members.fetch();
  const sheets = createSheetsClient();
  const activeName = config.membersSheetName;
  const active = await ensureHeaders(sheets, MEMBER_HEADERS, activeName);
  const archivedName = 'Archived_Members';
  let archived = await loadOptionalSheet(sheets, archivedName);
  if (archived) archived = await ensureHeaders(sheets, DISCORD_MEMBER_HEADERS, archivedName);

  let roles = null;
  if (config.statusRoleSyncEnabled) {
    const botMember = guild.members.me || await guild.members.fetchMe();
    if (!botMember.permissions.has('ManageRoles')) throw new Error('The bot needs Manage Roles permission to synchronize portal status roles.');
    const discordRoles = await guild.roles.fetch();
    roles = {};
    for (const [key, name] of Object.entries(DISCORD_STATUS_ROLE_NAMES)) {
      const role = discordRoles.find(candidate => candidate.name === name);
      if (!role) throw new Error(`Required Discord role not found: ${name}`);
      if (key !== 'alumni' && !role.editable) throw new Error(`The bot cannot manage Discord role "${name}". Move the bot role above it and verify Manage Roles.`);
      roles[key] = role;
    }
    if (config.statusRoleTestUserId) console.log(`Status-role sync restricted to test user ${config.statusRoleTestUserId}.`);
  } else console.log('Discord status-role changes are disabled; set DISCORD_ROLE_SYNC_ENABLED=true after verifying roles and permissions.');

  const records = buildPortalRecords(active, activeName).concat(archived ? buildPortalRecords(archived, archivedName) : []);
  const recordsById = new Map();
  for (const record of records) if (record.discordId) recordsById.set(record.discordId, [...(recordsById.get(record.discordId) || []), record]);
  const writes = new Map([[activeName, new Map()]]);
  const sheetsByName = new Map([[activeName, active]]);
  if (archived) { writes.set(archivedName, new Map()); sheetsByName.set(archivedName, archived); }
  const results = [];
  const reviewRows = [];
  const matchedUids = new Set();
  const seenIds = new Set();

  for (const member of guild.members.cache.values()) {
    const id = String(member.id);
    seenIds.add(id);
    const identity = getDiscordIdentity(member);
    const committee = getCommitteeFromMember(member);
    const existing = recordsById.get(id) || [];
    let record = existing.length === 1 ? existing[0] : null;
    let matchedBy = record ? 'id' : '';
    if (!existing.length) {
      record = suggestPortalRecord(records, member);
      if (record) matchedBy = 'unique-name';
    }
    if (existing.length > 1) results.push({ unmatched: true, userId: id, nickname: getMemberNickname(member), committee, reason: 'Discord ID appears on multiple portal rows' });

    if (record) {
      const oldRow = (record.loaded.values[record.rowIndex - 1] || []).slice();
      const row = record.row.slice();
      while (row.length < record.loaded.headers.length) row.push('');
      setRowValue(row, record.loaded.headers, 'Discord User ID', id);
      setRowValue(row, record.loaded.headers, 'Discord Username', identity.username);
      setRowValue(row, record.loaded.headers, 'Discord Global Name', identity.globalName);
      setRowValue(row, record.loaded.headers, 'Discord Nickname', identity.nickname);
      const inactive = record.isArchived || record.status.toLowerCase() === 'inactive';
      if (!inactive && record.sheetName === activeName && committee) setRowValue(row, record.loaded.headers, 'Committee', committee);
      record.row = row;
      record.discordId = id;
      if (roles && shouldSyncStatusRoleForUser(id, config.statusRoleTestUserId)) {
        try { await reconcilePortalStatusRole(sheets, member, record, row, roles); }
        catch (error) { console.error(`Status-role sync failed for ${id}: ${error.message || error}`); results.push({ roleError: true, userId: id }); }
      }
      if (row.some((value, index) => String(value ?? '') !== String(oldRow[index] ?? ''))) writes.get(record.sheetName).set(record.rowIndex, row);
      results.push({ updated: true, matchedBy, userId: id, nickname: identity.nickname, committee: committee || '' });
      matchedUids.add(record.uid);
    } else {
      results.push({ unmatched: true, userId: id, nickname: getMemberNickname(member), committee, reason: existing.length > 1 ? 'Duplicate linked ID' : 'No portal match' });
    }

    const suggestion = record || suggestPortalRecord(records, member);
    reviewRows.push([
      'Discord Member', id, identity.username, identity.globalName, identity.nickname,
      member.roles.cache.map(role => role.name).filter(name => name !== '@everyone').join(', '),
      suggestion?.uid || '', suggestion?.name || '', suggestion?.isArchived ? 'Archived' : (suggestion?.status || ''),
      record ? `Linked by ${matchedBy}` : (suggestion ? 'Suggested match - review' : 'Unmatched'), new Date().toISOString()
    ]);
  }

  for (const record of records) {
    if (matchedUids.has(record.uid)) continue;
    if (!record.discordId) reviewRows.push(['Portal Member', '', '', '', '', '', record.uid, record.name, record.isArchived ? 'Archived' : record.status, 'Needs Discord link', new Date().toISOString()]);
    else if (!seenIds.has(record.discordId)) {
      const read = name => { const index = getHeaderIndex(record.loaded.headers, name); return index >= 0 ? String(record.row[index] || '').trim() : ''; };
      reviewRows.push(['Portal Member', record.discordId, read('Discord Username'), read('Discord Global Name'), read('Discord Nickname'), '', record.uid, record.name, record.isArchived ? 'Archived' : record.status, 'Saved Discord ID not found in server roster', new Date().toISOString()]);
    }
  }

  for (const [sheetName, rowWrites] of writes.entries()) {
    const loaded = sheetsByName.get(sheetName);
    const data = [];
    for (const [rowIndex, row] of rowWrites.entries()) {
      const original = loaded.values[rowIndex - 1] || [];
      row.forEach((value, index) => {
        if (String(value ?? '') !== String(original[index] ?? '')) data.push({ range: `'${sheetName.replace(/'/g, "''")}'!${columnLetter(index + 1)}${rowIndex}`, values: [[value]] });
      });
    }
    if (data.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: config.spreadsheetId, requestBody: { valueInputOption: 'RAW', data } });
  }
  await writeMatchReviewSheet(sheets, reviewRows);

  const summary = results.reduce((counts, item) => {
    const key = item.roleError ? 'roleErrors' : item.updated ? 'updated' : item.unmatched ? 'unmatched' : 'unchanged';
    counts[key]++;
    if (item.matchedBy === 'name') counts.nameMatched++;
    return counts;
  }, { updated: 0, unchanged: 0, unmatched: 0, roleErrors: 0, nameMatched: 0 });
  console.log(`Initial sync complete: ${JSON.stringify(summary)}`);
  const unmatched = results.filter(item => item.unmatched);
  const escapeCsv = value => `"${String(value || '').replace(/"/g, '""')}"`;
  const report = [['Discord User ID', 'Discord Nickname', 'Mapped Committee', 'Reason'], ...unmatched.map(item => [item.userId, item.nickname, item.committee, item.reason || 'No portal match'])]
    .map(row => row.map(escapeCsv).join(',')).join('\n');
  const reportPath = path.join(__dirname, '..', 'unmatched-members.csv');
  fs.writeFileSync(reportPath, `${report}\n`, 'utf8');
  if (unmatched.length) unmatched.forEach(item => console.log(`Unmatched: ${item.nickname || '(no nickname)'} | ${item.userId} | ${item.committee}`));
  else console.log('All approved-role members matched a Members row.');
}

async function main() {
  requireConfig();
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  client.once(Events.ClientReady, async readyClient => {
    try {
      console.log(`Discord committee sync logged in as ${readyClient.user.tag}`);
      const guild = await readyClient.guilds.fetch(config.guildId);
      if (process.argv.includes('--sync-all')) {
        await syncAll(guild);
        await readyClient.destroy();
      }
    } catch (error) {
      console.error(`Startup sync failed: ${error.message || error}`);
      await readyClient.destroy();
      process.exitCode = 1;
    }
  });
  client.on(Events.GuildMemberUpdate, async (_oldMember, newMember) => {
    try {
      const result = await syncMember(newMember);
      if (result.updated) console.log(`Updated ${result.userId}: ${result.committee}`);
    } catch (error) {
      console.error(`Member sync failed for ${newMember.id}:`, error);
    }
  });
  await client.login(config.token);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { getPortalStatusRolePlan, normalizeName, shouldSyncStatusRoleForUser, suggestPortalRecord };
