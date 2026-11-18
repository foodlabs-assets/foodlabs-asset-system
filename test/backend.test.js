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
  assert.strictEqual(env.sheets.Settings.data.length, 7);
  assert.strictEqual(env.props.BOOTSTRAP_ADMIN, 'osama@foodlabs.com.kw');
  env.ctx.setup(); // idempotent
  assert.strictEqual(env.sheets.Categories.data.length, 8);
  assert.strictEqual(env.sheets.Settings.data.length, 7);
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
    ['Brands', 'Categories', 'Departments', 'LabelTemplates', 'Locations', 'Makes', 'Settings', 'Types', 'Users', 'XeroBalances']);
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

test('bootstrap returns meta and every admin table in one call', () => {
  const r = env.call('t-osama', 'bootstrap');
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.user.role, 'Admin');
  assert.strictEqual(r.data.data.Locations.length, 2);
  assert.strictEqual(r.data.data.Categories.length, 7);
  assert(!('AuditLog' in r.data.data));
  assert.deepStrictEqual(Object.keys(env.call('t-acc', 'bootstrap').data.data).length, 10);
});

test('table reads come from cache and writes invalidate it', () => {
  env.call('t-osama', 'list', { table: 'Brands' });
  const sh = env.sheets.Brands;
  const orig = sh.getRange;
  let reads = 0;
  sh.getRange = function () { reads++; return orig.apply(sh, arguments); };
  env.call('t-osama', 'list', { table: 'Brands' });
  assert.strictEqual(reads, 0, 'second list should not touch the sheet');
  env.call('t-osama', 'save', { table: 'Brands', record: { Name: 'Burger Bros' }, isNew: true });
  const after = env.call('t-osama', 'list', { table: 'Brands' });
  assert(after.data.rows.some((b) => b.Name === 'Burger Bros'));
  sh.getRange = orig;
});

test('large tables are chunked across cache keys', () => {
  const big = [];
  for (let i = 0; i < 3000; i++) big.push({ a: 'x'.repeat(50) + i });
  env.ctx.cachePutJson_('tbl_Big', big, 600);
  assert(Number(env.cache['tbl_Big_n']) > 1);
  assert.strictEqual(env.ctx.cacheGetJson_('tbl_Big').length, 3000);
});

// ------------------------------------------------------------------ phase 2
test('setup seeds label sizes and count window setting', () => {
  env.ctx.setup();
  assert.strictEqual(env.sheets.LabelTemplates.data.length, 3);
  const b = env.call('t-osama', 'bootstrap').data;
  assert.strictEqual(b.settings.countTeamOpen, false);
  assert.strictEqual(b.settings.labelPrefix, 'FL');
  assert(b.lists.Categories.length >= 7);
});

test('label batches run on from the last number', () => {
  let r = env.call('t-osama', 'createLabelBatch', { quantity: 100 });
  assert(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.data.batch.FromNo, r.data.batch.ToNo], [1, 100]);
  r = env.call('t-osama', 'createLabelBatch', { quantity: 50, notes: 'Second roll' });
  assert.deepStrictEqual([r.data.batch.FromNo, r.data.batch.ToNo], [101, 150]);
  assert.strictEqual(env.call('t-osama', 'createLabelBatch', { quantity: 0 }).error.code, 'INVALID');
  assert.strictEqual(env.call('t-mgr2', 'createLabelBatch', { quantity: 5 }).error.code, 'AUTH');
});

env.addToken('t-count', 'count1@foodlabs.com.kw');
env.addToken('t-mgr2', 'hamad@foodlabs.com.kw');

test('lookup tells invalid, not printed and blank labels apart', () => {
  assert.strictEqual(env.call('t-osama', 'lookup', { code: 'hello' }).data.status, 'invalid');
  assert.strictEqual(env.call('t-osama', 'lookup', { code: 'FL-000999' }).data.status, 'not_issued');
  const r = env.call('t-osama', 'lookup', { code: 'fl-000001' }).data;
  assert.strictEqual(r.status, 'unregistered');
  assert.strictEqual(r.code, 'FL-000001');
  assert.strictEqual(r.canRegister, true);
});

