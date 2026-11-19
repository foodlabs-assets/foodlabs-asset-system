/**
 * Foodlabs Asset System — backend (Google Apps Script, bound to the data spreadsheet).
 *
 * The Google Sheet is only a data log. Every read and write goes through doPost,
 * which verifies the caller's Google ID token, looks the caller up in the Users
 * sheet and checks the role before touching any data.
 *
 * Deploy as a web app: Execute as = Me, Who has access = Anyone.
 * Access is enforced here, not by the deployment setting, because the front end
 * runs on another origin and cannot send Google cookies.
 */

var APP_VERSION = '0.2.1';
var TZ = 'Asia/Kuwait';

var ROLES = ['Admin', 'Accounting', 'Management', 'Manager', 'Technician', 'CountTeam'];

/** Roles allowed to open the admin page. Only Admin may grant the Admin role. */
var ADMIN_ROLES = ['Admin', 'Accounting'];

var LOCATION_TYPES = ['Branch', 'Central kitchen', 'Office', 'Department', 'Warehouse'];
var ASSET_KINDS = ['Tangible', 'Intangible'];
var CONDITIONS = ['New', 'Used', 'Damaged'];
var ASSET_STATUSES = ['Under review', 'Active', 'In maintenance', 'Disposed'];
var FINANCE_ROLES = ['Admin', 'Accounting', 'Management'];
var MATCH_STATUSES = ['Unmatched', 'Matched', 'Not found'];

/**
 * Table definitions. Field types drive both server validation and the generic
 * admin forms in the front end, so a new column is added here only.
 *   text | number | bool | select (options) | ref (one id from a table) | refs (several ids)
 */
var SCHEMA = {
  Users: {
    title: 'Users', key: 'Email', admin: true,
    fields: [
      { name: 'Email', label: 'Google email', type: 'text', required: true, keyField: true },
      { name: 'Name', label: 'Name', type: 'text', required: true },
      { name: 'Role', label: 'Role', type: 'select', options: ROLES, required: true },
      { name: 'Locations', label: 'Assigned locations', type: 'refs', table: 'Locations' },
      { name: 'DashboardAccess', label: 'Dashboard access', type: 'bool' },
      { name: 'Active', label: 'Active', type: 'bool', defaultValue: true }
    ]
  },
  Locations: {
    title: 'Locations', key: 'LocationId', prefix: 'LOC', admin: true,
    fields: [
      { name: 'LocationId', label: 'ID', type: 'text', keyField: true, readOnly: true },
      { name: 'Name', label: 'Name', type: 'text', required: true, unique: true },
      { name: 'Type', label: 'Type', type: 'select', options: LOCATION_TYPES, required: true },
      { name: 'Brand', label: 'Brand', type: 'ref', table: 'Brands' },
      { name: 'XeroTracking1', label: 'Xero tracking 1', type: 'text' },
      { name: 'XeroTracking2', label: 'Xero tracking 2', type: 'text' },
      { name: 'Active', label: 'Active', type: 'bool', defaultValue: true }
    ]
  },
  Departments: {
    title: 'Departments', key: 'DepartmentId', prefix: 'DEP', admin: true,
    fields: [
      { name: 'DepartmentId', label: 'ID', type: 'text', keyField: true, readOnly: true },
      { name: 'Name', label: 'Name', type: 'text', required: true, unique: true },
      { name: 'Active', label: 'Active', type: 'bool', defaultValue: true }
    ]
  },
  Brands: {
    title: 'Brands', key: 'BrandId', prefix: 'BRD', admin: true,
    fields: [
      { name: 'BrandId', label: 'ID', type: 'text', keyField: true, readOnly: true },
      { name: 'Name', label: 'Name', type: 'text', required: true, unique: true },
      { name: 'Active', label: 'Active', type: 'bool', defaultValue: true }
    ]
  },
  Categories: {
    title: 'Categories', key: 'CategoryId', prefix: 'CAT', admin: true,
    fields: [
      { name: 'CategoryId', label: 'ID', type: 'text', keyField: true, readOnly: true },
      { name: 'Name', label: 'Name', type: 'text', required: true, unique: true },
      { name: 'AssetKind', label: 'Asset kind', type: 'select', options: ASSET_KINDS, required: true },
      { name: 'UsefulLifeMonths', label: 'Useful life (months)', type: 'number', min: 1 },
      { name: 'ResidualPct', label: 'Residual value (%)', type: 'number', min: 0, max: 100 },
      { name: 'AssetAccount', label: 'Asset account', type: 'text' },
      { name: 'DeprExpenseAccount', label: 'Depreciation expense account', type: 'text' },
      { name: 'AccumDeprAccount', label: 'Accumulated depreciation account', type: 'text' },
      { name: 'Active', label: 'Active', type: 'bool', defaultValue: true }
    ]
  },
  Types: {
    title: 'Asset types', key: 'TypeId', prefix: 'TYP', admin: true,
    fields: [
      { name: 'TypeId', label: 'ID', type: 'text', keyField: true, readOnly: true },
      { name: 'Name', label: 'Name', type: 'text', required: true },
      { name: 'CategoryId', label: 'Category', type: 'ref', table: 'Categories', required: true },
      { name: 'Active', label: 'Active', type: 'bool', defaultValue: true }
    ]
  },
  Settings: {
    title: 'Settings', key: 'Key', admin: true,
    fields: [
      { name: 'Key', label: 'Setting', type: 'text', keyField: true, readOnly: true },
      { name: 'Value', label: 'Value', type: 'text' },
      { name: 'Description', label: 'Description', type: 'text', readOnly: true }
    ]
  },
  Makes: {
    title: 'Makes', key: 'MakeId', prefix: 'MK', admin: true,
    fields: [
      { name: 'MakeId', label: 'ID', type: 'text', keyField: true, readOnly: true },
      { name: 'Name', label: 'Name', type: 'text', required: true, unique: true },
      { name: 'Status', label: 'Status', type: 'select', options: ['Approved', 'Pending review'], required: true, defaultValue: 'Approved' },
      { name: 'Active', label: 'Active', type: 'bool', defaultValue: true }
    ]
  },
  LabelTemplates: {
    title: 'Label sizes', key: 'TemplateId', prefix: 'LT', admin: true,
    fields: [
      { name: 'TemplateId', label: 'ID', type: 'text', keyField: true, readOnly: true },
      { name: 'Name', label: 'Name', type: 'text', required: true, unique: true },
      { name: 'WidthMm', label: 'Width (mm)', type: 'number', required: true, min: 15, max: 150 },
      { name: 'HeightMm', label: 'Height (mm)', type: 'number', required: true, min: 10, max: 150 },
      { name: 'Active', label: 'Active', type: 'bool', defaultValue: true }
    ]
  },
  XeroBalances: {
    title: 'Xero balances', key: 'Account', admin: true,
    fields: [
      { name: 'Account', label: 'Xero account', type: 'text', required: true, keyField: true },
      { name: 'Balance', label: 'Balance at 31 Dec 2026', type: 'number', required: true },
      { name: 'Notes', label: 'Notes', type: 'text' }
    ]
  },
  LabelBatches: {
    title: 'Label batches', key: 'BatchId', prefix: 'LB', system: false,
    fields: [
      { name: 'BatchId', label: 'Batch', type: 'text', keyField: true },
      { name: 'FromNo', label: 'From', type: 'number' },
      { name: 'ToNo', label: 'To', type: 'number' },
      { name: 'Quantity', label: 'Quantity', type: 'number' },
      { name: 'Notes', label: 'Notes', type: 'text' }
    ]
  },
  Assets: {
    title: 'Assets', key: 'AssetCode',
    fields: [
      { name: 'AssetCode', label: 'Asset code', type: 'text', keyField: true },
      { name: 'Name', label: 'Name', type: 'text', required: true },
      { name: 'CategoryId', label: 'Category', type: 'ref', table: 'Categories', required: true },
      { name: 'TypeId', label: 'Type', type: 'ref', table: 'Types', required: true },
      { name: 'LocationId', label: 'Location', type: 'ref', table: 'Locations', required: true },
      { name: 'DepartmentId', label: 'Department', type: 'ref', table: 'Departments', required: true },
      { name: 'BrandId', label: 'Brand', type: 'ref', table: 'Brands' },
      { name: 'MakeId', label: 'Make', type: 'ref', table: 'Makes' },
      { name: 'Model', label: 'Model', type: 'text' },
      { name: 'SerialNo', label: 'Serial number', type: 'text' },
      { name: 'Condition', label: 'Condition', type: 'select', options: CONDITIONS, required: true },
      { name: 'Status', label: 'Status', type: 'select', options: ASSET_STATUSES },
      { name: 'Notes', label: 'Notes', type: 'text' },
      { name: 'Photos', label: 'Photos', type: 'text' },
      { name: 'RegisteredAt', label: 'Registered at', type: 'text' },
      { name: 'RegisteredBy', label: 'Registered by', type: 'text' },
      { name: 'LegacyLineIds', label: 'Old register lines', type: 'text', finance: true },
      { name: 'PurchaseDate', label: 'Purchase date', type: 'text', finance: true },
      { name: 'Cost', label: 'Cost', type: 'number', finance: true },
      { name: 'OpeningAccumDepr', label: 'Accumulated depreciation at 31 Dec 2026', type: 'number', finance: true },
      { name: 'LifeMonths', label: 'Useful life (months)', type: 'number', finance: true },
      { name: 'RemainingMonths', label: 'Remaining months at 1 Jan 2027', type: 'number', finance: true },
      { name: 'Supplier', label: 'Supplier', type: 'text', finance: true },
      { name: 'InvoiceNo', label: 'Invoice number', type: 'text', finance: true },
      { name: 'MatchedAt', label: 'Matched at', type: 'text', finance: true },
      { name: 'MatchedBy', label: 'Matched by', type: 'text', finance: true }
    ]
  },
  LegacyLines: {
    title: 'Old register lines', key: 'LineId', finance: true,
    fields: [
      { name: 'LineId' }, { name: 'Source' }, { name: 'OldAssetId' }, { name: 'Name' }, { name: 'GroupCode' },
      { name: 'GroupName' }, { name: 'LocationRaw' }, { name: 'LocationSuggested' }, { name: 'PurchaseDate' },
      { name: 'Cost', type: 'number' }, { name: 'LifeMonths', type: 'number' }, { name: 'MonthlyDepr', type: 'number' },
      { name: 'NbvSep2026', type: 'number' }, { name: 'DeprOctDec2026', type: 'number' },
      { name: 'AccumDeprDec2026', type: 'number' }, { name: 'NbvDec2026', type: 'number' },
      { name: 'RemainingMonths', type: 'number' }, { name: 'Flags' },
      { name: 'MatchStatus' }, { name: 'MatchedAssets' }, { name: 'MatchNote' }
    ]
  },
  AuditLog: {
    title: 'Audit log', system: true,
    fields: [
      { name: 'Timestamp' }, { name: 'User' }, { name: 'Table' }, { name: 'RecordId' },
      { name: 'Action' }, { name: 'Field' }, { name: 'OldValue' }, { name: 'NewValue' }
    ]
  }
};

