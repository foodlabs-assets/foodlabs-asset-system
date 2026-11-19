// Phase 3: maintenance, transfers, stock counts, notifications, search.
const assert = require('assert');
const { makeEnv } = require('./mockenv');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

const env = makeEnv();
env.ctx.setup();
const tokens = {
  ops: 'ops@foodlabs.com.kw', area: 'area@foodlabs.com.kw',
  admin: 'osama@foodlabs.com.kw', rima: 'rima@foodlabs.com.kw', sam: 'sam@foodlabs.com.kw',
  ali: 'ali@foodlabs.com.kw', acc: 'acc@foodlabs.com.kw', count: 'count@foodlabs.com.kw'
};
Object.keys(tokens).forEach((k) => env.addToken('t-' + k, tokens[k]));
const as = (who) => (action, payload) => env.call('t-' + who, action, payload);
const ops = as('ops'), area = as('area'), admin = as('admin'), rima = as('rima'), sam = as('sam'), ali = as('ali'), acc = as('acc'), count = as('count');
const ok = (r) => { assert(r.ok, JSON.stringify(r)); return r.data; };
const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 invoice').toString('base64');
const jpg = 'data:image/jpeg;base64,' + Buffer.from('fakejpeg').toString('base64');

let L1, L2, DEP, CAT, TYP;
test('set up locations, people and three active assets', () => {
  ok(admin('me'));
  ok(admin('save', { table: 'Brands', isNew: true, record: { Name: "Philly's" } }));
  L1 = ok(admin('save', { table: 'Locations', isNew: true, record: { Name: 'Salwa', Type: 'Branch', Brand: 'BRD-001' } })).record.LocationId;
  L2 = ok(admin('save', { table: 'Locations', isNew: true, record: { Name: 'Central kitchen', Type: 'Central kitchen' } })).record.LocationId;
  DEP = ok(admin('save', { table: 'Departments', isNew: true, record: { Name: 'Kitchen' } })).record.DepartmentId;
  [['rima', 'Manager', [L1]], ['sam', 'Manager', [L2]], ['ali', 'Technician', []], ['acc', 'Accounting', []], ['count', 'CountTeam', []]]
    .forEach(([k, role, locs]) => ok(admin('save', { table: 'Users', isNew: true, record: { Email: tokens[k], Name: k, Role: role, Locations: locs, Active: true } })));
  CAT = 'CAT-001';
  TYP = ok(admin('save', { table: 'Types', isNew: true, record: { Name: 'Oven', CategoryId: CAT } })).record.TypeId;
  ok(admin('createLabelBatch', { quantity: 10 }));
  [['FL-000001', L1], ['FL-000002', L1], ['FL-000003', L2]].forEach(([code, loc]) => {
    ok(admin('register', { code, asset: { Name: 'Oven ' + code, CategoryId: CAT, TypeId: TYP, LocationId: loc, DepartmentId: DEP, Condition: 'Used' } }));
    ok(acc('setFinance', { code, values: { Cost: 500, OpeningAccumDepr: 100, activate: true } }));
  });
  const boot = ok(rima('bootstrap'));
  assert.deepStrictEqual(boot.lists.Technicians, [{ id: tokens.ali, name: 'ali' }]);
  assert(boot.lists.MaintenanceTypes.indexOf('Breakdown') !== -1);
  assert.deepStrictEqual(boot.work, { maintenance: [], transfers: [], counts: [] });
});

let MR;
test('a manager asks for maintenance; it goes straight to the company technician', () => {
  assert.strictEqual(rima('requestMaintenance', { code: 'FL-000003', request: { Type: 'Breakdown', Description: 'x' } }).error.code, 'FORBIDDEN');
  assert.strictEqual(rima('requestMaintenance', { code: 'FL-000001', request: { Type: 'Nonsense', Description: 'x' } }).error.code, 'INVALID');
  assert.strictEqual(rima('requestMaintenance', { code: 'FL-000001', request: { Type: 'Breakdown', Description: '' } }).error.code, 'INVALID');
  const r = ok(rima('requestMaintenance', { code: 'FL-000001', request: { Type: 'Breakdown', Priority: 'Urgent', Description: 'Does not heat' }, photos: [jpg] }));
  MR = r.request.RequestId;
  assert.strictEqual(MR, 'MR-001');
  assert.strictEqual(r.request.Technician, tokens.ali);
  assert.strictEqual(r.request.Photos.length, 1);
  assert(!('Cost' in r.request), 'managers never see cost');
  const look = ok(rima('lookup', { code: 'FL-000001' }));
  assert.strictEqual(look.asset.Status, 'In maintenance');
  assert.strictEqual(look.context.openRequests.length, 1);
  const n = ok(ali('notices'));
  assert.strictEqual(n.unread, 1);
  assert(/MR-001/.test(n.items[0].text) && /urgent/.test(n.items[0].text));
  assert.strictEqual(ok(ali('work')).maintenance.length, 1);
  assert.strictEqual(ok(sam('work')).maintenance.length, 0, 'other managers do not see it');
});