let typeId;
test('count team can register only while the count is open', () => {
  env.call('t-osama', 'save', { table: 'Users', isNew: true, record: { Email: 'count1@foodlabs.com.kw', Name: 'Count One', Role: 'CountTeam', Active: true } });
  env.call('t-osama', 'save', { table: 'Users', isNew: true, record: { Email: 'hamad@foodlabs.com.kw', Name: 'Hamad', Role: 'Manager', Locations: 'LOC-002', Active: true } });
  const t = env.call('t-osama', 'save', { table: 'Types', isNew: true, record: { Name: 'Oven', CategoryId: 'CAT-001' } });
  typeId = t.data.record.TypeId;
  const asset = { Name: 'Combi oven', CategoryId: 'CAT-001', TypeId: typeId, LocationId: 'LOC-002', DepartmentId: 'DEP-001', Condition: 'Used' };
  assert.strictEqual(env.call('t-count', 'lookup', { code: 'FL-000001' }).data.canRegister, false);
  assert.strictEqual(env.call('t-count', 'register', { code: 'FL-000001', asset }).error.code, 'FORBIDDEN');
  assert(env.call('t-osama', 'setCountWindow', { open: true }).ok);
  const img = 'data:image/jpeg;base64,' + Buffer.from('fakejpeg').toString('base64');
  const r = env.call('t-count', 'register', { code: 'FL-000001', asset, photos: [img], newMake: 'Rational' });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.asset.Status, 'Under review');
  assert.strictEqual(r.data.asset.Photos.length, 1);
  assert.strictEqual(r.data.asset.Cost, undefined, 'count team must not see money fields');
  const mk = env.sheets.Makes.data.slice(1).map((row) => row[1]);
  assert(mk.includes('Rational'));
  // Same make again is reused, not duplicated
  const r2 = env.call('t-count', 'register', { code: 'FL-000002', asset: Object.assign({}, asset, { Name: 'Oven 2' }), newMake: 'rational' });
  assert(r2.ok, JSON.stringify(r2));
  assert.strictEqual(env.sheets.Makes.data.length, 2);
});

test('register validation: required, wrong type for category, duplicates, unprinted labels', () => {
  const base = { Name: 'X', CategoryId: 'CAT-001', TypeId: typeId, LocationId: 'LOC-002', DepartmentId: 'DEP-001', Condition: 'New' };
  assert.strictEqual(env.call('t-count', 'register', { code: 'FL-000003', asset: Object.assign({}, base, { DepartmentId: '' }) }).error.code, 'INVALID');
  assert.strictEqual(env.call('t-count', 'register', { code: 'FL-000003', asset: Object.assign({}, base, { CategoryId: 'CAT-002' }) }).error.code, 'INVALID');
  assert.strictEqual(env.call('t-count', 'register', { code: 'FL-000001', asset: base }).error.code, 'INVALID');
  assert.strictEqual(env.call('t-count', 'register', { code: 'FL-000500', asset: base }).error.code, 'INVALID');
});

test('managers see only their locations; finance sees values', () => {
  const m = env.call('t-mgr2', 'lookup', { code: 'FL-000001' }).data;
  assert.strictEqual(m.status, 'registered');
  assert.strictEqual(m.asset.Cost, undefined);
  const a = env.call('t-osama', 'lookup', { code: 'FL-000001' }).data;
  assert('Cost' in a.asset);
  env.call('t-osama', 'save', { table: 'Users', record: { Email: 'hamad@foodlabs.com.kw', Name: 'Hamad', Role: 'Manager', Locations: 'LOC-001', Active: true } });
  assert.strictEqual(env.call('t-mgr2', 'lookup', { code: 'FL-000001' }).data.status, 'elsewhere');
  assert.strictEqual(env.call('t-mgr2', 'photo', { code: 'FL-000001', fileId: 'file-1' }).error.code, 'FORBIDDEN');
  const ph = env.call('t-count', 'photo', { code: 'FL-000001', fileId: 'file-1' });
  assert(ph.ok && ph.data.dataUrl.startsWith('data:image/jpeg;base64,'));
});