/** Columns added to every non-system table. */
var STAMP_COLUMNS = ['UpdatedAt', 'UpdatedBy'];

var DEFAULT_SETTINGS = [
  ['CutoverDate', '2027-01-01', 'System start date; opening balances are as at the day before'],
  ['LabelPrefix', 'FL', 'Prefix printed before the running asset number'],
  ['CountReminderDays', '', 'Days between stock-count reminders to managers'],
  ['WarrantyAlertDays', '', 'Days before warranty end to send an alert'],
  ['CountTeamOpen', 'FALSE', 'TRUE while the count team may register assets on blank labels'],
  ['PhotoFolderId', '', 'Drive folder for asset photos (filled automatically)']
];

var SEED_LABEL_TEMPLATES = [['50 x 25 mm', 50, 25], ['60 x 40 mm', 60, 40]];

/** Approved category list, seeded once; useful lives and accounts are filled later in admin. */
var SEED_CATEGORIES = [
  ['Kitchen equipment', 'Tangible'],
  ['Furniture and fixtures', 'Tangible'],
  ['IT and electronics', 'Tangible'],
  ['Vehicles', 'Tangible'],
  ['Electrical and air conditioning', 'Tangible'],
  ['Leasehold improvements', 'Intangible'],
  ['Software and intangibles', 'Intangible']
];

// ---------------------------------------------------------------------------
// One-time setup (run from the editor by the owner)
// ---------------------------------------------------------------------------

/**
 * Creates the sheets, headers and default settings. Safe to run again: it only
 * adds what is missing. Pass the OAuth client ID the first time.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CLIENT_ID')) {
    props.setProperty('CLIENT_ID', '496334927044-7u4a914om1dbv4qb7j6bfr0rmr0kggdi.apps.googleusercontent.com');
  }
  if (!props.getProperty('BOOTSTRAP_ADMIN')) {
    props.setProperty('BOOTSTRAP_ADMIN', String(Session.getEffectiveUser().getEmail() || '').toLowerCase());
  }
  if (!props.getProperty('SHEET_ID') && !SpreadsheetApp.getActive()) {
    var created = SpreadsheetApp.create('Foodlabs Asset System — Data');
    props.setProperty('SHEET_ID', created.getId());
  }
  var ss = book_();
  Object.keys(SCHEMA).forEach(function (name) { ensureSheet_(ss, name); });

  var settings = readTable_('Settings');
  DEFAULT_SETTINGS.forEach(function (s) {
    if (!settings.some(function (r) { return r.Key === s[0]; })) {
      appendRow_('Settings', { Key: s[0], Value: s[1], Description: s[2], UpdatedAt: now_(), UpdatedBy: 'setup' });
    }
  });

  if (readTable_('LabelTemplates').length === 0) {
    SEED_LABEL_TEMPLATES.forEach(function (t, i) {
      appendRow_('LabelTemplates', { TemplateId: 'LT-' + pad_(i + 1, 3), Name: t[0], WidthMm: t[1], HeightMm: t[2],
        Active: true, UpdatedAt: now_(), UpdatedBy: 'setup' });
    });
  }

  if (readTable_('Categories').length === 0) {
    SEED_CATEGORIES.forEach(function (c, i) {
      appendRow_('Categories', {
        CategoryId: 'CAT-' + pad_(i + 1, 3), Name: c[0], AssetKind: c[1], Active: true,
        UpdatedAt: now_(), UpdatedBy: 'setup'
      });
    });
  }

  repairSheets_();
  PropertiesService.getScriptProperties().setProperty('DATA_FIX', DATA_FIX_VERSION);
  formatBook_(ss);
  return 'Setup done. Data sheet: ' + ss.getUrl() + ' · Bootstrap admin: ' + props.getProperty('BOOTSTRAP_ADMIN');
}

/** The data spreadsheet: the one in SHEET_ID (standalone script), else the bound one. */
var BOOK_ = null;
function book_() {
  if (BOOK_) return BOOK_;
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  BOOK_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
  return BOOK_;
}

function ensureSheet_(ss, name) {
  var headers = headersFor_(name);
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else {
    var current = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    headers.forEach(function (h) {
      if (current.indexOf(h) === -1) {
        sh.getRange(1, sh.getLastColumn() + 1).setValue(h).setFontWeight('bold');
      }
    });
  }
  // Warn anyone who tries to edit by hand: the sheet is a log, the app writes it.
  if (sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length === 0) {
    sh.protect().setDescription('Written by the Foodlabs Asset System app').setWarningOnly(true);
  }
  return sh;
}

/** Run from the editor to re-apply the look of the data sheet without touching data. */
function formatSheets() {
  formatBook_(book_());
  return 'Formatted';
}

var SHEET_ORDER = ['Assets', 'LegacyLines', 'LabelBatches', 'Users', 'Locations', 'Departments', 'Brands',
  'Categories', 'Types', 'Makes', 'LabelTemplates', 'XeroBalances', 'Settings', 'AuditLog'];
var BRAND_GREEN = '#0f5e4b';

