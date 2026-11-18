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

var APP_VERSION = '0.1.1';
var TZ = 'Asia/Kuwait';

var ROLES = ['Admin', 'Accounting', 'Management', 'Manager', 'Technician', 'CountTeam'];

/** Roles allowed to open the admin page. Only Admin may grant the Admin role. */
var ADMIN_ROLES = ['Admin', 'Accounting'];

var LOCATION_TYPES = ['Branch', 'Central kitchen', 'Office', 'Department', 'Warehouse'];
var ASSET_KINDS = ['Tangible', 'Intangible'];

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
  ['WarrantyAlertDays', '', 'Days before warranty end to send an alert']
];

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

  if (readTable_('Categories').length === 0) {
    SEED_CATEGORIES.forEach(function (c, i) {
      appendRow_('Categories', {
        CategoryId: 'CAT-' + pad_(i + 1, 3), Name: c[0], AssetKind: c[1], Active: true,
        UpdatedAt: now_(), UpdatedBy: 'setup'
      });
    });
  }

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

var SHEET_ORDER = ['Users', 'Locations', 'Departments', 'Brands', 'Categories', 'Types', 'Settings', 'AuditLog'];
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
      body.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
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
  var user = resolveUser_(identity);
  var p = req.payload || {};
  switch (req.action) {
    case 'me': return { user: publicUser_(user), version: APP_VERSION };
    case 'meta': return meta_(user);
    case 'bootstrap': return bootstrap_(user);
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
    canAdmin: ADMIN_ROLES.indexOf(u.Role) !== -1
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
  return meta;
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

function readTableFromSheet_(name) {
  var sh = sheet_(name);
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
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
      if (val !== '' && val !== null) empty = false;
    }
    if (!empty) rows.push(obj);
  }
  return rows;
}

function appendRow_(name, obj) {
  var sh = sheet_(name);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
  invalidate_(name);
}

function updateRow_(name, rowIndex, obj) {
  var sh = sheet_(name);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var current = sh.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  var next = headers.map(function (h, i) { return obj[h] === undefined ? current[i] : obj[h]; });
  sh.getRange(rowIndex, 1, 1, headers.length).setValues([next]);
  invalidate_(name);
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