test('the technician records the work; accounting closes with the invoice', () => {
  assert.strictEqual(sam('maintenance', { id: MR }).error.code, 'NOT_FOUND');
  const d = ok(ali('maintenance', { id: MR }));
  assert(d.can.start && d.can.workDone && !d.can.close);
  assert(!('Cost' in d.request));
  ok(ali('file', { id: MR, fileId: d.request.Photos[0] }));
  ok(ali('updateMaintenance', { id: MR, step: 'start' }));
  assert.strictEqual(acc('updateMaintenance', { id: MR, step: 'close', values: { Cost: 10 } }).error.code, 'FORBIDDEN');
  assert.strictEqual(ali('updateMaintenance', { id: MR, step: 'workDone', values: { WorkNotes: 'New element', Outcome: 'Fixed?' } }).error.code, 'INVALID');
  ok(ali('updateMaintenance', { id: MR, step: 'workDone', values: { WorkNotes: 'Replaced heating element', Outcome: 'Repaired' } }));
  assert.strictEqual(ok(rima('lookup', { code: 'FL-000001' })).asset.Status, 'Active');
  assert.strictEqual(ok(acc('notices')).unread, 1);
  assert.strictEqual(ok(acc('work')).maintenance.length, 1);
  assert.strictEqual(ali('updateMaintenance', { id: MR, step: 'close', values: { Cost: 25 } }).error.code, 'FORBIDDEN');
  assert.strictEqual(acc('updateMaintenance', { id: MR, step: 'close', values: { Cost: 25 } }).error.code, 'INVALID', 'invoice required');
  const closed = ok(acc('updateMaintenance', { id: MR, step: 'close', values: { Cost: 25.5, Supplier: 'Rational KW', InvoiceNo: 'INV-77' }, files: [pdf] }));
  assert.strictEqual(closed.request.Status, 'Closed');
  assert.strictEqual(closed.request.Cost, 25.5);
  assert.strictEqual(closed.request.InvoiceFiles.length, 1);
  assert.strictEqual(ali('file', { id: MR, fileId: closed.request.InvoiceFiles[0] }).error.code, 'NOT_FOUND', 'technicians do not open invoices');
  const f = ok(acc('file', { id: MR, fileId: closed.request.InvoiceFiles[0] }));
  assert(f.dataUrl.startsWith('data:application/pdf'));
  const look = ok(acc('lookup', { code: 'FL-000001' }));
  assert.strictEqual(look.context.maintenanceCost, 25.5);
  assert.strictEqual(look.context.history.length, 1);
  assert.strictEqual(ok(rima('notices')).items[0].text.indexOf('closed') !== -1, true);
});

test('admin reassigns, requester cancels, and the asset goes back to Active', () => {
  const r = ok(rima('requestMaintenance', { code: 'FL-000002', request: { Type: 'Other', Description: 'Door broken', Technician: tokens.ali } }));
  assert.strictEqual(rima('requestMaintenance', { code: 'FL-000002', request: { Type: 'Other', Description: 'x', Technician: tokens.rima } }).error.code, 'INVALID');
  assert.strictEqual(ali('updateMaintenance', { id: r.request.RequestId, step: 'assign', values: { Technician: tokens.ali } }).error.code, 'FORBIDDEN');
  ok(admin('updateMaintenance', { id: r.request.RequestId, step: 'assign', values: { Technician: tokens.ali } }));
  ok(rima('updateMaintenance', { id: r.request.RequestId, step: 'cancel', values: { Reason: 'Duplicate' } }));
  assert.strictEqual(ok(rima('lookup', { code: 'FL-000002' })).asset.Status, 'Active');
});