function formatBook_(ss) {
  // Remove the empty default tab a new spreadsheet comes with (any language).
  ss.getSheets().forEach(function (sh) {
    if (!SCHEMA[sh.getName()] && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  SHEET_ORDER.forEach(function (name, i) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(i + 1);
    formatSheet_(sh, name);
  });
  ss.setActiveSheet(ss.getSheetByName(SHEET_ORDER[0]));
}

function formatSheet_(sh, name) {
  var def = SCHEMA[name];
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cols = headers.length;
  var rows = Math.max(sh.getMaxRows(), 2);
  var fieldBy = {};
  def.fields.forEach(function (f) { fieldBy[f.name] = f; });

  sh.setTabColor(name === 'AuditLog' ? '#8a9690' : name === 'Settings' ? '#c58a00' : BRAND_GREEN);
  sh.getRange(1, 1, rows, cols).setFontFamily('Arial').setFontSize(10).setVerticalAlignment('middle');
  sh.getRange(1, 1, 1, cols)
    .setBackground(BRAND_GREEN).setFontColor('#ffffff').setFontWeight('bold')
    .setHorizontalAlignment('left').setWrap(false);
  sh.setRowHeight(1, 32);
  sh.setFrozenRows(1);
  if (cols > 1 && def.key) sh.setFrozenColumns(1);

  // Header tooltips with the friendly label shown in the app.
  sh.getRange(1, 1, 1, cols).setNotes([headers.map(function (h) {
    var f = fieldBy[h];
    return f && f.label ? f.label : (h === 'UpdatedAt' ? 'Last change (Kuwait time)' : h === 'UpdatedBy' ? 'Last changed by' : '');
  })]);

  headers.forEach(function (h, i) {
    var f = fieldBy[h] || {};
    var col = i + 1;
    var body = sh.getRange(2, col, rows - 1, 1);
    var width = 150;
    if (f.keyField) width = h === 'Email' ? 240 : 110;
    else if (f.type === 'bool') width = 110;
    else if (f.type === 'number') width = 130;
    else if (f.type === 'select' || f.type === 'ref') width = 150;
    else if (f.type === 'refs') width = 200;
    else if (h === 'Name' || h === 'Description' || h === 'NewValue' || h === 'OldValue') width = 240;
    else if (h === 'UpdatedAt' || h === 'Timestamp') width = 160;
    else if (h === 'UpdatedBy' || h === 'User') width = 220;
    sh.setColumnWidth(col, width);
    if (f.type === 'bool') {
      body.setHorizontalAlignment('center');
      body.setDataValidation(null);
      var dataRows = lastDataRow_(sh) - 1;
      if (dataRows > 0) sh.getRange(2, col, dataRows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
    } else if (f.type === 'number') {
      body.setHorizontalAlignment('right').setNumberFormat('#,##0.###');
    } else {
      body.setNumberFormat('@');
    }
    if (h === 'UpdatedAt' || h === 'UpdatedBy' || h === 'Timestamp') body.setFontColor('#5d6b65');
  });

  var bandings = sh.getBandings();
  bandings.forEach(function (b) { b.remove(); });
  sh.getRange(1, 1, rows, cols)
    .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false)
    .setHeaderRowColor(BRAND_GREEN)
    .setFirstRowColor('#ffffff')
    .setSecondRowColor('#f3f6f4');
}

function headersFor_(name) {
  var def = SCHEMA[name];
  var cols = def.fields.map(function (f) { return f.name; });
  return def.system ? cols : cols.concat(STAMP_COLUMNS);
}

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------

function doGet() {
  return json_({ ok: true, app: 'Foodlabs Asset System', version: APP_VERSION });
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = { ok: true, data: handle_(req) };
  } catch (err) {
    out = { ok: false, error: { code: err.code || 'ERROR', message: err.code ? err.message : 'Something went wrong. Try again.' } };
    if (!err.code) console.error(err && err.stack || err);
  }
  return json_(out);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Routes one request. Exposed separately from doPost for tests. */
function handle_(req) {
  var identity = verifyToken_(req.token);
  ensureDataFixed_();
  var user = resolveUser_(identity);
  var p = req.payload || {};
  switch (req.action) {
    case 'me': return { user: publicUser_(user), version: APP_VERSION };
    case 'meta': return meta_(user);
    case 'bootstrap': return bootstrap_(user);
    case 'lookup': return lookupAsset_(user, p.code);
    case 'register': return registerAsset_(user, p.code, p.asset, p.photos || [], p.newMake);
    case 'photo': return photo_(user, p.code, p.fileId);
    case 'createLabelBatch': return createLabelBatch_(user, p.quantity, p.notes);
    case 'setCountWindow': return setCountWindow_(user, p.open === true);
    case 'importLegacy': return importLegacy_(user, p.rows || []);
    case 'match': return matchAssets_(user, p.lineId, p.allocations || []);
    case 'unmatch': return unmatchLine_(user, p.lineId);
    case 'markLine': return markLine_(user, p.lineId, p.status, p.note);
    case 'createFromLine': return createFromLine_(user, p.lineId, p.asset || {});
    case 'setFinance': return setFinance_(user, p.code, p.values || {});
    case 'recon': return recon_(user);
    case 'list': return listTable_(user, p.table);
    case 'save': return saveRecord_(user, p.table, p.record, p.isNew === true);
    case 'audit': return auditFor_(user, p.table, p.id);
    default: throw appError_('BAD_REQUEST', 'Unknown action.');
  }
}

// ---------------------------------------------------------------------------
// Authentication and authorisation
// ---------------------------------------------------------------------------

function verifyToken_(token) {
  if (!token || typeof token !== 'string') throw appError_('AUTH', 'Sign in required.');
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw appError_('AUTH', 'Your session expired. Sign in again.');
  var info = JSON.parse(res.getContentText());

  var clientId = PropertiesService.getScriptProperties().getProperty('CLIENT_ID');
  var nowSec = Math.floor(Date.now() / 1000);
  var exp = Number(info.exp || 0);
  var issuerOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  var verified = info.email_verified === true || info.email_verified === 'true';
  if (!clientId || info.aud !== clientId || !issuerOk || !verified || !info.email || exp <= nowSec) {
    throw appError_('AUTH', 'Your session expired. Sign in again.');
  }
  var identity = { email: String(info.email).toLowerCase(), name: info.name || '' };
  cache.put(key, JSON.stringify(identity), Math.max(1, Math.min(21600, exp - nowSec - 30)));
  return identity;
}

function resolveUser_(identity) {
  var users = readTable_('Users');
  var u = findBy_(users, 'Email', identity.email);
  if (!u) {
    var bootstrap = PropertiesService.getScriptProperties().getProperty('BOOTSTRAP_ADMIN');
    if (users.length === 0 && bootstrap && bootstrap.toLowerCase() === identity.email) {
      u = { Email: identity.email, Name: identity.name || identity.email, Role: 'Admin', Locations: '',
            DashboardAccess: true, Active: true, UpdatedAt: now_(), UpdatedBy: 'bootstrap' };
      withLock_(function () { appendRow_('Users', u); });
      audit_(identity.email, 'Users', identity.email, 'create', '', '', 'bootstrap admin');
    } else {
      throw appError_('FORBIDDEN', 'Your account has no access to this app. Ask the system admin to add you.');
    }
  }
  if (!truthy_(u.Active)) throw appError_('FORBIDDEN', 'Your access is switched off. Ask the system admin.');
  return u;
}

function publicUser_(u) {
  var ids = splitIds_(u.Locations);
  var names = {};
  if (ids.length) readTable_('Locations').forEach(function (l) { names[l.LocationId] = l.Name; });
  return {
    email: u.Email, name: u.Name, role: u.Role,
    locations: ids,
    locationNames: ids.map(function (id) { return names[id] || id; }),
    dashboardAccess: truthy_(u.DashboardAccess),
    canAdmin: ADMIN_ROLES.indexOf(u.Role) !== -1,
    isFinance: FINANCE_ROLES.indexOf(u.Role) !== -1,
    canRegister: canRegister_(u)
  };
}

function requireAdmin_(user) {
  if (ADMIN_ROLES.indexOf(user.Role) === -1) throw appError_('FORBIDDEN', 'Only admin and accounting can do this.');
}

// ---------------------------------------------------------------------------
// Admin data API
// ---------------------------------------------------------------------------

function meta_(user) {
  var tables = {};
  if (ADMIN_ROLES.indexOf(user.Role) !== -1) {
    Object.keys(SCHEMA).forEach(function (name) {
      var def = SCHEMA[name];
      if (!def.admin) return;
      tables[name] = { title: def.title, key: def.key, prefix: def.prefix || '', fields: def.fields };
    });
  }
  return { user: publicUser_(user), tables: tables, roles: ROLES, version: APP_VERSION };
}

/** Everything the app needs after sign-in, in one round trip. */
function bootstrap_(user) {
  var meta = meta_(user);
  var data = {};
  Object.keys(meta.tables).forEach(function (name) {
    var def = SCHEMA[name];
    data[name] = readTable_(name).map(function (r) { return pick_(r, def); });
  });
  meta.data = data;
  meta.lists = lists_();
  meta.settings = { countTeamOpen: countOpen_(), labelPrefix: labelPrefix_() };
  if (ADMIN_ROLES.indexOf(user.Role) !== -1) {
    meta.labelBatches = readTable_('LabelBatches').map(function (r) { return pick_(r, SCHEMA.LabelBatches); });
    meta.assets = readTable_('Assets').map(function (r) { return assetView_(r, true); });
    meta.legacy = readTable_('LegacyLines').map(function (r) { return pick_(r, SCHEMA.LegacyLines); });
  }
  return meta;
}

/** Pick lists everyone needs for forms and for showing names instead of ids. */
function lists_() {
  function simple(table, extra) {
    var def = SCHEMA[table];
    return readTable_(table).filter(function (r) { return truthy_(r.Active); }).map(function (r) {
      var o = { id: String(r[def.key]), name: String(r.Name) };
      (extra || []).forEach(function (k) { o[k] = r[k]; });
      return o;
    });
  }
  return {
    Categories: simple('Categories', ['AssetKind']),
    Types: simple('Types', ['CategoryId']),
    Locations: simple('Locations', ['Type', 'Brand']),
    Departments: simple('Departments'),
    Brands: simple('Brands'),
    Makes: simple('Makes', ['Status']),
    LabelTemplates: simple('LabelTemplates', ['WidthMm', 'HeightMm'])
  };
}

function listTable_(user, table) {
  requireAdmin_(user);
  var def = adminDef_(table);
  return { table: table, rows: readTable_(table).map(function (r) { return pick_(r, def); }) };
}

function saveRecord_(user, table, record, isNew) {
  requireAdmin_(user);
  var def = adminDef_(table);
  if (!record || typeof record !== 'object') throw appError_('INVALID', 'Nothing to save.');
  if (table === 'Settings' && isNew) throw appError_('INVALID', 'Settings cannot be added from the app.');

  return withLock_(function () {
    var rows = readTableFromSheet_(table); // fresh read inside the lock, never the cache
    var keyName = def.key;
    var clean = validate_(def, record, rows, isNew);

    if (table === 'Users') guardUserChange_(user, clean, rows, isNew);

    if (isNew) {
      if (def.prefix) clean[keyName] = nextId_(rows, keyName, def.prefix);
      if (!clean[keyName]) throw appError_('INVALID', 'Missing ' + keyName + '.');
      if (findBy_(rows, keyName, clean[keyName])) throw appError_('INVALID', 'That record already exists.');
      clean.UpdatedAt = now_();
      clean.UpdatedBy = user.Email;
      appendRow_(table, clean);
      audit_(user.Email, table, clean[keyName], 'create', '', '', JSON.stringify(pick_(clean, def)));
      return { record: pick_(clean, def) };
    }

    if (blankCell_(record[keyName]) || String(record[keyName]).trim() === '') {
      throw appError_('INVALID', 'This record has no ID. Refresh and try again.');
    }
    var existing = findBy_(rows, keyName, record[keyName]);
    if (!existing) throw appError_('NOT_FOUND', 'That record no longer exists. Refresh and try again.');
    var updated = {};
    var changes = [];
    def.fields.forEach(function (f) {
      if (f.readOnly || f.keyField) { updated[f.name] = existing[f.name]; return; }
      var oldV = normForCompare_(existing[f.name]);
      var newV = normForCompare_(clean[f.name]);
      updated[f.name] = clean[f.name];
      if (oldV !== newV) changes.push([f.name, oldV, newV]);
    });
    if (table === 'Settings') updated.Value = clean.Value;
    if (changes.length === 0) return { record: pick_(existing, def), unchanged: true };
    updated.UpdatedAt = now_();
    updated.UpdatedBy = user.Email;
    updateRow_(table, existing.__row, updated);
    changes.forEach(function (c) { audit_(user.Email, table, existing[keyName], 'update', c[0], c[1], c[2]); });
    return { record: pick_(updated, def) };
  });
}

function guardUserChange_(actor, clean, rows, isNew) {
  var target = isNew ? null : findBy_(rows, 'Email', clean.Email);
  var grantsAdmin = clean.Role === 'Admin';
  var touchesAdmin = target && target.Role === 'Admin';
  if ((grantsAdmin || touchesAdmin) && actor.Role !== 'Admin') {
    throw appError_('FORBIDDEN', 'Only a system admin can grant or change the Admin role.');
  }
  if (target && target.Email === actor.Email && actor.Role === 'Admin' &&
      (clean.Role !== 'Admin' || !truthy_(clean.Active))) {
    var otherAdmins = rows.filter(function (r) {
      return r.Email !== actor.Email && r.Role === 'Admin' && truthy_(r.Active);
    });
    if (otherAdmins.length === 0) throw appError_('INVALID', 'You are the only active admin. Add another admin first.');
  }
}

function auditFor_(user, table, id) {
  requireAdmin_(user);
  adminDef_(table);
  var rows = readTable_('AuditLog').filter(function (r) {
    return r.Table === table && String(r.RecordId) === String(id);
  });
  return { rows: rows.slice(-200).reverse().map(function (r) { return pick_(r, SCHEMA.AuditLog); }) };
}

function adminDef_(table) {
  var def = SCHEMA[table];
  if (!def || !def.admin) throw appError_('BAD_REQUEST', 'Unknown table.');
  return def;
}

// ---------------------------------------------------------------------------
// Assets, labels and the initial count
// ---------------------------------------------------------------------------

function labelPrefix_() { return String(setting_('LabelPrefix') || 'FL').trim().toUpperCase(); }
function countOpen_() { return truthy_(String(setting_('CountTeamOpen') || '').toUpperCase()); }
function setting_(key) {
  var row = findBy_(readTable_('Settings'), 'Key', key);
  return row ? row.Value : '';
}
function isFinance_(user) { return FINANCE_ROLES.indexOf(user.Role) !== -1; }
function canRegister_(user) {
  return ADMIN_ROLES.indexOf(user.Role) !== -1 || (user.Role === 'CountTeam' && countOpen_());
}

/** Codes look like FL-000123 for labelled assets and FLX-000123 for assets with no label. */
function parseCode_(code) {
  var c = String(code || '').trim().toUpperCase();
  var p = labelPrefix_();
  var m = c.match(new RegExp('^' + p + '(X?)-(\\d{6})$'));
  if (!m) return null;
  return { code: c, noLabel: m[1] === 'X', number: Number(m[2]) };
}

function isIssued_(num) {
  return readTable_('LabelBatches').some(function (b) { return num >= Number(b.FromNo) && num <= Number(b.ToNo); });
}

/** What the caller may see of an asset. Values and accounts only for finance roles. */
function assetView_(r, finance) {
  var out = {};
  SCHEMA.Assets.fields.forEach(function (f) {
    if (f.finance && !finance) return;
    out[f.name] = r[f.name] === undefined ? '' : r[f.name];
  });
  out.Photos = splitIds_(r.Photos);
  out.UpdatedAt = r.UpdatedAt || '';
  return out;
}

function canSeeAsset_(user, asset) {
  if (isFinance_(user) || user.Role === 'CountTeam') return true;
  if (user.Role === 'Technician') return true;
  return splitIds_(user.Locations).indexOf(String(asset.LocationId)) !== -1;
}

function lookupAsset_(user, code) {
  var parsed = parseCode_(code);
  if (!parsed) return { status: 'invalid', code: String(code || '') };
  var asset = findBy_(readTable_('Assets'), 'AssetCode', parsed.code);
  if (asset) {
    if (!canSeeAsset_(user, asset)) return { status: 'elsewhere', code: parsed.code };
    return { status: 'registered', code: parsed.code, asset: assetView_(asset, isFinance_(user)) };
  }
  if (parsed.noLabel || !isIssued_(parsed.number)) return { status: 'not_issued', code: parsed.code };
  return { status: 'unregistered', code: parsed.code, canRegister: canRegister_(user) };
}

function registerAsset_(user, code, input, photos, newMake) {
  if (!canRegister_(user)) {
    throw appError_('FORBIDDEN', user.Role === 'CountTeam'
      ? 'The count is closed. Ask accounting to open it.' : 'You cannot register assets.');
  }
  var parsed = parseCode_(code);
  if (!parsed || parsed.noLabel) throw appError_('INVALID', 'That is not a Foodlabs label.');
  if (!isIssued_(parsed.number)) throw appError_('INVALID', 'That label number was never printed.');
  if (!input || typeof input !== 'object') throw appError_('INVALID', 'Nothing to save.');
  if (photos.length > 4) throw appError_('INVALID', 'Up to 4 photos per asset.');

  return withLock_(function () {
    var rows = readTableFromSheet_('Assets');
    if (findBy_(rows, 'AssetCode', parsed.code)) throw appError_('INVALID', 'This label is already registered.');

    var rec = {};
    ['Name', 'CategoryId', 'TypeId', 'LocationId', 'DepartmentId', 'BrandId', 'MakeId', 'Model', 'SerialNo', 'Condition', 'Notes']
      .forEach(function (k) {
        var f = fieldOf_('Assets', k);
        rec[k] = coerce_(f, input[k]);
        if (f.required && rec[k] === '') throw appError_('INVALID', f.label + ' is required.');
      });
    if (newMake && !rec.MakeId) rec.MakeId = ensureMake_(user, newMake);
    checkRefs_('Assets', rec);
    var type = findBy_(readTable_('Types'), 'TypeId', rec.TypeId);
    if (type && String(type.CategoryId) !== String(rec.CategoryId)) throw appError_('INVALID', 'That type belongs to another category.');

    rec.AssetCode = parsed.code;
    rec.Status = 'Under review';
    rec.RegisteredAt = now_();
    rec.RegisteredBy = user.Email;
    rec.Photos = savePhotos_(parsed.code, photos).join(',');
    rec.UpdatedAt = rec.RegisteredAt;
    rec.UpdatedBy = user.Email;
    appendRow_('Assets', rec);
    audit_(user.Email, 'Assets', parsed.code, 'create', '', '', 'registered at ' + rec.LocationId);
    return { asset: assetView_(rec, isFinance_(user)) };
  });
}

function ensureMake_(user, name) {
  var clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  if (clean.length > 80) throw appError_('INVALID', 'Make name is too long.');
  var makes = readTableFromSheet_('Makes');
  var hit = findBy_(makes, 'Name', clean);
  if (hit) return hit.MakeId;
  var id = nextId_(makes, 'MakeId', 'MK');
  appendRow_('Makes', { MakeId: id, Name: coerce_({ type: 'text', label: 'Make' }, clean), Status: 'Pending review',
    Active: true, UpdatedAt: now_(), UpdatedBy: user.Email });
  audit_(user.Email, 'Makes', id, 'create', '', '', clean + ' (pending review)');
  return id;
}

function fieldOf_(table, name) {
  return SCHEMA[table].fields.filter(function (f) { return f.name === name; })[0];
}

function checkRefs_(table, rec) {
  SCHEMA[table].fields.forEach(function (f) {
    if (f.type !== 'ref' || !rec[f.name]) return;
    var refDef = SCHEMA[f.table];
    if (!findBy_(readTable_(f.table), refDef.key, rec[f.name])) throw appError_('INVALID', f.label + ': unknown value.');
  });
}

// ----- Photos: kept private in the owner's Drive, served through the backend only

function photoFolder_() {
  var id = setting_('PhotoFolderId');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  var folder = DriveApp.createFolder('Foodlabs Asset System — Photos');
  var row = findBy_(readTableFromSheet_('Settings'), 'Key', 'PhotoFolderId');
  if (row) updateRow_('Settings', row.__row, { Value: folder.getId(), UpdatedAt: now_(), UpdatedBy: 'system' });
  return folder;
}

function savePhotos_(code, photos) {
  if (!photos.length) return [];
  var folder = photoFolder_();
  return photos.map(function (p, i) {
    var m = String(p || '').match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
    if (!m) throw appError_('INVALID', 'Photos must be JPEG, PNG or WebP images.');
    var bytes = Utilities.base64Decode(m[2]);
    if (bytes.length > 2500000) throw appError_('INVALID', 'A photo is too large.');
    var blob = Utilities.newBlob(bytes, 'image/' + m[1], code + '-' + (i + 1) + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]));
    return folder.createFile(blob).getId();
  });
}