const legacyRows = [
  { LineId: 'OLD-EQP1', Source: 'Old register', Name: 'Ovens (2 pcs)', Cost: 1000, LifeMonths: 60, AccumDeprDec2026: 600, NbvDec2026: 400, RemainingMonths: 24, PurchaseDate: '2023-01-10' },
  { LineId: 'NEW-001', Source: 'New register', Name: 'Shop fit-out', Cost: 5000, LifeMonths: 60, AccumDeprDec2026: 1000, NbvDec2026: 4000, RemainingMonths: 48, PurchaseDate: '2025-01-05' },
  { LineId: 'NEW-002', Source: 'New register', Name: 'Missing mixer', Cost: 300, LifeMonths: 60, AccumDeprDec2026: 100, NbvDec2026: 200, RemainingMonths: 40, PurchaseDate: '2024-05-01' }
];

test('legacy import: accounting only, rejects bad numbers and duplicate ids', () => {
  assert.strictEqual(env.call('t-count', 'importLegacy', { rows: legacyRows }).error.code, 'FORBIDDEN');
  assert.strictEqual(env.call('t-osama', 'importLegacy', { rows: [legacyRows[0], legacyRows[0]] }).error.code, 'INVALID');
  assert.strictEqual(env.call('t-osama', 'importLegacy', { rows: [Object.assign({}, legacyRows[0], { Cost: 'abc' })] }).error.code, 'INVALID');
  const r = env.call('t-osama', 'importLegacy', { rows: legacyRows });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.count, 3);
  // re-import before matching replaces cleanly
  assert.strictEqual(env.call('t-osama', 'importLegacy', { rows: legacyRows }).data.count, 3);
  assert.strictEqual(env.sheets.LegacyLines.data.length, 4);
});

test('matching splits one line across two counted assets and must add up', () => {
  const bad = env.call('t-osama', 'match', { lineId: 'OLD-EQP1', allocations: [{ code: 'FL-000001', cost: 500, accum: 300 }, { code: 'FL-000002', cost: 400, accum: 300 }] });
  assert.strictEqual(bad.error.code, 'INVALID');
  const r = env.call('t-osama', 'match', { lineId: 'OLD-EQP1', allocations: [{ code: 'FL-000001', cost: 500, accum: 300 }, { code: 'FL-000002', cost: 500, accum: 300 }] });
  assert(r.ok, JSON.stringify(r));
  const a1 = r.data.assets.find((a) => a.AssetCode === 'FL-000001');
  assert.strictEqual(a1.Status, 'Active');
  assert.strictEqual(Number(a1.Cost), 500);
  assert.strictEqual(Number(a1.RemainingMonths), 24);
  assert.strictEqual(r.data.legacy.find((l) => l.LineId === 'OLD-EQP1').MatchStatus, 'Matched');
  assert.strictEqual(env.call('t-osama', 'importLegacy', { rows: legacyRows }).error.code, 'INVALID', 'no re-import after matching starts');
});

test('undo match puts assets back under review', () => {
  const r = env.call('t-osama', 'unmatch', { lineId: 'OLD-EQP1' });
  assert(r.ok);
  assert.strictEqual(r.data.assets.find((a) => a.AssetCode === 'FL-000001').Status, 'Under review');
  assert.strictEqual(r.data.legacy.find((l) => l.LineId === 'OLD-EQP1').MatchStatus, 'Unmatched');
  env.call('t-osama', 'match', { lineId: 'OLD-EQP1', allocations: [{ code: 'FL-000001', cost: 500, accum: 300 }, { code: 'FL-000002', cost: 500, accum: 300 }] });
});

