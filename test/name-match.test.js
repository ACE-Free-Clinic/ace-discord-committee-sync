const test = require('node:test');
const assert = require('node:assert/strict');
const { suggestPortalRecord } = require('../src/index.js');

test('Unique exact name match is available without committee-role data', () => {
  const records = [{ uid: 'portal-1', name: 'Aashi Rathod', discordId: '' }];
  const member = { nickname: '', user: { globalName: 'Aashi Rathod' } };

  assert.equal(suggestPortalRecord(records, member), records[0]);
});

test('Ambiguous name matches are not selected automatically', () => {
  const records = [
    { uid: 'portal-1', name: 'Aashi Rathod', discordId: '' },
    { uid: 'portal-2', name: 'Aashi Rathod', discordId: '' }
  ];
  const member = { nickname: 'Aashi Rathod', user: { globalName: '' } };

  assert.equal(suggestPortalRecord(records, member), null);
});

test('Already-linked portal records are excluded from name matching', () => {
  const records = [{ uid: 'portal-1', name: 'Aashi Rathod', discordId: '987654321012345678' }];
  const member = { nickname: 'Aashi Rathod', user: { globalName: '' } };

  assert.equal(suggestPortalRecord(records, member), null);
});