function photo_(user, code, fileId) {
  var asset = findBy_(readTable_('Assets'), 'AssetCode', String(code || '').toUpperCase());
  if (!asset || !canSeeAsset_(user, asset)) throw appError_('FORBIDDEN', 'You cannot see this asset.');
  if (splitIds_(asset.Photos).indexOf(String(fileId)) === -1) throw appError_('NOT_FOUND', 'Photo not found.');
  var file = DriveApp.getFileById(fileId);
  var blob = file.getBlob();
  return { dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

// ----- Label stock

function createLabelBatch_(user, quantity, notes) {
  requireAdmin_(user);
  var q = Math.floor(Number(quantity));
  if (!(q >= 1 && q <= 2000)) throw appError_('INVALID', 'Print between 1 and 2000 labels at a time.');
  return withLock_(function () {
    var batches = readTableFromSheet_('LabelBatches');
    var last = batches.reduce(function (m, b) { return Math.max(m, Number(b.ToNo) || 0); }, 0);
    if (last + q > 999999) throw appError_('INVALID', 'Label numbers would run past 999999.');
    var batch = { BatchId: nextId_(batches, 'BatchId', 'LB'), FromNo: last + 1, ToNo: last + q, Quantity: q,
      Notes: coerce_({ type: 'text', label: 'Notes' }, notes || ''), UpdatedAt: now_(), UpdatedBy: user.Email };
    appendRow_('LabelBatches', batch);
    audit_(user.Email, 'LabelBatches', batch.BatchId, 'create', '', '', batch.FromNo + '-' + batch.ToNo);
    return { batch: pick_(batch, SCHEMA.LabelBatches), prefix: labelPrefix_() };
  });
}

function setCountWindow_(user, open) {
  requireAdmin_(user);
  return withLock_(function () {
    var row = findBy_(readTableFromSheet_('Settings'), 'Key', 'CountTeamOpen');
    var old = row.Value;
    updateRow_('Settings', row.__row, { Value: open ? 'TRUE' : 'FALSE', UpdatedAt: now_(), UpdatedBy: user.Email });
    audit_(user.Email, 'Settings', 'CountTeamOpen', 'update', 'Value', old, open ? 'TRUE' : 'FALSE');
    return { countTeamOpen: open };
  });
}

// ---------------------------------------------------------------------------
// Old register: import, matching, reconciliation (accounting only)
// ---------------------------------------------------------------------------

function requireAccounting_(user) {
  if (ADMIN_ROLES.indexOf(user.Role) === -1) throw appError_('FORBIDDEN', 'Only admin and accounting can do this.');
}

var LEGACY_NUMBERS = ['Cost', 'LifeMonths', 'MonthlyDepr', 'NbvSep2026', 'DeprOctDec2026', 'AccumDeprDec2026', 'NbvDec2026', 'RemainingMonths'];

function importLegacy_(user, rows) {
  requireAccounting_(user);
  if (!rows.length) throw appError_('INVALID', 'The file has no lines.');
  if (rows.length > 5000) throw appError_('INVALID', 'Too many lines in one file.');
  return withLock_(function () {
    var existing = readTableFromSheet_('LegacyLines');
    if (existing.some(function (r) { return r.MatchStatus && r.MatchStatus !== 'Unmatched'; })) {
      throw appError_('INVALID', 'Matching has started. The old register cannot be replaced now.');
    }
    var ids = {};
    var clean = rows.map(function (r, i) {
      var o = {};
      SCHEMA.LegacyLines.fields.forEach(function (f) {
        var v = r[f.name];
        if (LEGACY_NUMBERS.indexOf(f.name) !== -1) {
          o[f.name] = v === '' || v === null || v === undefined ? '' : Number(v);
          if (o[f.name] !== '' && !isFinite(o[f.name])) throw appError_('INVALID', 'Line ' + (i + 2) + ': ' + f.name + ' is not a number.');
        } else {
          o[f.name] = coerce_({ type: 'text', label: f.name }, v === undefined ? '' : v);
        }
      });
      if (!o.LineId) throw appError_('INVALID', 'Line ' + (i + 2) + ' has no LineId.');
      if (ids[o.LineId]) throw appError_('INVALID', 'LineId ' + o.LineId + ' appears twice.');
      ids[o.LineId] = true;
      o.MatchStatus = 'Unmatched'; o.MatchedAssets = ''; o.MatchNote = '';
      return o;
    });
    var sh = sheet_('LegacyLines');
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    sh.getRange(2, 1, clean.length, headers.length).setValues(clean.map(function (o) {
      return headers.map(function (h) { return o[h] === undefined ? '' : o[h]; });
    }));
    invalidate_('LegacyLines');
    audit_(user.Email, 'LegacyLines', '*', 'import', '', '', clean.length + ' lines');
    return { count: clean.length, legacy: clean };
  });
}

/**
 * Links one old-register line to one or more counted assets. Each allocation names an asset
 * and its share of cost and accumulated depreciation; shares must add up to the line.
 */
function matchAssets_(user, lineId, allocations) {
  requireAccounting_(user);
  if (!allocations.length) throw appError_('INVALID', 'Choose at least one asset.');
  return withLock_(function () {
    var lines = readTableFromSheet_('LegacyLines');
    var line = findBy_(lines, 'LineId', lineId);
    if (!line) throw appError_('NOT_FOUND', 'That old-register line was not found.');
    if (line.MatchStatus === 'Matched') throw appError_('INVALID', 'That line is already matched. Undo it first.');
    var assets = readTableFromSheet_('Assets');
    var lineCost = Number(line.Cost) || 0, lineAccum = Number(line.AccumDeprDec2026) || 0;
    var sumCost = 0, sumAccum = 0;
    var targets = allocations.map(function (a) {
      var asset = findBy_(assets, 'AssetCode', a.code);
      if (!asset) throw appError_('NOT_FOUND', 'Asset ' + a.code + ' was not found.');
      if (asset.Status !== 'Under review') throw appError_('INVALID', 'Asset ' + a.code + ' is already matched.');
      var cost = round3_(Number(a.cost)), accum = round3_(Number(a.accum));
      if (!isFinite(cost) || !isFinite(accum) || cost < 0 || accum < 0 || accum > cost + 0.0005) {
        throw appError_('INVALID', 'Check the amounts for ' + a.code + '.');
      }
      sumCost += cost; sumAccum += accum;
      return { asset: asset, cost: cost, accum: accum };
    });
    if (Math.abs(sumCost - lineCost) > 0.0015 || Math.abs(sumAccum - lineAccum) > 0.0015) {
      throw appError_('INVALID', 'The shares must add up to the line: cost ' + lineCost.toFixed(3) + ', accumulated ' + lineAccum.toFixed(3) + '.');
    }
    var stamp = now_();
    targets.forEach(function (t) {
      var upd = {
        LegacyLineIds: line.LineId, PurchaseDate: line.PurchaseDate, Cost: t.cost, OpeningAccumDepr: t.accum,
        LifeMonths: line.LifeMonths, RemainingMonths: line.RemainingMonths, Status: 'Active',
        MatchedAt: stamp, MatchedBy: user.Email, UpdatedAt: stamp, UpdatedBy: user.Email
      };
      updateRow_('Assets', t.asset.__row, upd);
      audit_(user.Email, 'Assets', t.asset.AssetCode, 'match', 'LegacyLineIds', '', line.LineId + ' cost ' + t.cost + ' accum ' + t.accum);
    });
    updateRow_('LegacyLines', line.__row, { MatchStatus: 'Matched', MatchedAssets: targets.map(function (t) { return t.asset.AssetCode; }).join(',') });
    audit_(user.Email, 'LegacyLines', line.LineId, 'match', 'MatchedAssets', '', targets.map(function (t) { return t.asset.AssetCode; }).join(','));
    return financeSnapshot_();
  });
}

function unmatchLine_(user, lineId) {
  requireAccounting_(user);
  return withLock_(function () {
    var lines = readTableFromSheet_('LegacyLines');
    var line = findBy_(lines, 'LineId', lineId);
    if (!line) throw appError_('NOT_FOUND', 'That old-register line was not found.');
    var assets = readTableFromSheet_('Assets');
    splitIds_(line.MatchedAssets).forEach(function (code) {
      var a = findBy_(assets, 'AssetCode', code);
      if (!a) return;
      var noLabel = parseCode_(code) && parseCode_(code).noLabel;
      updateRow_('Assets', a.__row, {
        LegacyLineIds: '', PurchaseDate: '', Cost: '', OpeningAccumDepr: '', LifeMonths: '', RemainingMonths: '',
        Status: noLabel ? 'Disposed' : 'Under review', MatchedAt: '', MatchedBy: '', UpdatedAt: now_(), UpdatedBy: user.Email
      });
      audit_(user.Email, 'Assets', code, 'unmatch', 'LegacyLineIds', line.LineId, '');
    });
    updateRow_('LegacyLines', line.__row, { MatchStatus: 'Unmatched', MatchedAssets: '', MatchNote: '' });
    audit_(user.Email, 'LegacyLines', line.LineId, 'unmatch', 'MatchStatus', line.MatchStatus, 'Unmatched');
    return financeSnapshot_();
  });
}

function markLine_(user, lineId, status, note) {
  requireAccounting_(user);
  if (status !== 'Not found' && status !== 'Unmatched') throw appError_('INVALID', 'Unknown status.');
  return withLock_(function () {
    var line = findBy_(readTableFromSheet_('LegacyLines'), 'LineId', lineId);
    if (!line) throw appError_('NOT_FOUND', 'That old-register line was not found.');
    if (line.MatchStatus === 'Matched') throw appError_('INVALID', 'Undo the match first.');
    var n = coerce_({ type: 'text', label: 'Note' }, note || '');
    updateRow_('LegacyLines', line.__row, { MatchStatus: status, MatchNote: n });
    audit_(user.Email, 'LegacyLines', lineId, 'update', 'MatchStatus', line.MatchStatus, status + (n ? ' — ' + n : ''));
    return financeSnapshot_();
  });
}

/** Records an asset with no label (fit-out, software, rights) straight from an old-register line. */
function createFromLine_(user, lineId, input) {
  requireAccounting_(user);
  return withLock_(function () {
    var line = findBy_(readTableFromSheet_('LegacyLines'), 'LineId', lineId);
    if (!line) throw appError_('NOT_FOUND', 'That old-register line was not found.');
    if (line.MatchStatus === 'Matched') throw appError_('INVALID', 'That line is already matched.');
    var cat = findBy_(readTable_('Categories'), 'CategoryId', input.CategoryId);
    if (!cat) throw appError_('INVALID', 'Choose a category.');
    if (!findBy_(readTable_('Locations'), 'LocationId', input.LocationId)) throw appError_('INVALID', 'Choose a location.');
    var assets = readTableFromSheet_('Assets');
    var p = labelPrefix_() + 'X-';
    var max = 0;
    assets.forEach(function (a) { var m = String(a.AssetCode).match(new RegExp('^' + p + '(\\d{6})$')); if (m) max = Math.max(max, Number(m[1])); });
    var code = p + pad_(max + 1, 6);
    var stamp = now_();
    var rec = {
      AssetCode: code, Name: coerce_({ type: 'text', label: 'Name' }, input.Name || line.Name), CategoryId: cat.CategoryId,
      TypeId: input.TypeId || '', LocationId: input.LocationId, DepartmentId: input.DepartmentId || '', BrandId: input.BrandId || '',
      Condition: 'Used', Status: 'Active', Notes: 'No label · from ' + line.LineId, RegisteredAt: stamp, RegisteredBy: user.Email,
      LegacyLineIds: line.LineId, PurchaseDate: line.PurchaseDate, Cost: line.Cost, OpeningAccumDepr: line.AccumDeprDec2026,
      LifeMonths: line.LifeMonths, RemainingMonths: line.RemainingMonths, MatchedAt: stamp, MatchedBy: user.Email,
      UpdatedAt: stamp, UpdatedBy: user.Email
    };
    appendRow_('Assets', rec);
    updateRow_('LegacyLines', line.__row, { MatchStatus: 'Matched', MatchedAssets: code });
    audit_(user.Email, 'Assets', code, 'create', '', '', 'no-label asset from ' + line.LineId);
    return financeSnapshot_();
  });
}

/** Accounting fills or corrects the money side of an asset (e.g. a counted asset with no old line). */
function setFinance_(user, code, values) {
  requireAccounting_(user);
  return withLock_(function () {
    var assets = readTableFromSheet_('Assets');
    var a = findBy_(assets, 'AssetCode', String(code || '').toUpperCase());
    if (!a) throw appError_('NOT_FOUND', 'Asset not found.');
    var upd = {}, changes = [];
    ['PurchaseDate', 'Cost', 'OpeningAccumDepr', 'LifeMonths', 'RemainingMonths', 'Supplier', 'InvoiceNo'].forEach(function (k) {
      if (values[k] === undefined) return;
      var f = fieldOf_('Assets', k);
      var v = coerce_(f, values[k]);
      if (k === 'PurchaseDate' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw appError_('INVALID', 'Purchase date must be YYYY-MM-DD.');
      if (normForCompare_(a[k]) !== normForCompare_(v)) { upd[k] = v; changes.push([k, a[k], v]); }
    });
    var cost = upd.Cost !== undefined ? upd.Cost : a.Cost;
    var accum = upd.OpeningAccumDepr !== undefined ? upd.OpeningAccumDepr : a.OpeningAccumDepr;
    if (cost !== '' && accum !== '' && Number(accum) > Number(cost) + 0.0005) throw appError_('INVALID', 'Accumulated depreciation cannot exceed cost.');
    if (values.activate === true) {
      if (cost === '' || Number(cost) <= 0) throw appError_('INVALID', 'Enter the cost before confirming.');
      if (a.Status === 'Under review') { upd.Status = 'Active'; changes.push(['Status', a.Status, 'Active']); upd.MatchedAt = now_(); upd.MatchedBy = user.Email; }
    }
    if (!changes.length) return financeSnapshot_();
    upd.UpdatedAt = now_(); upd.UpdatedBy = user.Email;
    updateRow_('Assets', a.__row, upd);
    changes.forEach(function (c) { audit_(user.Email, 'Assets', a.AssetCode, 'update', c[0], normForCompare_(c[1]), normForCompare_(c[2])); });
    return financeSnapshot_();
  });
}

function financeSnapshot_() {
  return {
    assets: readTableFromSheet_('Assets').map(function (r) { return assetView_(r, true); }),
    legacy: readTableFromSheet_('LegacyLines').map(function (r) { return pick_(r, SCHEMA.LegacyLines); })
  };
}

/** App totals by Xero account against the balances accounting enters from Xero. */
function recon_(user) {
  requireAccounting_(user);
  var cats = readTable_('Categories');
  var catBy = {};
  cats.forEach(function (c) { catBy[c.CategoryId] = c; });
  var totals = {};
  function add(acct, kind, amount, code) {
    var key = acct || (kind === 'cost' ? '(category has no asset account)' : '(category has no accumulated depreciation account)');
    var t = totals[key] || (totals[key] = { account: key, cost: 0, accum: 0, assets: 0, kinds: {} });
    t[kind] += amount; t.kinds[kind] = true; if (kind === 'cost') t.assets += 1;
  }
  var underReview = 0;
  readTable_('Assets').forEach(function (a) {
    if (a.Status === 'Disposed') return;
    if (a.Status === 'Under review') { underReview += 1; return; }
    var c = catBy[a.CategoryId] || {};
    add(c.AssetAccount, 'cost', Number(a.Cost) || 0, a.AssetCode);
    add(c.AccumDeprAccount, 'accum', Number(a.OpeningAccumDepr) || 0, a.AssetCode);
  });
  var xero = {};
  readTable_('XeroBalances').forEach(function (x) { xero[x.Account] = Number(x.Balance) || 0; });
  var accounts = Object.keys(totals).concat(Object.keys(xero).filter(function (k) { return !totals[k]; }));
  var rows = accounts.sort().map(function (k) {
    var t = totals[k] || { cost: 0, accum: 0, assets: 0, kinds: {} };
    var app = round3_(t.kinds.accum && !t.kinds.cost ? -t.accum : t.cost - (t.kinds.cost && t.kinds.accum ? t.accum : 0));
    var hasX = Object.prototype.hasOwnProperty.call(xero, k);
    return { account: k, app: app, xero: hasX ? round3_(xero[k]) : null, difference: hasX ? round3_(app - xero[k]) : null, assets: t.assets };
  });
  var legacy = readTable_('LegacyLines');
  function sumLines(status) {
    return legacy.filter(function (l) { return l.MatchStatus === status; }).reduce(function (s, l) {
      s.lines += 1; s.cost += Number(l.Cost) || 0; s.accum += Number(l.AccumDeprDec2026) || 0; s.nbv += Number(l.NbvDec2026) || 0; return s;
    }, { lines: 0, cost: 0, accum: 0, nbv: 0 });
  }
  return { rows: rows, unmatched: sumLines('Unmatched'), notFound: sumLines('Not found'), underReview: underReview,
    note: 'Accumulated depreciation is shown as a negative balance, as in Xero.' };
}

function round3_(n) { return Math.round(Number(n) * 1000) / 1000; }

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate_(def, record, rows, isNew) {
  var out = {};
  def.fields.forEach(function (f) {
    var v = record[f.name];
    if (f.keyField && def.prefix) { out[f.name] = isNew ? '' : String(v || ''); return; }
    if (f.readOnly && !f.keyField) { out[f.name] = v === undefined ? '' : v; return; }
    out[f.name] = coerce_(f, v);
    if (f.required && (out[f.name] === '' || out[f.name] === null)) {
      throw appError_('INVALID', f.label + ' is required.');
    }
  });

  if (def.key === 'Email') {
    out.Email = String(out.Email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.Email)) throw appError_('INVALID', 'Enter a valid email.');
  }

  def.fields.forEach(function (f) {
    if (!f.unique || out[f.name] === '') return;
    var clash = rows.some(function (r) {
      return String(r[f.name]).trim().toLowerCase() === String(out[f.name]).toLowerCase() &&
        (isNew || String(r[def.key]) !== String(record[def.key]));
    });
    if (clash) throw appError_('INVALID', f.label + ' "' + out[f.name] + '" already exists.');
  });

  def.fields.forEach(function (f) {
    if (f.type !== 'ref' && f.type !== 'refs') return;
    var ids = f.type === 'ref' ? (out[f.name] ? [out[f.name]] : []) : splitIds_(out[f.name]);
    if (ids.length === 0) return;
    var refDef = SCHEMA[f.table];
    var known = readTable_(f.table).map(function (r) { return String(r[refDef.key]); });
    ids.forEach(function (id) {
      if (known.indexOf(id) === -1) throw appError_('INVALID', f.label + ': unknown value ' + id + '.');
    });
  });
  return out;
}

function coerce_(f, v) {
  if (v === undefined || v === null) v = f.defaultValue !== undefined ? f.defaultValue : '';
  switch (f.type) {
    case 'bool': return truthy_(v);
    case 'number':
      if (v === '' || v === null) return '';
      var n = Number(v);
      if (!isFinite(n)) throw appError_('INVALID', f.label + ' must be a number.');
      if (f.min !== undefined && n < f.min) throw appError_('INVALID', f.label + ' must be at least ' + f.min + '.');
      if (f.max !== undefined && n > f.max) throw appError_('INVALID', f.label + ' must be at most ' + f.max + '.');
      return n;
    case 'select':
      v = String(v).trim();
      if (v !== '' && f.options.indexOf(v) === -1) throw appError_('INVALID', f.label + ': choose a value from the list.');
      return v;
    case 'refs':
      return (Array.isArray(v) ? v : splitIds_(v)).map(function (x) { return String(x).trim(); })
        .filter(String).join(',');
    default:
      v = String(v).trim();
      if (v.length > 500) throw appError_('INVALID', f.label + ' is too long.');
      if (/^[=+\-@]/.test(v)) v = "'" + v; // stop formula injection into the sheet
      return v;
  }
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function sheet_(name) {
  var sh = book_().getSheetByName(name);
  if (!sh) throw appError_('SETUP', 'Sheet ' + name + ' is missing. Run setup.');
  return sh;
}

/**
 * Table reads are served from the script cache (10 minutes, cleared on every app write),
 * so most requests never open the spreadsheet. Big tables are split across cache keys.
 */
var TABLE_TTL_SEC = 600;
var CACHE_CHUNK = 90000;

function readTable_(name) {
  var cached = cacheGetJson_('tbl_' + name);
  if (cached) return cached;
  var rows = readTableFromSheet_(name);
  cachePutJson_('tbl_' + name, rows, TABLE_TTL_SEC);
  return rows;
}

function invalidate_(name) {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get('tbl_' + name + '_n') || 0);
  var keys = ['tbl_' + name + '_n'];
  for (var i = 0; i < n; i++) keys.push('tbl_' + name + '_' + i);
  cache.removeAll(keys);
}

function cachePutJson_(key, value, ttl) {
  var s = JSON.stringify(value);
  var parts = Math.ceil(s.length / CACHE_CHUNK) || 1;
  if (parts > 50) return; // too large to cache; read from the sheet instead
  var map = {};
  for (var i = 0; i < parts; i++) map[key + '_' + i] = s.substr(i * CACHE_CHUNK, CACHE_CHUNK);
  map[key + '_n'] = String(parts);
  CacheService.getScriptCache().putAll(map, ttl);
}

function cacheGetJson_(key) {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get(key + '_n') || 0);
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '_' + i);
  var got = cache.getAll(keys);
  var s = '';
  for (var j = 0; j < n; j++) {
    if (got[keys[j]] === undefined || got[keys[j]] === null) return null;
    s += got[keys[j]];
  }
  try { return JSON.parse(s); } catch (e) { return null; }
}

