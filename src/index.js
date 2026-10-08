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

const REQUIRED_HEADERS = ['Discord User ID', 'Discord Nickname'];
const MEMBER_HEADERS = ['Committee', ...REQUIRED_HEADERS];
const config = {
  token: process.env.DISCORD_BOT_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID,
  spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
  serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  privateKey: String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  membersSheetName: process.env.MEMBERS_SHEET_NAME || 'Members'
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

async function loadMembersSheet(sheets) {
  const range = `${config.membersSheetName}!A:ZZ`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range });
  const values = response.data.values || [];
  if (!values.length) throw new Error(`Sheet ${config.membersSheetName} has no header row.`);
  return { values, headers: values[0].map(value => String(value || '').trim()) };
}

async function ensureHeaders(sheets, headers) {
  const loaded = await loadMembersSheet(sheets);
  const missing = headers.filter(header => !loaded.headers.some(existing => existing.toLowerCase() === header.toLowerCase()));
  if (!missing.length) return loaded;

  const startColumn = loaded.headers.length;
  const endColumn = startColumn + missing.length;
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(columnCount)))'
  });
  const sheetProperties = (metadata.data.sheets || [])
    .map(sheet => sheet.properties)
    .find(properties => properties.title === config.membersSheetName);
  if (!sheetProperties) throw new Error(`Could not find sheet tab ${config.membersSheetName}.`);

  const currentColumnCount = Number(sheetProperties.gridProperties?.columnCount || 0);
  const columnsToAppend = Math.max(0, endColumn - currentColumnCount);
  if (columnsToAppend > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        requests: [{
          appendDimension: {
            sheetId: sheetProperties.sheetId,
            dimension: 'COLUMNS',
            length: columnsToAppend
          }
        }]
      }
    });
  }

  const columnLetters = (number) => {
    let result = '';
    let current = number;
    while (current > 0) {
      const remainder = (current - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      current = Math.floor((current - 1) / 26);
    }
    return result;
  };
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `${config.membersSheetName}!${columnLetters(startColumn + 1)}1:${columnLetters(endColumn)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [missing] }
  });
  return loadMembersSheet(sheets);
}

function getHeaderIndex(headers, name) {
  return headers.findIndex(header => header.toLowerCase() === name.toLowerCase());
}

function getCommitteeFromMember(member) {
  const approvedRoles = new Set(member.roles.cache
    .map(role => role.name)
    .filter(roleName => ROLE_MAP.has(roleName)));
  const committees = [];
  for (const roleName of ROLE_MAP.keys()) {
    if (approvedRoles.has(roleName)) committees.push(ROLE_MAP.get(roleName));
  }
  return committees.length ? committees.join(', ') : null;
}

function getMemberNickname(member) {
  return String(member.nickname || member.user.globalName || member.user.username || '').trim();
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function findMemberRow(loaded, member) {
  const uidIndex = getHeaderIndex(loaded.headers, 'Discord User ID');
  const firstNameIndex = getHeaderIndex(loaded.headers, 'First Name');
  const lastNameIndex = getHeaderIndex(loaded.headers, 'Last Name');
  const memberIdMatch = (loaded.values.slice(1) || []).findIndex(row => String(row[uidIndex] || '').trim() === member.id);
  if (memberIdMatch >= 0) return { rowIndex: memberIdMatch + 2, matchedBy: 'id' };

  if (firstNameIndex < 0 || lastNameIndex < 0) return null;
  const nickname = normalizeName(getMemberNickname(member));
  if (!nickname) return null;
  const matches = [];
  (loaded.values.slice(1) || []).forEach((row, index) => {
    const name = normalizeName(`${row[firstNameIndex] || ''} ${row[lastNameIndex] || ''}`);
    if (name && name === nickname) matches.push(index + 2);
  });
  return matches.length === 1 ? { rowIndex: matches[0], matchedBy: 'name' } : null;
}

async function updateMemberRow(sheets, loaded, member, batchWrites = null) {
  const committee = getCommitteeFromMember(member);
  const nicknameIndex = getHeaderIndex(loaded.headers, 'Discord Nickname');
  const committeeIndex = getHeaderIndex(loaded.headers, 'Committee');
  const discordIdIndex = getHeaderIndex(loaded.headers, 'Discord User ID');
  const match = committee
    ? findMemberRow(loaded, member)
    : (() => {
      const index = (loaded.values.slice(1) || []).findIndex(row => String(row[discordIdIndex] || '').trim() === member.id);
      return index >= 0 ? { rowIndex: index + 2, matchedBy: 'id' } : null;
    })();
  if (!committee && !match) return { updated: false, ignored: true, userId: member.id };
  if (!match) return { updated: false, unmatched: true, userId: member.id, nickname: getMemberNickname(member), committee };

  const rowIndex = match.rowIndex;
  const row = (loaded.values[rowIndex - 1] || []).slice();
  while (row.length < loaded.headers.length) row.push('');
  const nickname = getMemberNickname(member);
  const changed = String(row[discordIdIndex] || '').trim() !== member.id
    || String(row[nicknameIndex] || '').trim() !== nickname
    || String(row[committeeIndex] || '').trim() !== (committee || '');
  if (!changed) return { updated: false, unchanged: true, matchedBy: match.matchedBy, userId: member.id, nickname, committee };

  row[discordIdIndex] = member.id;
  row[nicknameIndex] = nickname;
  row[committeeIndex] = committee || '';
  const write = {
    range: `${config.membersSheetName}!A${rowIndex}:${columnLetter(loaded.headers.length)}${rowIndex}`,
    values: [row]
  };
  if (batchWrites) {
    batchWrites.push(write);
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: write.range,
      valueInputOption: 'RAW',
      requestBody: { values: write.values }
    });
  }
  return { updated: true, matchedBy: match.matchedBy, userId: member.id, nickname: row[nicknameIndex], committee: committee || '' };
}

function columnLetter(number) {
  let result = '';
  let current = number;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

async function syncMember(member) {
  const sheets = createSheetsClient();
  const loaded = await ensureHeaders(sheets, MEMBER_HEADERS);
  return updateMemberRow(sheets, loaded, member);
}

async function syncAll(guild) {
  await guild.members.fetch();
  const sheets = createSheetsClient();
  const loaded = await ensureHeaders(sheets, MEMBER_HEADERS);
  const results = [];
  const batchWrites = [];
  for (const member of guild.members.cache.values()) {
    results.push(await updateMemberRow(sheets, loaded, member, batchWrites));
  }
  if (batchWrites.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: batchWrites
      }
    });
  }
  const summary = results.reduce((counts, result) => {
    const key = result.updated ? 'updated' : result.unchanged ? 'unchanged' : result.unmatched ? 'unmatched' : 'ignored';
    counts[key]++;
    if (result.matchedBy === 'name') counts.nameMatched++;
    return counts;
  }, { updated: 0, unchanged: 0, ignored: 0, unmatched: 0, nameMatched: 0 });
  console.log(`Initial sync complete: ${JSON.stringify(summary)}`);

  const unmatched = results.filter(result => result.unmatched);
  const csvEscape = value => `"${String(value || '').replace(/"/g, '""')}"`;
  const report = [
    ['Discord User ID', 'Discord Nickname', 'Mapped Committee'],
    ...unmatched.map(result => [result.userId, result.nickname, result.committee])
  ].map(row => row.map(csvEscape).join(',')).join('\n');
  const reportPath = path.join(__dirname, '..', 'unmatched-members.csv');
  fs.writeFileSync(reportPath, `${report}\n`, 'utf8');

  if (unmatched.length) {
    console.log('Approved-role members without a sheet match:');
    unmatched.forEach(result => {
      console.log(`- ${result.nickname || '(no nickname)'} | ${result.userId} | ${result.committee}`);
    });
  } else {
    console.log('All approved-role members matched a Members row.');
  }
  console.log(`Unmatched-member report saved to ${reportPath}`);
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

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});