test('no-label asset from a fit-out line, and a line marked not found', () => {
  const r = env.call('t-osama', 'createFromLine', { lineId: 'NEW-001', asset: { CategoryId: 'CAT-006', LocationId: 'LOC-001', Name: 'Salwa fit-out' } });
  assert(r.ok, JSON.stringify(r));
  const a = r.data.assets.find((x) => x.AssetCode === 'FLX-000001');
  assert(a && a.Status === 'Active' && Number(a.Cost) === 5000);
  const lk = env.call('t-osama', 'lookup', { code: 'FLX-000001' }).data;
  assert.strictEqual(lk.status, 'registered');
  const nf = env.call('t-osama', 'markLine', { lineId: 'NEW-002', status: 'Not found', note: 'Not at Salwa or kitchen' });
  assert(nf.ok);
  assert.strictEqual(nf.data.legacy.find((l) => l.LineId === 'NEW-002').MatchStatus, 'Not found');
});

test('counted asset with no line gets values from accounting', () => {
  const base = { Name: 'New grill', CategoryId: 'CAT-001', TypeId: typeId, LocationId: 'LOC-001', DepartmentId: 'DEP-001', Condition: 'New' };
  assert(env.call('t-osama', 'register', { code: 'FL-000003', asset: base }).ok);
  assert.strictEqual(env.call('t-osama', 'setFinance', { code: 'FL-000003', values: { activate: true } }).error.code, 'INVALID');
  assert.strictEqual(env.call('t-osama', 'setFinance', { code: 'FL-000003', values: { Cost: 100, OpeningAccumDepr: 150 } }).error.code, 'INVALID');
  const r = env.call('t-osama', 'setFinance', { code: 'FL-000003', values: { Cost: 250, OpeningAccumDepr: 0, LifeMonths: 60, RemainingMonths: 60, PurchaseDate: '2026-12-01', activate: true } });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.assets.find((x) => x.AssetCode === 'FL-000003').Status, 'Active');
});

test('reconciliation by Xero account with differences', () => {
  env.call('t-osama', 'save', { table: 'Categories', record: { CategoryId: 'CAT-001', Name: 'Kitchen equipment', AssetKind: 'Tangible', UsefulLifeMonths: 60, ResidualPct: 0, AssetAccount: '710 Kitchen equipment', AccumDeprAccount: '711 Acc dep kitchen', Active: true } });
  env.call('t-osama', 'save', { table: 'XeroBalances', isNew: true, record: { Account: '710 Kitchen equipment', Balance: 1300 } });
  env.call('t-osama', 'save', { table: 'XeroBalances', isNew: true, record: { Account: '711 Acc dep kitchen', Balance: -600 } });
  const r = env.call('t-osama', 'recon');
  assert(r.ok, JSON.stringify(r));
  const cost = r.data.rows.find((x) => x.account === '710 Kitchen equipment');
  assert.deepStrictEqual([cost.app, cost.xero, cost.difference], [1250, 1300, -50]);
  const acc = r.data.rows.find((x) => x.account === '711 Acc dep kitchen');
  assert.deepStrictEqual([acc.app, acc.xero, acc.difference], [-600, -600, 0]);
  assert.strictEqual(r.data.notFound.lines, 1);
  assert.strictEqual(env.call('t-count', 'recon').error.code, 'FORBIDDEN');
});

test('closing the count stops the count team again', () => {
  env.call('t-osama', 'setCountWindow', { open: false });
  const base = { Name: 'Y', CategoryId: 'CAT-001', TypeId: typeId, LocationId: 'LOC-001', DepartmentId: 'DEP-001', Condition: 'New' };
  assert.strictEqual(env.call('t-count', 'register', { code: 'FL-000004', asset: base }).error.code, 'FORBIDDEN');
});

console.log(`\n${passed} tests passed`);