/** A cell counts as empty when blank or an unticked checkbox (Sheets stores those as FALSE). */
function blankCell_(v) { return v === '' || v === null || v === false; }

/** Last row holding a record. Column A always holds the record's key or timestamp. */
function lastDataRow_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return 1;
  var col = sh.getRange(1, 1, last, 1).getValues();
  for (var i = col.length - 1; i >= 1; i--) if (!blankCell_(col[i][0])) return i + 1;
  return 1;
}

function readTableFromSheet_(name) {
  var sh = sheet_(name);
  var lastRow = lastDataRow_(sh), lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = { __row: i + 1 };
    var empty = true;
    for (var c = 0; c < headers.length; c++) {
      var val = values[i][c];
      if (val instanceof Date) val = Utilities.formatDate(val, TZ, 'yyyy-MM-dd HH:mm:ss');
      obj[headers[c]] = val;
      if (!blankCell_(val)) empty = false;
    }
    if (!empty) rows.push(obj);
  }
  return rows;
}

function appendRow_(name, obj) {
  var sh = sheet_(name);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var target = lastDataRow_(sh) + 1;
  if (target > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
  sh.getRange(target, 1, 1, headers.length)
    .setValues([headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; })]);
  boolColumns_(name, headers).forEach(function (col) {
    sh.getRange(target, col).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  });
  invalidate_(name);
}

