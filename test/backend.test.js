// Runs Code.gs in a Node VM with in-memory mocks of the Apps Script services.
const assert = require('assert');
const { makeEnv } = require('./mockenv');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

const env = makeEnv();
test('setup creates sheets, settings and seed categories', () => {
  env.ctx.setup();
  ['Users', 'Locations', 'Departments', 'Brands', 'Categories', 'Types', 'Settings', 'AuditLog']
    .forEach((n) => assert(env.sheets[n], 'missing ' + n));
  assert.strictEqual(env.sheets.Categories.data.length, 8);
  assert.strictEqual(env.sheets.Settings.data.length, 5);
  assert.strictEqual(env.props.BOOTSTRAP_ADMIN, 'osama@foodlabs.com.kw');
  env.ctx.setup(); // idempotent
  assert.strictEqual(env.sheets.Categories.data.length, 8);
  assert.strictEqual(env.sheets.Settings.data.length, 5);
});

env.addToken('t-osama', 'Osama@foodlabs.com.kw');
env.addToken('t-acc', 'acc@foodlabs.com.kw');
env.addToken('t-mgr', 'rima@foodlabs.com.kw');
env.addToken('t-stranger', 'someone@gmail.com');
env.addToken('t-wrongaud', 'osama@foodlabs.com.kw', { aud: 'other' });
env.addToken('t-expired', 'osama@foodlabs.com.kw', { exp: String(Math.floor(Date.now() / 1000) - 10) });

test('rejects missing, invalid, wrong-audience and expired tokens', () => {
  assert.strictEqual(env.call(undefined, 'me').error.code, 'AUTH');
  assert.strictEqual(env.call('garbage', 'me').error.code, 'AUTH');
  assert.strictEqual(env.call('t-wrongaud', 'me').error.code, 'AUTH');
  assert.strictEqual(env.call('t-expired', 'me').error.code, 'AUTH');
});

test('stranger cannot bootstrap before admin exists', () => {
  assert.strictEqual(env.call('t-stranger', 'me').error.code, 'FORBIDDEN');
  assert.strictEqual(env.sheets.Users.data.length, 1);
});

test('bootstrap admin is created on first sign-in', () => {
  const r = env.call('t-osama', 'me');
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.user.role, 'Admin');
  assert.strictEqual(r.data.user.canAdmin, true);
  assert.strictEqual(env.sheets.Users.data.length, 2);
});

test('token verification is cached', () => {
  const before = env.fetchCount();
  env.call('t-osama', 'me');
  assert.strictEqual(env.fetchCount(), before);
});

test('meta exposes admin tables to admin', () => {
  const r = env.call('t-osama', 'meta');
  assert.deepStrictEqual(Object.keys(r.data.tables).sort(),
    ['Brands', 'Categories', 'Departments', 'Locations', 'Settings', 'Types', 'Users']);
});

test('creating locations gives sequential IDs and audit rows', () => {
  let r = env.call('t-osama', 'save', { table: 'Brands', record: { Name: "Philly's" }, isNew: true });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.record.BrandId, 'BRD-001');
  r = env.call('t-osama', 'save', { table: 'Locations', record: { Name: 'Salwa', Type: 'Branch', Brand: 'BRD-001' }, isNew: true });
  assert.strictEqual(r.data.record.LocationId, 'LOC-001');
  r = env.call('t-osama', 'save', { table: 'Locations', record: { Name: 'Central kitchen', Type: 'Central kitchen' }, isNew: true });
  assert.strictEqual(r.data.record.LocationId, 'LOC-002');
  assert(env.sheets.AuditLog.data.length >= 4);
});

test('validation: required, unique, select, ref, number range, formula injection', () => {
  assert.strictEqual(env.call('t-osama', 'save', { table: 'Locations', record: { Type: 'Branch' }, isNew: true }).error.code, 'INVALID');
  assert.strictEqual(env.call('t-osama', 'save', { table: 'Locations', record: { Name: 'salwa', Type: 'Branch' }, isNew: true }).error.code, 'INVALID');
  assert.strictEqual(env.call('t-osama', 'save', { table: 'Locations', record: { Name: 'X', Type: 'Moon' }, isNew: true }).error.code, 'INVALID');
  assert.strictEqual(env.call('t-osama', 'save', { table: 'Locations', record: { Name: 'Y', Type: 'Branch', Brand: 'BRD-999' }, isNew: true }).error.code, 'INVALID');
  assert.strictEqual(env.call('t-osama', 'save', { table: 'Categories', record: { CategoryId: 'CAT-001', Name: 'Kitchen equipment', AssetKind: 'Tangible', ResidualPct: 150 } }).error.code, 'INVALID');
  const r = env.call('t-osama', 'save', { table: 'Departments', record: { Name: '=HYPERLINK("x")' }, isNew: true });
  assert(r.ok);
  assert(r.data.record.Name.startsWith("'="));
});

