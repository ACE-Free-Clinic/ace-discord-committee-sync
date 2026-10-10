const test = require('node:test');
const assert = require('node:assert/strict');
const { getPortalStatusRolePlan, shouldSyncStatusRoleForUser } = require('../src/index.js');

test('Active status has no status flag unless restoring a saved flag', () => {
  assert.equal(getPortalStatusRolePlan('Active', false, '', false).shouldHaveStatusFlag, false);
  assert.equal(getPortalStatusRolePlan('Active', false, '', true).shouldHaveStatusFlag, false);
  assert.equal(getPortalStatusRolePlan('Active', false, 'Yes', false).shouldHaveStatusFlag, true);
});

test('Probation remains active and receives Status Flag', () => {
  const plan = getPortalStatusRolePlan('Probation', false, '', false);
  assert.equal(plan.inactive, false);
  assert.equal(plan.shouldHaveStatusFlag, true);
});

test('Inactive snapshots and preserves an existing Status Flag', () => {
  const withFlag = getPortalStatusRolePlan('Inactive', false, '', true);
  assert.equal(withFlag.inactive, true);
  assert.equal(withFlag.snapshotToSave, 'Yes');
  assert.equal(withFlag.preserveStatusFlag, true);

  const withoutFlag = getPortalStatusRolePlan('Inactive', false, '', false);
  assert.equal(withoutFlag.snapshotToSave, 'No');
  assert.equal(withoutFlag.preserveStatusFlag, false);
});

test('Archived members use inactive behavior and retain prior flag state', () => {
  const plan = getPortalStatusRolePlan('Active', true, 'Yes', false);
  assert.equal(plan.inactive, true);
  assert.equal(plan.preserveStatusFlag, true);
});

test('Archived members without the Alumni role still use inactive behavior', () => {
  assert.equal(getPortalStatusRolePlan('Inactive', true, '', false, false).inactive, true);
});

test('Archived members with the Alumni role are alumni, never inactive', () => {
  const plan = getPortalStatusRolePlan('Inactive', true, '', true, true);
  assert.equal(plan.alumni, true);
  assert.equal(plan.inactive, false);
  assert.equal(plan.snapshotToSave, '');
});

test('Alumni role does not make a non-archived member alumni', () => {
  const plan = getPortalStatusRolePlan('Inactive', false, '', false, true);
  assert.equal(plan.alumni, undefined);
  assert.equal(plan.inactive, true);
});

test('Reactivation restores only a saved Status Flag snapshot', () => {
  const savedFlag = getPortalStatusRolePlan('Active', false, 'Yes', false);
  assert.equal(savedFlag.inactive, false);
  assert.equal(savedFlag.shouldHaveStatusFlag, true);
  assert.equal(savedFlag.snapshotToSave, '');

  const noSavedFlag = getPortalStatusRolePlan('Active', false, 'No', true);
  assert.equal(noSavedFlag.shouldHaveStatusFlag, false);
});

test('Status-role rollout allowlist restricts mutations to one Discord account', () => {
  assert.equal(shouldSyncStatusRoleForUser('123', ''), true);
  assert.equal(shouldSyncStatusRoleForUser('123', '123'), true);
  assert.equal(shouldSyncStatusRoleForUser('456', '123'), false);
});