/** 1-based column numbers of the yes/no fields of a table. */
function boolColumns_(name, headers) {
  var def = SCHEMA[name], out = [];
  if (!def) return out;
  headers.forEach(function (h, i) {
    if (def.fields.some(function (f) { return f.name === h && f.type === 'bool'; })) out.push(i + 1);
  });
  return out;
}

function updateRow_(name, rowIndex, obj) {
  var sh = sheet_(name);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var current = sh.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  var next = headers.map(function (h, i) { return obj[h] === undefined ? current[i] : obj[h]; });
  sh.getRange(rowIndex, 1, 1, headers.length).setValues([next]);
  invalidate_(name);
}

/**
 * One-time repair (0.2.1). Checkbox formatting on whole columns had filled
 * every empty row with FALSE, so the app saw ~1000 blank records and edits of a
 * blank row landed on a record without an ID. This clears the filler rows,
 * keeps checkboxes on real rows only and gives every record that lacks an ID
 * the next free one. Runs once, on the first request after deploy.
 */
var DATA_FIX_VERSION = '0.2.1';
function ensureDataFixed_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('DATA_FIX') === DATA_FIX_VERSION) return;
  withLock_(function () {
    if (props.getProperty('DATA_FIX') === DATA_FIX_VERSION) return;
    repairSheets_();
    props.setProperty('DATA_FIX', DATA_FIX_VERSION);
  });
}