test('update records only changed fields in audit log', () => {
  const before = env.sheets.AuditLog.data.length;
  const r = env.call('t-osama', 'save', { table: 'Categories', record: {
    CategoryId: 'CAT-001', Name: 'Kitchen equipment', AssetKind: 'Tangible', UsefulLifeMonths: 60, ResidualPct: 0, Active: true } });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(env.sheets.AuditLog.data.length - before, 2);
  const again = env.call('t-osama', 'save', { table: 'Categories', record: {
    CategoryId: 'CAT-001', Name: 'Kitchen equipment', AssetKind: 'Tangible', UsefulLifeMonths: 60, ResidualPct: 0, Active: true } });
  assert.strictEqual(again.data.unchanged, true);
});

test('users: accounting can add managers but cannot grant or touch Admin', () => {
  let r = env.call('t-osama', 'save', { table: 'Users', isNew: true,
    record: { Email: 'Acc@Foodlabs.com.kw', Name: 'Accountant', Role: 'Accounting', Active: true } });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.record.Email, 'acc@foodlabs.com.kw');
  r = env.call('t-acc', 'save', { table: 'Users', isNew: true,
    record: { Email: 'rima@foodlabs.com.kw', Name: 'Rima', Role: 'Manager', Locations: ['LOC-001'], Active: true } });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(env.call('t-acc', 'save', { table: 'Users', isNew: true,
    record: { Email: 'x@foodlabs.com.kw', Name: 'X', Role: 'Admin' } }).error.code, 'FORBIDDEN');
  assert.strictEqual(env.call('t-acc', 'save', { table: 'Users',
    record: { Email: 'osama@foodlabs.com.kw', Name: 'Osama', Role: 'Admin', Active: false } }).error.code, 'FORBIDDEN');
  assert.strictEqual(env.call('t-acc', 'save', { table: 'Users', isNew: true,
    record: { Email: 'y@foodlabs.com.kw', Name: 'Y', Role: 'Manager', Locations: 'LOC-404' } }).error.code, 'INVALID');
});

test('managers have no admin access', () => {
  const me = env.call('t-mgr', 'me');
  assert.strictEqual(me.data.user.role, 'Manager');
  assert.deepStrictEqual(me.data.user.locations, ['LOC-001']);
  assert.deepStrictEqual(Object.keys(env.call('t-mgr', 'meta').data.tables), []);
  assert.strictEqual(env.call('t-mgr', 'list', { table: 'Users' }).error.code, 'FORBIDDEN');
  assert.strictEqual(env.call('t-mgr', 'save', { table: 'Locations', record: { Name: 'Z', Type: 'Branch' }, isNew: true }).error.code, 'FORBIDDEN');
});

test('last admin cannot demote or deactivate themselves', () => {
  assert.strictEqual(env.call('t-osama', 'save', { table: 'Users',
    record: { Email: 'osama@foodlabs.com.kw', Name: 'Osama', Role: 'Accounting', Active: true } }).error.code, 'INVALID');
});

test('deactivated user is locked out', () => {
  env.call('t-osama', 'save', { table: 'Users',
    record: { Email: 'rima@foodlabs.com.kw', Name: 'Rima', Role: 'Manager', Locations: 'LOC-001', Active: false } });
  assert.strictEqual(env.call('t-mgr', 'me').error.code, 'FORBIDDEN');
});

test('settings can be edited but not added; unknown table and action rejected', () => {
  assert(env.call('t-osama', 'save', { table: 'Settings', record: { Key: 'CountReminderDays', Value: '30' } }).ok);
  assert.strictEqual(env.call('t-osama', 'save', { table: 'Settings', record: { Key: 'New', Value: '1' }, isNew: true }).error.code, 'INVALID');
  assert.strictEqual(env.call('t-osama', 'list', { table: 'AuditLog' }).error.code, 'BAD_REQUEST');
  assert.strictEqual(env.call('t-osama', 'drop').error.code, 'BAD_REQUEST');
});

test('audit history per record', () => {
  const r = env.call('t-osama', 'audit', { table: 'Categories', id: 'CAT-001' });
  assert(r.data.rows.length >= 2);
});

test('list returns rows without internal row numbers', () => {
  const r = env.call('t-osama', 'list', { table: 'Locations' });
  assert.strictEqual(r.data.rows.length, 2);
  assert.strictEqual(r.data.rows[0].__row, undefined);
});

console.log(`\n${passed} tests passed`);