let TR;
test('transfer: custody moves only when the receiving location scans the asset', () => {
  assert.strictEqual(rima('requestTransfer', { code: 'FL-000003', toLocationId: L1 }).error.code, 'FORBIDDEN');
  assert.strictEqual(rima('requestTransfer', { code: 'FL-000002', toLocationId: L1 }).error.code, 'INVALID');
  // Sam cannot see the asset before it is sent to him.
  assert.strictEqual(ok(sam('lookup', { code: 'FL-000002' })).status, 'elsewhere');
  // Give the asset a brand and a cost-centre exception first: both must change with the move.
  env.ctx.updateRow_('Assets', env.ctx.readTableFromSheet_('Assets').find((a) => a.AssetCode === 'FL-000002').__row, { BrandId: 'BRD-001', CostCenters: 'CC-006' });
  TR = ok(rima('requestTransfer', { code: 'FL-000002', toLocationId: L2, reason: 'Needed in the kitchen' })).transfer.TransferId;
  assert.strictEqual(rima('requestTransfer', { code: 'FL-000002', toLocationId: L2 }).error.code, 'INVALID');
  assert.strictEqual(ok(sam('notices')).unread, 1);
  const look = ok(sam('lookup', { code: 'FL-000002' }));
  assert.strictEqual(look.status, 'registered');
  assert(look.context.canReceive && !look.context.canTransfer);
  assert.strictEqual(look.asset.LocationId, L1, 'still with the sender');
  assert.strictEqual(ok(sam('work')).transfers.length, 1);
  assert.strictEqual(rima('receiveTransfer', { id: TR, code: 'FL-000002' }).error.code, 'FORBIDDEN');
  assert.strictEqual(sam('receiveTransfer', { id: TR, code: 'FL-000001' }).error.code, 'INVALID');
  const got = ok(sam('receiveTransfer', { id: TR, code: 'fl-000002' }));
  assert.strictEqual(got.asset.LocationId, L2);
  assert.strictEqual(got.asset.BrandId, '', 'central kitchen has no brand, so the asset has none');
  const moved = env.ctx.readTableFromSheet_('Assets').find((a) => a.AssetCode === 'FL-000002');
  assert.strictEqual(moved.CostCenters, '', 'depreciation now follows the new location');
  assert.strictEqual(moved.BrandId, '');
  assert.strictEqual(ok(rima('lookup', { code: 'FL-000002' })).status, 'elsewhere');
  assert(ok(rima('notices')).items[0].text.indexOf('received') !== -1);
});

test('search finds assets by name or serial and requests by number', () => {
  const s = ok(rima('search', { q: 'oven' }));
  assert.deepStrictEqual(s.assets.map((a) => a.code), ['FL-000001'], 'only her own location');
  assert.strictEqual(ok(admin('search', { q: 'oven' })).assets.length, 3);
  assert.strictEqual(ok(rima('search', { q: MR })).requests.length, 1);
  assert.strictEqual(ok(sam('search', { q: MR })).requests.length, 0);
  assert.strictEqual(ok(sam('search', { q: TR })).transfers.length, 1);
});

