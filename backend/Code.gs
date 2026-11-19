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

var APP_VERSION = '0.3.0';
var TZ = 'Asia/Kuwait';

var ROLES = ['Admin', 'Accounting', 'Management', 'Manager', 'Technician', 'CountTeam'];

/** Roles allowed to open the admin page. Only Admin may grant the Admin role. */
var ADMIN_ROLES = ['Admin', 'Accounting'];

var COST_ALLOCATIONS = ['Whole company', 'Selected cost centres'];
var LOCATION_TYPES = ['Branch', 'Central kitchen', 'Office', 'Department', 'Warehouse'];
var ASSET_KINDS = ['Tangible', 'Intangible'];
var CONDITIONS = ['New', 'Used', 'Damaged'];
var ASSET_STATUSES = ['Under review', 'Active', 'In maintenance', 'Missing', 'Disposed'];
var FINANCE_ROLES = ['Admin', 'Accounting', 'Management'];
var MATCH_STATUSES = ['Unmatched', 'Matched', 'Not found'];
var MR_STATUSES = ['Open', 'In progress', 'Work done', 'Closed', 'Cancelled'];
var MR_OUTCOMES = ['Repaired', 'No fault found', 'Needs replacement', 'Could not repair'];
var MR_PRIORITIES = ['Normal', 'Urgent'];
var TR_STATUSES = ['Awaiting receipt', 'Received', 'Cancelled'];
var COUNT_STATUSES = ['Open', 'Finished', 'Cancelled'];

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
      { name: 'MaintenanceBackup', label: 'Gets maintenance requests when there is no technician', type: 'bool',
        help: 'For example the area manager and the operations manager. They can record the work or pass it to a technician.' },
      { name: 'DashboardAccess', label: 'Dashboard access', type: 'bool' },
      { name: 'Active', label: 'Active', type: 'bool', defaultValue: true }
    ]
  },
  Locations: {
    title: 'Locations', key: 'LocationId', prefix: 'LOC', admin: true,
    fields: [
      { name: 'LocationId', label: 'ID', type: 'text', keyField: true, readOnly: true },
      { name: 'Name', label: 'Name', type: 'text', required: true, unique: true, uniqueWith: 'Brand' },
      { name: 'Type', label: 'Type', type: 'select', options: LOCATION_TYPES, required: true },
      { name: 'Brand', label: 'Brand', type: 'ref', table: 'Brands' },
      { name: 'CostCenterId', label: 'Cost centre', type: 'ref', table: 'CostCenters',
        help: 'For a branch: all its depreciation goes here. Leave empty for the central kitchen and offices; the department decides.' },
      { name: 'Active', label: 'Active', type: 'bool', defaultValue: true }
    ]
  },
  Departments: {
    title: 'Departments', key: 'DepartmentId', prefix: 'DEP', admin: true,
    fields: [
      { name: 'DepartmentId', label: 'ID', type: 'text', keyField: true, readOnly: true },
      { name: 'Name', label: 'Name', type: 'text', required: true, unique: true },
      { name: 'CostAllocation', label: 'Depreciation goes to', type: 'select', options: COST_ALLOCATIONS,
        required: true, defaultValue: 'Whole company',
        help: 'Used where the location has no cost centre of its own (central kitchen, offices). Shared amounts are split by each cost centre\'s sales.' },
      { name: 'CostCenters', label: 'Cost centres', type: 'refs', table: 'CostCenters',
        help: 'Only for "Selected cost centres".' },
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
  CostCenters: {
    title: 'Cost centres', key: 'CostCenterId', prefix: 'CC', admin: true,
    fields: [
      { name: 'CostCenterId', label: 'ID', type: 'text', keyField: true, readOnly: true },
      { name: 'Name', label: 'Name in Xero', type: 'text', required: true, unique: true,
        help: 'Exactly as the tracking option is written in Xero.' },
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
      { name: 'LastCountAt', label: 'Last counted', type: 'text' },
      { name: 'LastCountBy', label: 'Last counted by', type: 'text' },
      { name: 'MissingSince', label: 'Missing since', type: 'text' },
      { name: 'MissingCount', label: 'Missing in count', type: 'text' },
      { name: 'LegacyLineIds', label: 'Old register lines', type: 'text', finance: true },
      { name: 'PurchaseDate', label: 'Purchase date', type: 'text', finance: true },
      { name: 'Cost', label: 'Cost', type: 'number', finance: true },
      { name: 'OpeningAccumDepr', label: 'Accumulated depreciation at 31 Dec 2026', type: 'number', finance: true },
      { name: 'LifeMonths', label: 'Useful life (months)', type: 'number', finance: true },
      { name: 'RemainingMonths', label: 'Remaining months at 1 Jan 2027', type: 'number', finance: true },
      { name: 'Supplier', label: 'Supplier', type: 'text', finance: true },
      { name: 'InvoiceNo', label: 'Invoice number', type: 'text', finance: true },
      { name: 'CostCenters', label: 'Cost centres (exception)', type: 'refs', table: 'CostCenters', finance: true },
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
  NotificationTypes: {
    title: 'E-mail alerts', key: 'Event', admin: true, noAdd: true,
    fields: [
      { name: 'Event', label: 'Alert', type: 'text', keyField: true, readOnly: true },
      { name: 'Description', label: 'When and to whom', type: 'text', readOnly: true },
      { name: 'Email', label: 'Also send by e-mail', type: 'bool' }
    ]
  },
  Maintenance: {
    title: 'Maintenance requests', key: 'RequestId', prefix: 'MR',
    fields: [
      { name: 'RequestId', label: 'Request', type: 'text', keyField: true },
      { name: 'AssetCode', label: 'Asset', type: 'text' },
      { name: 'LocationId', label: 'Location', type: 'ref', table: 'Locations' },
      { name: 'Type', label: 'Type', type: 'text' },
      { name: 'Priority', label: 'Priority', type: 'select', options: MR_PRIORITIES },
      { name: 'Description', label: 'Description', type: 'text' },
      { name: 'Photos', label: 'Photos', type: 'text' },
      { name: 'Technician', label: 'Technician', type: 'text' },
      { name: 'Status', label: 'Status', type: 'select', options: MR_STATUSES },
      { name: 'RequestedAt', label: 'Requested at', type: 'text' },
      { name: 'RequestedBy', label: 'Requested by', type: 'text' },
      { name: 'WorkNotes', label: 'Work done', type: 'text' },
      { name: 'Outcome', label: 'Outcome', type: 'select', options: MR_OUTCOMES },
      { name: 'WorkDoneAt', label: 'Work done at', type: 'text' },
      { name: 'WorkDoneBy', label: 'Work done by', type: 'text' },
      { name: 'Supplier', label: 'Supplier', type: 'text', finance: true },
      { name: 'InvoiceNo', label: 'Invoice number', type: 'text', finance: true },
      { name: 'Cost', label: 'Cost', type: 'number', finance: true },
      { name: 'InvoiceFiles', label: 'Invoice files', type: 'text', finance: true },
      { name: 'ClosedAt', label: 'Closed at', type: 'text' },
      { name: 'ClosedBy', label: 'Closed by', type: 'text' },
      { name: 'Notes', label: 'Notes', type: 'text' }
    ]
  },
  Transfers: {
    title: 'Transfers', key: 'TransferId', prefix: 'TR',
    fields: [
      { name: 'TransferId', label: 'Transfer', type: 'text', keyField: true },
      { name: 'AssetCode', label: 'Asset', type: 'text' },
      { name: 'FromLocationId', label: 'From', type: 'ref', table: 'Locations' },
      { name: 'ToLocationId', label: 'To', type: 'ref', table: 'Locations' },
      { name: 'ToDepartmentId', label: 'To department', type: 'ref', table: 'Departments' },
      { name: 'Reason', label: 'Reason', type: 'text' },
      { name: 'Status', label: 'Status', type: 'select', options: TR_STATUSES },
      { name: 'RequestedAt', label: 'Requested at', type: 'text' },
      { name: 'RequestedBy', label: 'Requested by', type: 'text' },
      { name: 'ReceivedAt', label: 'Received at', type: 'text' },
      { name: 'ReceivedBy', label: 'Received by', type: 'text' },
      { name: 'Notes', label: 'Notes', type: 'text' }
    ]
  },
  Counts: {
    title: 'Stock counts', key: 'CountId', prefix: 'CNT',
    fields: [
      { name: 'CountId', label: 'Count', type: 'text', keyField: true },
      { name: 'LocationId', label: 'Location', type: 'ref', table: 'Locations' },
      { name: 'Status', label: 'Status', type: 'select', options: COUNT_STATUSES },
      { name: 'StartedAt', label: 'Started at', type: 'text' },
      { name: 'StartedBy', label: 'Started by', type: 'text' },
      { name: 'FinishedAt', label: 'Finished at', type: 'text' },
      { name: 'FinishedBy', label: 'Finished by', type: 'text' },
      { name: 'Expected', label: 'Expected', type: 'number' },
      { name: 'Found', label: 'Found here', type: 'text' },
      { name: 'Elsewhere', label: 'Found but recorded elsewhere', type: 'text' },
      { name: 'Unknown', label: 'Unknown codes', type: 'text' },
      { name: 'Missing', label: 'Missing', type: 'text' },
      { name: 'Notes', label: 'Notes', type: 'text' }
    ]
  },
  Notifications: {
    title: 'Notifications', key: 'NoticeId', prefix: 'N', system: true,
    fields: [
      { name: 'NoticeId' }, { name: 'User' }, { name: 'Text' }, { name: 'Link' },
      { name: 'CreatedAt' }, { name: 'ReadAt' }
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
  ['PhotoFolderId', '', 'Drive folder for asset photos (filled automatically)'],
  ['AppUrl', 'https://foodlabs-assets.github.io/foodlabs-asset-system/', 'Link to the app used in e-mails'],
  ['MaintenanceTypes', 'Breakdown, Preventive, Other', 'Choices for the type of a maintenance request, separated by commas']
];

/** Cost centres as they are written in Xero, seeded once; edit or add more in admin. */
var SEED_COST_CENTERS = [
  'Boba - Salmiya', 'Boba - Sharq', 'Boba - Avenues', 'Boba - Qurain',
  "Philly's - Yarmouk", "Philly's - Salwa", "Philly's - The Lake", "Philly's - Hawally",
  "Smashy's - Yarmouk", 'Juiced - CK', 'Juiced - Coop - CK', 'Juiced - b2b - CK',
  'Tiramisu Creamery - CK', 'Bakery - CK'
];

/** Every alert shows on the in-app bell; the important ones also go by e-mail (editable in admin). */
var SEED_NOTIFICATION_TYPES = [
  ['MaintenanceNew', 'New maintenance request: to the technician, or to the area and operations managers when there is none', true],
  ['MaintenanceAssigned', 'Request passed to another technician: to that technician', true],
  ['MaintenanceWorkDone', 'Work done, waiting for the invoice: to accounting and the requester', false],
  ['MaintenanceClosed', 'Request closed: to the requester', false],
  ['MaintenanceCancelled', 'Request cancelled: to the technician', false],
  ['TransferSent', 'Asset on its way, waiting for receipt: to the receiving location and admin', true],
  ['TransferReceived', 'Asset received: to whoever asked for the transfer', false],
  ['CountGaps', 'Count finished with missing assets or assets from other locations: to admin and accounting', true],
  ['MissingFound', 'A missing asset was found again: to admin and accounting', false]
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

  seedCostCenters_();
  seedNotificationTypes_();

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

function seedNotificationTypes_() {
  var rows = readTableFromSheet_('NotificationTypes');
  SEED_NOTIFICATION_TYPES.forEach(function (t) {
    if (findBy_(rows, 'Event', t[0])) return;
    appendRow_('NotificationTypes', { Event: t[0], Description: t[1], Email: t[2], UpdatedAt: now_(), UpdatedBy: 'setup' });
  });
}

function seedCostCenters_() {
  if (readTableFromSheet_('CostCenters').length) return;
  SEED_COST_CENTERS.forEach(function (n, i) {
    appendRow_('CostCenters', { CostCenterId: 'CC-' + pad_(i + 1, 3), Name: n, Active: true, UpdatedAt: now_(), UpdatedBy: 'setup' });
  });
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

/** Run once from the editor after the e-mail alerts arrive: it asks for the mail permission and sends you a test. */
function testEmail() {
  var me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(me, 'Foodlabs Assets: test e-mail', 'E-mail alerts from the Foodlabs asset system work.');
  return 'Test e-mail sent to ' + me;
}

/** Run from the editor to re-apply the look of the data sheet without touching data. */
function formatSheets() {
  formatBook_(book_());
  return 'Formatted';
}

var SHEET_ORDER = ['Assets', 'Maintenance', 'Transfers', 'Counts', 'LegacyLines', 'LabelBatches', 'Users', 'Locations', 'Departments', 'Brands', 'CostCenters',
  'Categories', 'Types', 'Makes', 'LabelTemplates', 'XeroBalances', 'Settings', 'NotificationTypes', 'Notifications', 'AuditLog'];
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
    case 'search': return search_(user, p.q);
    case 'work': return work_(user);
    case 'requestMaintenance': return requestMaintenance_(user, p.code, p.request || {}, p.photos || []);
    case 'maintenance': return maintenanceDetail_(user, p.id);
    case 'updateMaintenance': return updateMaintenance_(user, p.id, p.step, p.values || {}, p.files || []);
    case 'file': return file_(user, p.id, p.fileId);
    case 'requestTransfer': return requestTransfer_(user, p.code, p.toLocationId, p.toDepartmentId, p.reason);
    case 'receiveTransfer': return receiveTransfer_(user, p.id, p.code);
    case 'cancelTransfer': return cancelTransfer_(user, p.id);
    case 'startCount': return startCount_(user, p.locationId);
    case 'countScans': return countScans_(user, p.id, p.codes || [], p.finish === true);
    case 'cancelCount': return cancelCount_(user, p.id);
    case 'count': return countDetail_(user, p.id);
    case 'notices': return notices_(user);
    case 'readNotices': return readNotices_(user, p.ids || []);
    case 'markFound': return markFound_(user, p.code);
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
  if (ids.length) {
    var brandNames = {};
    readTable_('Brands').forEach(function (b) { brandNames[b.BrandId] = b.Name; });
    readTable_('Locations').forEach(function (l) { names[l.LocationId] = locationLabel_(l, brandNames); });
  }
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
      tables[name] = { title: def.title, key: def.key, prefix: def.prefix || '', fields: def.fields, noAdd: !!def.noAdd };
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
  meta.work = work_(user);
  meta.notices = notices_(user);
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
  var brandNames = {};
  readTable_('Brands').forEach(function (b) { brandNames[b.BrandId] = b.Name; });
  var locations = simple('Locations', ['Type', 'Brand', 'CostCenterId']).map(function (l) {
    l.baseName = l.name;
    l.name = locationLabel_(l, brandNames);
    return l;
  });
  return {
    Categories: simple('Categories', ['AssetKind']),
    Types: simple('Types', ['CategoryId']),
    Locations: locations,
    Departments: simple('Departments', ['CostAllocation', 'CostCenters']),
    CostCenters: simple('CostCenters'),
    Technicians: readTable_('Users').filter(function (u) { return u.Role === 'Technician' && truthy_(u.Active); })
      .map(function (u) { return { id: String(u.Email), name: String(u.Name || u.Email) }; }),
    MaintenanceTypes: String(setting_('MaintenanceTypes') || 'Breakdown, Other').split(',')
      .map(function (x) { return x.trim(); }).filter(String),
    Brands: simple('Brands'),
    Makes: simple('Makes', ['Status']),
    LabelTemplates: simple('LabelTemplates', ['WidthMm', 'HeightMm'])
  };
}

/** "Philly's - Yarmouk": the brand in front, so two brands can share a place name. */
function locationLabel_(loc, brandNames) {
  var name = String(loc.Name !== undefined ? loc.Name : loc.name);
  var b = brandNames[loc.Brand];
  return b ? b + ' - ' + name : name;
}

/**
 * Where an asset's depreciation goes, in order: the asset's own exception,
 * the location's cost centre (branches), the department's rule (central
 * kitchen, offices). Shared amounts are later split by each centre's sales.
 * Returns { source, whole, ids }.
 */
function costCentersFor_(asset, t) {
  var own = splitIds_(asset.CostCenters);
  if (own.length) return { source: 'Asset', whole: false, ids: own };
  var loc = findBy_(t.Locations, 'LocationId', asset.LocationId);
  if (loc && loc.CostCenterId) return { source: 'Location', whole: false, ids: [String(loc.CostCenterId)] };
  var dep = findBy_(t.Departments, 'DepartmentId', asset.DepartmentId);
  if (dep && dep.CostAllocation === 'Selected cost centres' && splitIds_(dep.CostCenters).length) {
    return { source: 'Department', whole: false, ids: splitIds_(dep.CostCenters) };
  }
  return { source: dep ? 'Department' : 'Default', whole: true, ids: [] };
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
  if ((table === 'Settings' || def.noAdd) && isNew) throw appError_('INVALID', 'This list cannot be added to from the app.');

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
  var mine = splitIds_(user.Locations);
  if (mine.indexOf(String(asset.LocationId)) !== -1) return true;
  // The receiving manager sees an asset on its way to them.
  return readTable_('Transfers').some(function (t) {
    return t.AssetCode === asset.AssetCode && t.Status === 'Awaiting receipt' && mine.indexOf(String(t.ToLocationId)) !== -1;
  });
}

function lookupAsset_(user, code) {
  var parsed = parseCode_(code);
  if (!parsed) return { status: 'invalid', code: String(code || '') };
  var asset = findBy_(readTable_('Assets'), 'AssetCode', parsed.code);
  if (asset) {
    if (!canSeeAsset_(user, asset)) return { status: 'elsewhere', code: parsed.code };
    return { status: 'registered', code: parsed.code, asset: assetView_(asset, isFinance_(user)),
      context: assetContext_(user, asset) };
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
    ['PurchaseDate', 'Cost', 'OpeningAccumDepr', 'LifeMonths', 'RemainingMonths', 'Supplier', 'InvoiceNo', 'CostCenters'].forEach(function (k) {
      if (values[k] === undefined) return;
      var f = fieldOf_('Assets', k);
      var v = coerce_(f, values[k]);
      if (k === 'CostCenters') {
        var known = readTable_('CostCenters').map(function (c) { return String(c.CostCenterId); });
        splitIds_(v).forEach(function (id) { if (known.indexOf(id) === -1) throw appError_('INVALID', 'Unknown cost centre ' + id + '.'); });
      }
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

// ===========================================================================
// Phase 3: operations — maintenance, transfers, stock counts, notifications
// ===========================================================================

function isAdmin_(user) { return ADMIN_ROLES.indexOf(user.Role) !== -1; }
function myLocations_(user) { return splitIds_(user.Locations); }
function locName_(id) {
  var brandNames = {};
  readTable_('Brands').forEach(function (b) { brandNames[b.BrandId] = b.Name; });
  var l = findBy_(readTable_('Locations'), 'LocationId', id);
  return l ? locationLabel_(l, brandNames) : String(id || '');
}
function assetByCode_(code) {
  return findBy_(readTable_('Assets'), 'AssetCode', String(code || '').trim().toUpperCase());
}
function userName_(email) {
  var u = findBy_(readTable_('Users'), 'Email', email);
  return u ? String(u.Name || u.Email) : String(email || '');
}
/** Managers act on assets of their own locations; admin and accounting on all. */
function canActOnAsset_(user, asset) {
  if (isAdmin_(user)) return true;
  return user.Role === 'Manager' && myLocations_(user).indexOf(String(asset.LocationId)) !== -1;
}
function longText_(label, v, max) {
  v = String(v === undefined || v === null ? '' : v).trim();
  if (v.length > (max || 1000)) throw appError_('INVALID', label + ' is too long.');
  if (/^[=+\-@]/.test(v)) v = "'" + v;
  return v;
}
function addCode_(list, code) {
  var arr = splitIds_(list);
  if (arr.indexOf(code) === -1) arr.push(code);
  return arr.join(',');
}

// ----- Notifications (in-app bell; e-mail comes with the scheduled jobs)

function notify_(emails, text, link, event) {
  var seen = {};
  var mail = event ? emailOn_(event) : false;
  (Array.isArray(emails) ? emails : [emails]).forEach(function (e) {
    e = String(e || '').toLowerCase();
    if (!e || seen[e]) return;
    seen[e] = true;
    var rows = readTableFromSheet_('Notifications');
    appendRow_('Notifications', { NoticeId: nextId_(rows, 'NoticeId', 'N'), User: e, Text: String(text).slice(0, 300),
      Link: link || '', CreatedAt: now_(), ReadAt: '' });
    if (mail) sendMail_(e, text, link);
  });
}
function emailOn_(event) {
  var row = findBy_(readTable_('NotificationTypes'), 'Event', event);
  return !!row && truthy_(row.Email);
}
/** E-mail for the alerts switched on in admin. A failure (quota, permission) never stops the action itself. */
function sendMail_(to, text, link) {
  try {
    var url = String(setting_('AppUrl') || 'https://foodlabs-assets.github.io/foodlabs-asset-system/') + (link || '');
    MailApp.sendEmail({
      to: to,
      subject: 'Foodlabs Assets: ' + String(text).slice(0, 90),
      body: text + '\n\nOpen in the app: ' + url + '\n\nThis is an automatic message from the Foodlabs asset system.',
      htmlBody: '<p style="font-family:Arial,sans-serif;font-size:14px">' + htmlEsc_(text) + '</p>' +
        '<p><a href="' + htmlEsc_(url) + '" style="background:#0f5e4b;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px">Open in the app</a></p>' +
        '<p style="font-family:Arial,sans-serif;font-size:12px;color:#777">Automatic message from the Foodlabs asset system.</p>',
      name: 'Foodlabs Assets'
    });
  } catch (err) {
    console.error('Mail to ' + to + ' failed: ' + (err && err.message || err));
  }
}
function htmlEsc_(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}
function usersWithRole_(roles) {
  return readTable_('Users').filter(function (u) { return roles.indexOf(u.Role) !== -1 && truthy_(u.Active); })
    .map(function (u) { return u.Email; });
}
function managersOf_(locationId) {
  return readTable_('Users').filter(function (u) {
    return u.Role === 'Manager' && truthy_(u.Active) && splitIds_(u.Locations).indexOf(String(locationId)) !== -1;
  }).map(function (u) { return u.Email; });
}
function notices_(user) {
  var mine = readTable_('Notifications').filter(function (n) { return String(n.User).toLowerCase() === user.Email; });
  var unread = mine.filter(function (n) { return !n.ReadAt; }).length;
  return { unread: unread, items: mine.slice(-30).reverse().map(function (n) {
    return { id: n.NoticeId, text: n.Text, link: n.Link, at: n.CreatedAt, read: !!n.ReadAt };
  }) };
}
function readNotices_(user, ids) {
  return withLock_(function () {
    var rows = readTableFromSheet_('Notifications');
    var all = ids === 'all' || (Array.isArray(ids) && ids.length === 0);
    var hit = rows.filter(function (n) {
      return String(n.User).toLowerCase() === user.Email && !n.ReadAt && (all || ids.indexOf(n.NoticeId) !== -1);
    }).map(function (n) { return n.__row; });
    setColumns_('Notifications', hit, { ReadAt: now_() });
    return notices_(user);
  });
}

// ----- Search: code, name, serial number, request or transfer number

function search_(user, q) {
  q = String(q || '').trim().slice(0, 100);
  if (q.length < 2) return { assets: [], requests: [], transfers: [] };
  var lq = q.toLowerCase();
  var fin = isFinance_(user);
  var assets = readTable_('Assets').filter(function (a) {
    return canSeeAsset_(user, a) && [a.AssetCode, a.Name, a.SerialNo, a.Model].some(function (v) {
      return String(v || '').toLowerCase().indexOf(lq) !== -1;
    });
  }).slice(0, 30).map(function (a) {
    return { code: a.AssetCode, name: a.Name, location: locName_(a.LocationId), status: a.Status, serial: a.SerialNo };
  });
  var requests = readTable_('Maintenance').filter(function (r) {
    return String(r.RequestId).toLowerCase() === lq && canSeeRequest_(user, r);
  }).map(function (r) { return maintenanceView_(r, fin); });
  var transfers = readTable_('Transfers').filter(function (t) {
    return String(t.TransferId).toLowerCase() === lq && canSeeTransfer_(user, t);
  }).map(transferView_);
  return { assets: assets, requests: requests, transfers: transfers };
}

// ----- What is waiting for this user (home page)

function work_(user) {
  var fin = isFinance_(user);
  var mine = myLocations_(user);
  var reqs = readTable_('Maintenance');
  var trs = readTable_('Transfers');
  var out = { maintenance: [], transfers: [], counts: [], missing: [] };
  var open = ['Open', 'In progress', 'Work done'];
  reqs.forEach(function (r) {
    if (open.indexOf(r.Status) === -1) return;
    var take = false;
    if (user.Role === 'Technician') take = String(r.Technician).toLowerCase() === user.Email && r.Status !== 'Work done';
    else if (isAdmin_(user)) take = true;
    else if (isBackup_(user)) take = true;
    else if (user.Role === 'Manager') take = mine.indexOf(String(r.LocationId)) !== -1;
    else if (user.Role === 'Management') take = true;
    if (take) out.maintenance.push(maintenanceView_(r, fin));
  });
  trs.forEach(function (t) {
    if (t.Status !== 'Awaiting receipt') return;
    if (canSeeTransfer_(user, t)) out.transfers.push(transferView_(t));
  });
  readTable_('Counts').forEach(function (c) {
    if (c.Status !== 'Open') return;
    if (isAdmin_(user) || c.StartedBy === user.Email || mine.indexOf(String(c.LocationId)) !== -1) out.counts.push(countView_(c, false));
  });
  readTable_('Assets').forEach(function (a) {
    if (a.Status !== 'Missing') return;
    if (isFinance_(user) || isAdmin_(user) || mine.indexOf(String(a.LocationId)) !== -1) {
      out.missing.push({ code: a.AssetCode, name: a.Name, location: locName_(a.LocationId), since: a.MissingSince || '', count: a.MissingCount || '' });
    }
  });
  out.maintenance.reverse(); out.transfers.reverse();
  return out;
}

/** Open maintenance and pending transfer for the asset card. */
function assetContext_(user, asset) {
  var fin = isFinance_(user);
  var reqs = readTable_('Maintenance').filter(function (r) { return r.AssetCode === asset.AssetCode; });
  var openReq = reqs.filter(function (r) { return ['Open', 'In progress', 'Work done'].indexOf(r.Status) !== -1; })
    .map(function (r) { return maintenanceView_(r, fin); });
  var tr = readTable_('Transfers').filter(function (t) { return t.AssetCode === asset.AssetCode && t.Status === 'Awaiting receipt'; })[0];
  var mine = myLocations_(user);
  var ctx = {
    openRequests: openReq,
    history: reqs.filter(function (r) { return r.Status === 'Closed'; }).slice(-10).reverse().map(function (r) { return maintenanceView_(r, fin); }),
    transfer: tr ? transferView_(tr) : null,
    canRequestMaintenance: asset.Status !== 'Disposed' && asset.Status !== 'Missing' && canActOnAsset_(user, asset),
    canMarkFound: asset.Status === 'Missing' && (canActOnAsset_(user, asset) || user.Role === 'CountTeam'),
    canTransfer: !tr && (asset.Status === 'Active' || asset.Status === 'In maintenance') && canActOnAsset_(user, asset),
    canReceive: !!tr && (isAdmin_(user) || mine.indexOf(String(tr.ToLocationId)) !== -1),
    canCancelTransfer: !!tr && (isAdmin_(user) || tr.RequestedBy === user.Email),
    maintenanceCost: fin ? round3_(reqs.reduce(function (s, r) { return s + (r.Status === 'Closed' ? Number(r.Cost) || 0 : 0); }, 0)) : null
  };
  return ctx;
}

// ----- Maintenance

function canSeeRequest_(user, r) {
  if (isFinance_(user) || isBackup_(user)) return true;
  if (user.Role === 'Technician') return String(r.Technician).toLowerCase() === user.Email;
  if (r.RequestedBy === user.Email) return true;
  return myLocations_(user).indexOf(String(r.LocationId)) !== -1;
}
function maintenanceView_(r, finance) {
  var out = {};
  SCHEMA.Maintenance.fields.forEach(function (f) {
    if (f.finance && !finance) return;
    out[f.name] = r[f.name] === undefined ? '' : r[f.name];
  });
  out.Photos = splitIds_(r.Photos);
  if (finance) out.InvoiceFiles = splitIds_(r.InvoiceFiles);
  var a = assetByCode_(r.AssetCode);
  out.AssetName = a ? a.Name : '';
  out.LocationName = locName_(r.LocationId);
  out.TechnicianName = r.Technician ? userName_(r.Technician) : '';
  out.RequestedByName = userName_(r.RequestedBy);
  return out;
}
/** The company technician: the active user with the Technician role (the first, if there are several). */
function defaultTechnician_() {
  var t = readTable_('Users').filter(function (u) { return u.Role === 'Technician' && truthy_(u.Active); })[0];
  return t ? String(t.Email).toLowerCase() : '';
}
/** People who take requests when there is no technician (area manager, operations manager). */
function maintenanceBackups_() {
  return readTable_('Users').filter(function (u) { return truthy_(u.MaintenanceBackup) && truthy_(u.Active); })
    .map(function (u) { return String(u.Email).toLowerCase(); });
}
function isBackup_(user) { return truthy_(user.MaintenanceBackup); }
function checkTechnician_(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return '';
  var u = findBy_(readTable_('Users'), 'Email', email);
  if (!u || u.Role !== 'Technician' || !truthy_(u.Active)) throw appError_('INVALID', 'Pick a technician from the list.');
  return email;
}
function savePrivateFiles_(prefix, files, allowPdf) {
  if (!files.length) return [];
  if (files.length > 4) throw appError_('INVALID', 'Up to 4 files at a time.');
  var folder = photoFolder_();
  return files.map(function (p, i) {
    var m = String(p || '').match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,(.+)$/);
    if (!m || (!allowPdf && m[1] === 'application/pdf')) throw appError_('INVALID', allowPdf ? 'Attach PDF or image files.' : 'Photos must be JPEG, PNG or WebP images.');
    var bytes = Utilities.base64Decode(m[2]);
    if (bytes.length > 4000000) throw appError_('INVALID', 'A file is too large (4 MB at most).');
    var ext = m[1] === 'application/pdf' ? 'pdf' : m[1] === 'image/jpeg' ? 'jpg' : m[1].split('/')[1];
    return folder.createFile(Utilities.newBlob(bytes, m[1], prefix + '-' + (i + 1) + '.' + ext)).getId();
  });
}

function requestMaintenance_(user, code, input, photos) {
  var asset = assetByCode_(code);
  if (!asset) throw appError_('NOT_FOUND', 'Asset not found.');
  if (!canActOnAsset_(user, asset)) throw appError_('FORBIDDEN', 'You can request maintenance only for assets of your locations.');
  if (asset.Status === 'Disposed') throw appError_('INVALID', 'This asset is disposed.');
  if (asset.Status === 'Missing') throw appError_('INVALID', 'This asset is marked missing. Mark it found first.');
  var types = String(setting_('MaintenanceTypes') || '').split(',').map(function (x) { return x.trim(); }).filter(String);
  var type = longText_('Type', input.Type, 60);
  if (types.length && types.indexOf(type) === -1) throw appError_('INVALID', 'Choose the type from the list.');
  var desc = longText_('Description', input.Description, 1000);
  if (!desc) throw appError_('INVALID', 'Describe the problem.');
  var priority = MR_PRIORITIES.indexOf(input.Priority) !== -1 ? input.Priority : 'Normal';
  var tech = input.Technician ? checkTechnician_(input.Technician) : defaultTechnician_();
  if (photos.length > 4) throw appError_('INVALID', 'Up to 4 photos.');
  return withLock_(function () {
    var rows = readTableFromSheet_('Maintenance');
    var id = nextId_(rows, 'RequestId', 'MR');
    var rec = { RequestId: id, AssetCode: asset.AssetCode, LocationId: asset.LocationId, Type: type, Priority: priority,
      Description: desc, Photos: savePrivateFiles_(id, photos, false).join(','), Technician: tech, Status: 'Open',
      RequestedAt: now_(), RequestedBy: user.Email, UpdatedAt: now_(), UpdatedBy: user.Email };
    appendRow_('Maintenance', rec);
    audit_(user.Email, 'Maintenance', id, 'create', '', '', asset.AssetCode + ' ' + type);
    setAssetStatus_(user, asset.AssetCode, 'In maintenance', id);
    var link = '#/maintenance/' + id;
    var what = id + ': ' + asset.Name + ' at ' + locName_(asset.LocationId) + (priority === 'Urgent' ? ' (urgent)' : '');
    if (tech) notify_(tech, 'New maintenance request ' + what, link, 'MaintenanceNew');
    else {
      var backups = maintenanceBackups_();
      notify_(backups.length ? backups : usersWithRole_(['Admin']), 'New maintenance request ' + what + ' (no technician): please arrange it.', link, 'MaintenanceNew');
    }
    return { request: maintenanceView_(rec, isFinance_(user)) };
  });
}

function setAssetStatus_(user, code, status, why) {
  var rows = readTableFromSheet_('Assets');
  var a = findBy_(rows, 'AssetCode', code);
  if (!a || a.Status === status) return;
  if (a.Status === 'Disposed' || (a.Status === 'Under review' && status !== 'Under review')) return; // never reopen
  updateRow_('Assets', a.__row, { Status: status, UpdatedAt: now_(), UpdatedBy: user.Email });
  audit_(user.Email, 'Assets', code, 'update', 'Status', a.Status, status + (why ? ' (' + why + ')' : ''));
}

function maintenanceDetail_(user, id) {
  var r = findBy_(readTable_('Maintenance'), 'RequestId', String(id || '').toUpperCase());
  if (!r || !canSeeRequest_(user, r)) throw appError_('NOT_FOUND', 'Request not found.');
  return { request: maintenanceView_(r, isFinance_(user)), can: maintenanceCan_(user, r) };
}
function maintenanceCan_(user, r) {
  var isTech = user.Role === 'Technician' && String(r.Technician).toLowerCase() === user.Email;
  // With no technician on it, the backups (area and operations managers) handle the request.
  var handles = isTech || isAdmin_(user) || (isBackup_(user) && !r.Technician);
  var active = ['Open', 'In progress'].indexOf(r.Status) !== -1;
  return {
    start: handles && r.Status === 'Open',
    workDone: handles && active,
    assign: (isAdmin_(user) || isBackup_(user)) && active,
    close: user.Role === 'Accounting' || user.Role === 'Admin' ? r.Status === 'Work done' : false,
    cancel: (isAdmin_(user) || (r.RequestedBy === user.Email && r.Status === 'Open')) && active
  };
}

function updateMaintenance_(user, id, step, values, files) {
  return withLock_(function () {
    var rows = readTableFromSheet_('Maintenance');
    var r = findBy_(rows, 'RequestId', String(id || '').toUpperCase());
    if (!r || !canSeeRequest_(user, r)) throw appError_('NOT_FOUND', 'Request not found.');
    var can = maintenanceCan_(user, r);
    var upd = {};
    var link = '#/maintenance/' + r.RequestId;
    var asset = assetByCode_(r.AssetCode) || {};
    var label = r.RequestId + ' (' + (asset.Name || r.AssetCode) + ')';
    if (step === 'start') {
      if (!can.start) throw appError_('FORBIDDEN', 'You cannot start this request.');
      upd.Status = 'In progress';
    } else if (step === 'assign') {
      if (!can.assign) throw appError_('FORBIDDEN', 'Only admin or the operations managers can reassign.');
      upd.Technician = checkTechnician_(values.Technician);
      if (!upd.Technician) throw appError_('INVALID', 'Pick a technician.');
    } else if (step === 'workDone') {
      if (!can.workDone) throw appError_('FORBIDDEN', 'Only the assigned technician can record the work.');
      var notes = longText_('Work done', values.WorkNotes, 1000);
      if (!notes) throw appError_('INVALID', 'Describe the work done.');
      if (MR_OUTCOMES.indexOf(values.Outcome) === -1) throw appError_('INVALID', 'Choose the outcome.');
      upd.Status = 'Work done'; upd.WorkNotes = notes; upd.Outcome = values.Outcome;
      upd.WorkDoneAt = now_(); upd.WorkDoneBy = user.Email;
    } else if (step === 'close') {
      if (!can.close) throw appError_('FORBIDDEN', 'Accounting closes the request after the work is done.');
      var cost = values.Cost === '' || values.Cost === undefined || values.Cost === null ? '' : Number(values.Cost);
      if (cost === '' || !isFinite(cost) || cost < 0) throw appError_('INVALID', 'Enter the cost (0 if there was no charge).');
      upd.Cost = round3_(cost);
      upd.Supplier = longText_('Supplier', values.Supplier, 120);
      upd.InvoiceNo = longText_('Invoice number', values.InvoiceNo, 60);
      if (cost > 0 && !files.length && !splitIds_(r.InvoiceFiles).length) throw appError_('INVALID', 'Attach the invoice.');
      var saved = savePrivateFiles_(r.RequestId + '-invoice', files, true);
      upd.InvoiceFiles = splitIds_(r.InvoiceFiles).concat(saved).join(',');
      upd.Status = 'Closed'; upd.ClosedAt = now_(); upd.ClosedBy = user.Email;
    } else if (step === 'cancel') {
      if (!can.cancel) throw appError_('FORBIDDEN', 'You cannot cancel this request.');
      upd.Status = 'Cancelled'; upd.Notes = longText_('Reason', values.Reason, 300); upd.ClosedAt = now_(); upd.ClosedBy = user.Email;
    } else {
      throw appError_('BAD_REQUEST', 'Unknown step.');
    }
    upd.UpdatedAt = now_(); upd.UpdatedBy = user.Email;
    updateRow_('Maintenance', r.__row, upd);
    Object.keys(upd).forEach(function (k) {
      if (k === 'UpdatedAt' || k === 'UpdatedBy') return;
      audit_(user.Email, 'Maintenance', r.RequestId, 'update', k, normForCompare_(r[k]), normForCompare_(upd[k]));
    });
    // Asset status follows the request: back to Active once no request keeps it in maintenance.
    if (upd.Status === 'Work done' || upd.Status === 'Cancelled' || upd.Status === 'Closed') {
      var stillOpen = rows.some(function (x) {
        return x.AssetCode === r.AssetCode && x.RequestId !== r.RequestId && ['Open', 'In progress'].indexOf(x.Status) !== -1;
      });
      if (!stillOpen) setAssetStatus_(user, r.AssetCode, 'Active', r.RequestId);
    }
    if (step === 'assign') notify_(upd.Technician, 'Maintenance request ' + label + ' was assigned to you.', link, 'MaintenanceAssigned');
    if (step === 'workDone') {
      notify_(usersWithRole_(['Accounting']).concat([r.RequestedBy]), 'Work done on ' + label + ': ' + upd.Outcome + '. Waiting for the invoice.', link, 'MaintenanceWorkDone');
    }
    if (step === 'close') notify_(r.RequestedBy, 'Maintenance request ' + label + ' is closed.', link, 'MaintenanceClosed');
    if (step === 'cancel' && r.Technician) notify_(r.Technician, 'Maintenance request ' + label + ' was cancelled.', link, 'MaintenanceCancelled');
    var fresh = findBy_(readTableFromSheet_('Maintenance'), 'RequestId', r.RequestId);
    return { request: maintenanceView_(fresh, isFinance_(user)), can: maintenanceCan_(user, fresh) };
  });
}

/** Photos and invoices of a request, served only to people who may see it. */
function file_(user, id, fileId) {
  var r = findBy_(readTable_('Maintenance'), 'RequestId', String(id || '').toUpperCase());
  if (!r || !canSeeRequest_(user, r)) throw appError_('NOT_FOUND', 'Request not found.');
  var allowed = splitIds_(r.Photos).concat(isFinance_(user) ? splitIds_(r.InvoiceFiles) : []);
  if (allowed.indexOf(String(fileId)) === -1) throw appError_('NOT_FOUND', 'File not found.');
  var blob = DriveApp.getFileById(fileId).getBlob();
  return { dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()), name: blob.getName() };
}

// ----- Transfers: custody moves only when the receiving location scans the asset

function canSeeTransfer_(user, t) {
  if (isFinance_(user)) return true;
  if (t.RequestedBy === user.Email) return true;
  var mine = myLocations_(user);
  return mine.indexOf(String(t.FromLocationId)) !== -1 || mine.indexOf(String(t.ToLocationId)) !== -1;
}
function transferView_(t) {
  var out = pick_(t, SCHEMA.Transfers);
  var a = assetByCode_(t.AssetCode);
  out.AssetName = a ? a.Name : '';
  out.FromName = locName_(t.FromLocationId);
  out.ToName = locName_(t.ToLocationId);
  out.RequestedByName = userName_(t.RequestedBy);
  return out;
}

function requestTransfer_(user, code, toLocationId, toDepartmentId, reason) {
  var asset = assetByCode_(code);
  if (!asset) throw appError_('NOT_FOUND', 'Asset not found.');
  if (!canActOnAsset_(user, asset)) throw appError_('FORBIDDEN', 'You can move only assets of your locations.');
  if (['Active', 'In maintenance'].indexOf(asset.Status) === -1) throw appError_('INVALID', 'Only active assets can be moved.');
  var to = findBy_(readTable_('Locations'), 'LocationId', toLocationId);
  if (!to || !truthy_(to.Active)) throw appError_('INVALID', 'Choose where the asset goes.');
  if (String(to.LocationId) === String(asset.LocationId)) throw appError_('INVALID', 'The asset is already at that location.');
  if (toDepartmentId && !findBy_(readTable_('Departments'), 'DepartmentId', toDepartmentId)) throw appError_('INVALID', 'Unknown department.');
  return withLock_(function () {
    var rows = readTableFromSheet_('Transfers');
    if (rows.some(function (t) { return t.AssetCode === asset.AssetCode && t.Status === 'Awaiting receipt'; })) {
      throw appError_('INVALID', 'This asset already has a transfer waiting for receipt.');
    }
    var id = nextId_(rows, 'TransferId', 'TR');
    var rec = { TransferId: id, AssetCode: asset.AssetCode, FromLocationId: asset.LocationId, ToLocationId: to.LocationId,
      ToDepartmentId: toDepartmentId || '', Reason: longText_('Reason', reason, 300), Status: 'Awaiting receipt',
      RequestedAt: now_(), RequestedBy: user.Email, UpdatedAt: now_(), UpdatedBy: user.Email };
    appendRow_('Transfers', rec);
    audit_(user.Email, 'Transfers', id, 'create', '', '', asset.AssetCode + ' ' + asset.LocationId + ' -> ' + to.LocationId);
    notify_(managersOf_(to.LocationId).concat(usersWithRole_(['Admin'])),
      asset.Name + ' (' + asset.AssetCode + ') is on its way to ' + locName_(to.LocationId) + '. Scan it when it arrives.', '#/scan/' + asset.AssetCode, 'TransferSent');
    return { transfer: transferView_(rec) };
  });
}

function receiveTransfer_(user, id, code) {
  return withLock_(function () {
    var rows = readTableFromSheet_('Transfers');
    var t = findBy_(rows, 'TransferId', String(id || '').toUpperCase());
    if (!t || t.Status !== 'Awaiting receipt') throw appError_('NOT_FOUND', 'No transfer waiting for receipt.');
    if (String(code || '').toUpperCase() !== t.AssetCode) throw appError_('INVALID', 'Scan the asset itself to confirm receipt.');
    if (!isAdmin_(user) && myLocations_(user).indexOf(String(t.ToLocationId)) === -1) {
      throw appError_('FORBIDDEN', 'Only the receiving location can confirm receipt.');
    }
    updateRow_('Transfers', t.__row, { Status: 'Received', ReceivedAt: now_(), ReceivedBy: user.Email, UpdatedAt: now_(), UpdatedBy: user.Email });
    var assets = readTableFromSheet_('Assets');
    var a = findBy_(assets, 'AssetCode', t.AssetCode);
    var upd = { LocationId: t.ToLocationId, UpdatedAt: now_(), UpdatedBy: user.Email };
    if (t.ToDepartmentId) upd.DepartmentId = t.ToDepartmentId;
    // The asset takes the new location's brand, or none where the location has none (central kitchen, office).
    var to = findBy_(readTable_('Locations'), 'LocationId', t.ToLocationId);
    upd.BrandId = to && to.Brand ? String(to.Brand) : '';
    // Depreciation follows the new location: an exception set for the old place no longer applies.
    if (a.CostCenters) upd.CostCenters = '';
    updateRow_('Assets', a.__row, upd);
    if (a.CostCenters) audit_(user.Email, 'Assets', t.AssetCode, 'update', 'CostCenters', a.CostCenters, '(cleared on transfer ' + t.TransferId + ')');
    audit_(user.Email, 'Transfers', t.TransferId, 'update', 'Status', 'Awaiting receipt', 'Received');
    audit_(user.Email, 'Assets', t.AssetCode, 'update', 'LocationId', a.LocationId, t.ToLocationId + ' (' + t.TransferId + ')');
    if (upd.DepartmentId && upd.DepartmentId !== a.DepartmentId) audit_(user.Email, 'Assets', t.AssetCode, 'update', 'DepartmentId', a.DepartmentId, upd.DepartmentId);
    if (upd.BrandId !== String(a.BrandId || '')) audit_(user.Email, 'Assets', t.AssetCode, 'update', 'BrandId', a.BrandId, upd.BrandId);
    notify_(t.RequestedBy, (a.Name || t.AssetCode) + ' was received at ' + locName_(t.ToLocationId) + '.', '#/scan/' + t.AssetCode, 'TransferReceived');
    var fresh = findBy_(readTableFromSheet_('Assets'), 'AssetCode', t.AssetCode);
    return { asset: assetView_(fresh, isFinance_(user)), context: assetContext_(user, fresh) };
  });
}

function cancelTransfer_(user, id) {
  return withLock_(function () {
    var rows = readTableFromSheet_('Transfers');
    var t = findBy_(rows, 'TransferId', String(id || '').toUpperCase());
    if (!t || t.Status !== 'Awaiting receipt') throw appError_('NOT_FOUND', 'No transfer waiting for receipt.');
    if (!isAdmin_(user) && t.RequestedBy !== user.Email) throw appError_('FORBIDDEN', 'Only the person who asked for it can cancel.');
    updateRow_('Transfers', t.__row, { Status: 'Cancelled', UpdatedAt: now_(), UpdatedBy: user.Email });
    audit_(user.Email, 'Transfers', t.TransferId, 'update', 'Status', 'Awaiting receipt', 'Cancelled');
    var a = assetByCode_(t.AssetCode);
    return { asset: assetView_(a, isFinance_(user)), context: assetContext_(user, a) };
  });
}

// ----- Stock count: scan a location's assets, then report found, missing and found elsewhere

function canCount_(user, locationId) {
  if (isAdmin_(user) || user.Role === 'CountTeam') return true;
  return user.Role === 'Manager' && myLocations_(user).indexOf(String(locationId)) !== -1;
}
function isTangible_(asset) {
  var cat = findBy_(readTable_('Categories'), 'CategoryId', asset.CategoryId);
  return !cat || cat.AssetKind !== 'Intangible';
}
function expectedAt_(locationId) {
  return readTable_('Assets').filter(function (a) {
    var parsed = parseCode_(a.AssetCode);
    return String(a.LocationId) === String(locationId) && a.Status !== 'Disposed' &&
      !(parsed && parsed.noLabel) && isTangible_(a);
  });
}
function countView_(c, withLists) {
  var out = { CountId: c.CountId, LocationId: c.LocationId, LocationName: locName_(c.LocationId), Status: c.Status,
    StartedAt: c.StartedAt, StartedBy: c.StartedBy, FinishedAt: c.FinishedAt, Expected: Number(c.Expected) || 0,
    found: splitIds_(c.Found).length, elsewhere: splitIds_(c.Elsewhere).length, unknown: splitIds_(c.Unknown).length,
    missing: splitIds_(c.Missing).length };
  if (withLists) {
    var all = readTable_('Assets');
    var describe = function (code) {
      var a = findBy_(all, 'AssetCode', code);
      return a ? { code: code, name: a.Name, location: locName_(a.LocationId), status: a.Status } : { code: code, name: '', location: '', status: '' };
    };
    out.lists = { found: splitIds_(c.Found).map(describe), elsewhere: splitIds_(c.Elsewhere).map(describe),
      unknown: splitIds_(c.Unknown).map(function (x) { return { code: x }; }), missing: splitIds_(c.Missing).map(describe) };
  }
  return out;
}

function startCount_(user, locationId) {
  var loc = findBy_(readTable_('Locations'), 'LocationId', locationId);
  if (!loc) throw appError_('INVALID', 'Choose a location.');
  if (!canCount_(user, locationId)) throw appError_('FORBIDDEN', 'You can count only your own locations.');
  return withLock_(function () {
    var rows = readTableFromSheet_('Counts');
    var open = rows.filter(function (c) { return c.Status === 'Open' && String(c.LocationId) === String(locationId); })[0];
    if (!open) {
      open = { CountId: nextId_(rows, 'CountId', 'CNT'), LocationId: loc.LocationId, Status: 'Open', StartedAt: now_(),
        StartedBy: user.Email, Expected: expectedAt_(loc.LocationId).length, Found: '', Elsewhere: '', Unknown: '', Missing: '',
        UpdatedAt: now_(), UpdatedBy: user.Email };
      appendRow_('Counts', open);
      audit_(user.Email, 'Counts', open.CountId, 'create', '', '', loc.LocationId);
    }
    // Everything the scanner needs to answer at once, without a round trip per scan.
    var expected = expectedAt_(loc.LocationId).map(function (a) { return { code: a.AssetCode, name: a.Name }; });
    return { count: countView_(open, false), expected: expected, scanned: splitIds_(open.Found).concat(splitIds_(open.Elsewhere), splitIds_(open.Unknown)) };
  });
}

function countScans_(user, id, codes, finish) {
  if (!Array.isArray(codes) || codes.length > 500) throw appError_('INVALID', 'Send up to 500 scans at a time.');
  return withLock_(function () {
    var rows = readTableFromSheet_('Counts');
    var c = findBy_(rows, 'CountId', String(id || '').toUpperCase());
    if (!c || c.Status !== 'Open') throw appError_('NOT_FOUND', 'This count is not open.');
    if (!canCount_(user, c.LocationId)) throw appError_('FORBIDDEN', 'You cannot count this location.');
    var assets = readTableFromSheet_('Assets');
    var found = c.Found, elsewhere = c.Elsewhere, unknown = c.Unknown;
    var results = codes.map(function (raw) {
      var parsed = parseCode_(raw);
      // Unknown codes are kept for the report: letters, digits and dashes only, so nothing odd reaches the sheet.
      var code = parsed ? parsed.code : String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/^-+/, '').slice(0, 40);
      if (!code) return null;
      var a = parsed ? findBy_(assets, 'AssetCode', code) : null;
      if (a && a.Status !== 'Disposed' && String(a.LocationId) === String(c.LocationId)) { found = addCode_(found, code); return { code: code, result: 'found', name: a.Name }; }
      if (a && a.Status !== 'Disposed') { elsewhere = addCode_(elsewhere, code); return { code: code, result: 'elsewhere', name: a.Name, location: locName_(a.LocationId) }; }
      if (code.indexOf(',') === -1) unknown = addCode_(unknown, code);
      return { code: code, result: 'unknown' };
    }).filter(Boolean);
    // A missing asset that turns up in any count is active again.
    var back = results.filter(function (r) { return r.result !== 'unknown'; }).map(function (r) { return findBy_(assets, 'AssetCode', r.code); })
      .filter(function (a) { return a && a.Status === 'Missing'; });
    back.forEach(function (a) {
      updateRow_('Assets', a.__row, { Status: 'Active', MissingSince: '', MissingCount: '', UpdatedAt: now_(), UpdatedBy: user.Email });
      a.Status = 'Active';
      audit_(user.Email, 'Assets', a.AssetCode, 'update', 'Status', 'Missing', 'Active (found in ' + c.CountId + ')');
    });
    if (back.length) notify_(usersWithRole_(['Admin', 'Accounting']), back.length + ' missing asset(s) found again in count ' + c.CountId + ': ' +
      back.map(function (a) { return a.AssetCode; }).join(', ') + '.', '#/count/' + c.CountId, 'MissingFound');
    var upd = { Found: found, Elsewhere: elsewhere, Unknown: unknown, UpdatedAt: now_(), UpdatedBy: user.Email };
    if (finish) {
      var seen = splitIds_(found);
      var expected = expectedAt_(c.LocationId);
      upd.Missing = expected.filter(function (a) { return seen.indexOf(a.AssetCode) === -1; }).map(function (a) { return a.AssetCode; }).join(',');
      upd.Expected = expected.length;
      upd.Status = 'Finished'; upd.FinishedAt = now_(); upd.FinishedBy = user.Email;
      var stamp = now_();
      setColumns_('Assets', assets.filter(function (a) { return seen.indexOf(a.AssetCode) !== -1; }).map(function (a) { return a.__row; }),
        { LastCountAt: stamp, LastCountBy: user.Email });
      // Not scanned: an active asset becomes Missing until it is found again.
      // Assets in maintenance may be at a workshop and assets under review are still being matched: reported only.
      var missingCodes = splitIds_(upd.Missing);
      var nowMissing = assets.filter(function (a) { return missingCodes.indexOf(a.AssetCode) !== -1 && a.Status === 'Active'; });
      setColumns_('Assets', nowMissing.map(function (a) { return a.__row; }),
        { Status: 'Missing', MissingSince: stamp, MissingCount: c.CountId, UpdatedAt: stamp, UpdatedBy: user.Email });
      nowMissing.forEach(function (a) { audit_(user.Email, 'Assets', a.AssetCode, 'update', 'Status', 'Active', 'Missing (' + c.CountId + ')'); });
      audit_(user.Email, 'Counts', c.CountId, 'update', 'Status', 'Open', 'Finished: ' + seen.length + ' found, ' +
        splitIds_(upd.Missing).length + ' missing, ' + splitIds_(elsewhere).length + ' elsewhere');
      if (splitIds_(upd.Missing).length || splitIds_(elsewhere).length) {
        notify_(usersWithRole_(['Admin', 'Accounting']), 'Count ' + c.CountId + ' at ' + locName_(c.LocationId) + ': ' +
          splitIds_(upd.Missing).length + ' missing, ' + splitIds_(elsewhere).length + ' found from other locations.', '#/count/' + c.CountId, 'CountGaps');
      }
    }
    updateRow_('Counts', c.__row, upd);
    var fresh = findBy_(readTableFromSheet_('Counts'), 'CountId', c.CountId);
    return { results: results, count: countView_(fresh, finish) };
  });
}

/** Someone at the location found a missing asset outside a count. */
function markFound_(user, code) {
  return withLock_(function () {
    var rows = readTableFromSheet_('Assets');
    var a = findBy_(rows, 'AssetCode', String(code || '').toUpperCase());
    if (!a) throw appError_('NOT_FOUND', 'Asset not found.');
    if (a.Status !== 'Missing') throw appError_('INVALID', 'This asset is not marked missing.');
    if (!canActOnAsset_(user, a) && user.Role !== 'CountTeam') throw appError_('FORBIDDEN', 'Only its location or admin can mark it found.');
    updateRow_('Assets', a.__row, { Status: 'Active', MissingSince: '', MissingCount: '', UpdatedAt: now_(), UpdatedBy: user.Email });
    audit_(user.Email, 'Assets', a.AssetCode, 'update', 'Status', 'Missing', 'Active (marked found)');
    notify_(usersWithRole_(['Admin', 'Accounting']), (a.Name || a.AssetCode) + ' (' + a.AssetCode + ') was found at ' + locName_(a.LocationId) + '.', '#/scan/' + a.AssetCode, 'MissingFound');
    var fresh = findBy_(readTableFromSheet_('Assets'), 'AssetCode', a.AssetCode);
    return { asset: assetView_(fresh, isFinance_(user)), context: assetContext_(user, fresh) };
  });
}

function cancelCount_(user, id) {
  return withLock_(function () {
    var rows = readTableFromSheet_('Counts');
    var c = findBy_(rows, 'CountId', String(id || '').toUpperCase());
    if (!c || c.Status !== 'Open') throw appError_('NOT_FOUND', 'This count is not open.');
    if (!isAdmin_(user) && c.StartedBy !== user.Email) throw appError_('FORBIDDEN', 'Only the person who started it can cancel.');
    updateRow_('Counts', c.__row, { Status: 'Cancelled', FinishedAt: now_(), FinishedBy: user.Email, UpdatedAt: now_(), UpdatedBy: user.Email });
    audit_(user.Email, 'Counts', c.CountId, 'update', 'Status', 'Open', 'Cancelled');
    return { ok: true };
  });
}

function countDetail_(user, id) {
  var c = findBy_(readTable_('Counts'), 'CountId', String(id || '').toUpperCase());
  if (!c) throw appError_('NOT_FOUND', 'Count not found.');
  if (!isFinance_(user) && !canCount_(user, c.LocationId)) throw appError_('FORBIDDEN', 'You cannot see this count.');
  return { count: countView_(c, true), history: readTable_('Counts').filter(function (x) {
    return String(x.LocationId) === String(c.LocationId) && x.Status === 'Finished';
  }).slice(-10).reverse().map(function (x) { return countView_(x, false); }) };
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
        (!f.uniqueWith || String(r[f.uniqueWith] || '') === String(out[f.uniqueWith] || '')) &&
        (isNew || String(r[def.key]) !== String(record[def.key]));
    });
    if (clash) throw appError_('INVALID', f.label + ' "' + out[f.name] + '" already exists' + (f.uniqueWith ? ' for this ' + f.uniqueWith.toLowerCase() : '') + '.');
  });

  def.fields.forEach(function (f) {
    if (f.type !== 'ref' && f.type !== 'refs') return;
    var ids = f.type === 'ref' ? (out[f.name] ? [out[f.name]] : []) : splitIds_(out[f.name]);
    if (ids.length === 0) return;
    var refDef = SCHEMA[f.table];
    var known = readTable_(f.table).filter(function (r) {
      return !f.refFilter || Object.keys(f.refFilter).every(function (k) { return r[k] === f.refFilter[k]; });
    }).map(function (r) { return String(r[refDef.key]); });
    ids.forEach(function (id) {
      if (known.indexOf(id) === -1) throw appError_('INVALID', f.label + ': unknown value ' + id + '.');
    });
  });
  if (out.CostAllocation === 'Selected cost centres' && splitIds_(out.CostCenters).length === 0) {
    throw appError_('INVALID', 'Pick at least one cost centre, or choose Whole company.');
  }
  if (out.CostAllocation === 'Whole company') out.CostCenters = '';
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
var DATA_FIX_VERSION = '0.3.0';
function ensureDataFixed_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('DATA_FIX') === DATA_FIX_VERSION) return;
  withLock_(function () {
    if (props.getProperty('DATA_FIX') === DATA_FIX_VERSION) return;
    migrate_();
    props.setProperty('DATA_FIX', DATA_FIX_VERSION);
  });
}

/** Brings an existing data sheet up to this version. Safe to run more than once. */
function migrate_() {
  var ss = book_();
  var fresh = [];
  Object.keys(SCHEMA).forEach(function (name) {
    if (!ss.getSheetByName(name)) fresh.push(name);
    ensureSheet_(ss, name); // adds new sheets and new columns
  });
  repairSheets_();
  seedCostCenters_();
  seedNotificationTypes_();
  // Departments added before 0.2.2 have no rule yet: whole company.
  readTableFromSheet_('Departments').forEach(function (d) {
    if (!d.CostAllocation) updateRow_('Departments', d.__row, { CostAllocation: 'Whole company' });
  });
  var settings = readTableFromSheet_('Settings');
  DEFAULT_SETTINGS.forEach(function (d) {
    if (!settings.some(function (r) { return r.Key === d[0]; })) {
      appendRow_('Settings', { Key: d[0], Value: d[1], Description: d[2], UpdatedAt: now_(), UpdatedBy: 'setup' });
    }
  });
  // Only new sheets get the full look; existing ones keep theirs (formatting all takes too long).
  fresh.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    formatSheet_(sh, name);
    var pos = SHEET_ORDER.indexOf(name);
    if (pos !== -1) { ss.setActiveSheet(sh); ss.moveActiveSheet(Math.min(pos + 1, ss.getSheets().length)); }
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

/** Writes the same values into some columns of many rows with one read and one write per column. */
function setColumns_(name, rowNumbers, values) {
  if (!rowNumbers.length) return;
  var sh = sheet_(name);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var first = Math.min.apply(null, rowNumbers), last = Math.max.apply(null, rowNumbers);
  Object.keys(values).forEach(function (k) {
    var col = headers.indexOf(k) + 1;
    if (!col) return;
    var range = sh.getRange(first, col, last - first + 1, 1);
    var cur = range.getValues();
    rowNumbers.forEach(function (r) { cur[r - first][0] = values[k]; });
    range.setValues(cur);
  });
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