function repairSheets_() {
  var ss = book_();
  var report = [];
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    var def = SCHEMA[name];
    var cols = sh.getLastColumn();
    var values = sh.getRange(1, 1, sh.getLastRow(), cols).getValues();
    var headers = values[0];
    var last = 1;
    for (var i = values.length - 1; i >= 1; i--) {
      if (values[i].some(function (v) { return !blankCell_(v); })) { last = i + 1; break; }
    }
    // Give records without an ID the next free one.
    var keyCol = def.key ? headers.indexOf(def.key) : -1;
    if (keyCol !== -1 && def.prefix) {
      var max = 0;
      values.slice(1, last).forEach(function (r) {
        var m = String(r[keyCol]).match(/(\d+)$/);
        if (m) max = Math.max(max, Number(m[1]));
      });
      for (var r = 1; r < last; r++) {
        if (blankCell_(values[r][keyCol]) && values[r].some(function (v) { return !blankCell_(v); })) {
          var id = def.prefix + '-' + pad_(++max, 3);
          sh.getRange(r + 1, keyCol + 1).setValue(id);
          report.push(name + ' row ' + (r + 1) + ' -> ' + id);
          appendRow_('AuditLog', { Timestamp: now_(), User: 'system', Table: name, RecordId: id,
            Action: 'repair', Field: def.key, OldValue: '', NewValue: id });
        }
      }
    }
    // Clear the filler rows below the data and keep checkboxes on real rows only.
    var maxRows = sh.getMaxRows();
    if (maxRows > last) {
      var below = sh.getRange(last + 1, 1, maxRows - last, cols);
      below.setDataValidation(null);
      below.clearContent();
    }
    if (last >= 2) {
      boolColumns_(name, headers).forEach(function (col) {
        sh.getRange(2, col, last - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
      });
    }
    invalidate_(name);
  });
  if (report.length) console.log('Repaired IDs: ' + report.join('; '));
  return report;
}