test('stock count: found, found elsewhere, unknown and missing', () => {
  assert.strictEqual(rima('startCount', { locationId: L2 }).error.code, 'FORBIDDEN');
  const st = ok(sam('startCount', { locationId: L2 }));
  assert.deepStrictEqual(st.expected.map((e) => e.code).sort(), ['FL-000002', 'FL-000003']);
  const again = ok(sam('startCount', { locationId: L2 }));
  assert.strictEqual(again.count.CountId, st.count.CountId, 'one open count per location');
  const id = st.count.CountId;
  const r1 = ok(sam('countScans', { id, codes: ['FL-000003', 'FL-000001', 'FL-999999', 'FL-000003'] }));
  assert.deepStrictEqual(r1.results.map((x) => x.result), ['found', 'elsewhere', 'unknown', 'found']);
  assert.strictEqual(ok(sam('startCount', { locationId: L2 })).scanned.length, 3, 'scans survive a reload');
  const fin = ok(sam('countScans', { id, codes: [], finish: true }));
  assert.strictEqual(fin.count.Status, 'Finished');
  assert.deepStrictEqual(fin.count.lists.missing.map((m) => m.code), ['FL-000002']);
  assert.deepStrictEqual(fin.count.lists.elsewhere.map((m) => m.code), ['FL-000001']);
  assert.strictEqual(sam('countScans', { id, codes: ['FL-000002'] }).error.code, 'NOT_FOUND');
  const a3 = env.ctx.readTableFromSheet_('Assets').find((a) => a.AssetCode === 'FL-000003');
  assert(a3.LastCountAt && a3.LastCountBy === tokens.sam);
  assert.strictEqual(env.ctx.readTableFromSheet_('Assets').find((a) => a.AssetCode === 'FL-000002').LastCountAt, '');
  assert(ok(admin('notices')).items.some((n) => /missing/.test(n.text)));
  ok(sam('count', { id }));
  assert.strictEqual(rima('count', { id }).error.code, 'FORBIDDEN');
  // The count team counts anywhere; a count can be cancelled by whoever started it.
  const c2 = ok(count('startCount', { locationId: L1 })).count.CountId;
  assert.strictEqual(rima('cancelCount', { id: c2 }).error.code, 'FORBIDDEN');
  ok(count('cancelCount', { id: c2 }));
});

test('notifications can be marked read', () => {
  const before = ok(sam('notices'));
  assert(before.unread >= 1);
  const after = ok(sam('readNotices', { ids: 'all' }));
  assert.strictEqual(after.unread, 0);
});

test('with no technician, the area and operations managers get the request and handle it', () => {
  ok(admin('save', { table: 'Users', isNew: true, record: { Email: tokens.ops, Name: 'Ops', Role: 'Management', MaintenanceBackup: true, Active: true } }));
  ok(admin('save', { table: 'Users', isNew: true, record: { Email: tokens.area, Name: 'Area', Role: 'Manager', Locations: [L1, L2], MaintenanceBackup: true, Active: true } }));
  ok(admin('save', { table: 'Users', record: { Email: tokens.ali, Name: 'ali', Role: 'Technician', Locations: [], Active: false } }));
  const before = ok(ops('notices')).unread;
  const r = ok(rima('requestMaintenance', { code: 'FL-000001', request: { Type: 'Breakdown', Description: 'Fan noise' } })).request;
  assert.strictEqual(r.Technician, '');
  assert.strictEqual(ok(ops('notices')).unread, before + 1);
  assert(/no technician/.test(ok(area('notices')).items[0].text));
  assert.strictEqual(ok(admin('notices')).items[0].text.indexOf('Fan noise'), -1, 'admins are not told when backups exist');
  assert(ok(ops('work')).maintenance.some((x) => x.RequestId === r.RequestId));
  const d = ok(area('maintenance', { id: r.RequestId }));
  assert(d.can.start && d.can.workDone && d.can.assign);
  ok(area('updateMaintenance', { id: r.RequestId, step: 'workDone', values: { WorkNotes: 'Outside company cleaned the fan', Outcome: 'Repaired' } }));
  // Once a technician is back, new requests go to him and backups no longer record the work.
  ok(admin('save', { table: 'Users', record: { Email: tokens.ali, Name: 'ali', Role: 'Technician', Locations: [], Active: true } }));
  const r2 = ok(rima('requestMaintenance', { code: 'FL-000001', request: { Type: 'Breakdown', Description: 'Again' } })).request;
  assert.strictEqual(r2.Technician, tokens.ali);
  const d2 = ok(ops('maintenance', { id: r2.RequestId }));
  assert(!d2.can.workDone && d2.can.assign);
});

test('area manager (several locations) and central kitchen manager can ask for maintenance', () => {
  // The area manager is a Manager assigned to all his branches; the kitchen manager to the central kitchen.
  ok(area('requestMaintenance', { code: 'FL-000001', request: { Type: 'Other', Description: 'Handle loose' } }));
  ok(sam('requestMaintenance', { code: 'FL-000003', request: { Type: 'Other', Description: 'Door seal' } }));
  assert.strictEqual(sam('requestMaintenance', { code: 'FL-000001', request: { Type: 'Other', Description: 'x' } }).error.code, 'FORBIDDEN');
});

console.log(`\n${passed} tests passed`);