function audit_(userEmail, table, id, action, field, oldV, newV) {
  appendRow_('AuditLog', {
    Timestamp: now_(), User: userEmail, Table: table, RecordId: id, Action: action,
    Field: field, OldValue: oldV, NewValue: newV
  });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw appError_('BUSY', 'The system is busy. Try again in a moment.');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function findBy_(rows, key, value) {
  var v = String(value === undefined ? '' : value).trim().toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][key]).trim().toLowerCase() === v) return rows[i];
  }
  return null;
}

function nextId_(rows, key, prefix) {
  var max = 0;
  rows.forEach(function (r) {
    var m = String(r[key]).match(/(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + '-' + pad_(max + 1, 3);
}

function pick_(row, def) {
  var out = {};
  def.fields.forEach(function (f) { out[f.name] = row[f.name] === undefined ? '' : row[f.name]; });
  if (!def.system) STAMP_COLUMNS.forEach(function (c) { if (row[c] !== undefined) out[c] = row[c]; });
  return out;
}

function splitIds_(v) {
  if (Array.isArray(v)) return v.map(String).filter(String);
  return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(String);
}

function truthy_(v) {
  return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1' || v === 'Yes';
}

function normForCompare_(v) {
  if (v === true || v === false) return String(v);
  return v === undefined || v === null ? '' : String(v);
}

function pad_(n, width) { var s = String(n); while (s.length < width) s = '0' + s; return s; }

function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }

function appError_(code, message) { var e = new Error(message); e.code = code; return e; }
