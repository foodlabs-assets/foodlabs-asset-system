/* Foodlabs Asset System — front end (plain JavaScript, no build step). */
(function () {
  'use strict';

  var CFG = window.FAS_CONFIG || {};
  var TOKEN_KEY = 'fas_token';
  var BOOT_KEY = 'fas_boot';
  var state = { token: null, user: null, meta: null, cache: {}, route: '' };
  var root = document.getElementById('app');

  // ------------------------------------------------------------------ utils
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    el.appendChild(child.nodeType ? child : document.createTextNode(String(child)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function initials(name) {
    return String(name || '?').split(/\s+/).map(function (p) { return p.charAt(0); }).join('').slice(0, 2).toUpperCase();
  }
  function decodeJwt(token) {
    try {
      var part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(part))));
    } catch (e) { return null; }
  }
  function isTrue(v) { return v === true || v === 'TRUE' || v === 'true'; }

  // -------------------------------------------------------------- session
  function savedToken() {
    try {
      var t = sessionStorage.getItem(TOKEN_KEY);
      var p = t && decodeJwt(t);
      if (p && p.exp * 1000 > Date.now() + 60000) return t;
      sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* storage blocked */ }
    return null;
  }
  function storeToken(t) {
    state.token = t;
    try { sessionStorage.setItem(TOKEN_KEY, t); } catch (e) { /* in memory only */ }
  }
  function signOut() {
    state.token = null; state.user = null; state.meta = null; state.cache = {};
    try { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(BOOT_KEY); } catch (e) {}
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    renderLogin();
  }

  // ------------------------------------------------------------------ api
  function api(action, payload, attempt) {
    if (!CFG.backendUrl) return Promise.reject(new Error('The app is not connected to its backend yet.'));
    attempt = attempt || 0;
    return apiOnce(action, payload).catch(function (err) {
      // The server is busy for a moment after an update or during a big write: try again.
      if (err.code === 'BUSY' && attempt < 3) {
        return new Promise(function (r) { setTimeout(r, 2500 * (attempt + 1)); }).then(function () { return api(action, payload, attempt + 1); });
      }
      throw err;
    });
  }
  function apiOnce(action, payload) {
    return fetch(CFG.backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: state.token, action: action, payload: payload || {} })
    }).then(function (r) {
      if (!r.ok) throw new Error('Could not reach the server. Check your connection.');
      return r.json();
    }, function () {
      throw new Error('Could not reach the server. Check your connection.');
    }).then(function (res) {
      if (res.ok) return res.data;
      var err = new Error(res.error && res.error.message || 'Something went wrong.');
      err.code = res.error && res.error.code;
      if (err.code === 'AUTH') { signOut(); }
      throw err;
    });
  }

  // ---------------------------------------------------------------- login
  function renderLogin(message) {
    clear(root);
    var btnBox = h('div', { class: 'gbtn' });
    var err = message ? h('div', { class: 'error', text: message }) : null;
    root.appendChild(h('div', { class: 'login' },
      h('div', { class: 'login-card' },
        h('img', { src: 'assets/icon.svg', alt: '' }),
        h('h1', { text: 'Foodlabs Assets' }),
        h('p', { text: 'Sign in with your Foodlabs Google account.' }),
        btnBox, err)));
    whenGoogleReady(function () {
      google.accounts.id.initialize({
        client_id: CFG.clientId,
        callback: function (resp) { onCredential(resp.credential); },
        auto_select: true,
        cancel_on_tap_outside: false,
        itp_support: true
      });
      google.accounts.id.renderButton(btnBox, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', width: 280 });
      google.accounts.id.prompt();
    });
  }
  function whenGoogleReady(fn) {
    if (window.google && google.accounts && google.accounts.id) return fn();
    var tries = 0;
    var t = setInterval(function () {
      if (window.google && google.accounts && google.accounts.id) { clearInterval(t); fn(); }
      else if (++tries > 100) { clearInterval(t); renderLogin('Google sign-in did not load. Check your connection and reload.'); }
    }, 100);
  }
  function onCredential(token) {
    storeToken(token);
    clear(root);
    root.appendChild(h('div', { class: 'boot' }, h('div', { class: 'spinner' })));
    loadSession();
  }
  // One call after sign-in brings the user, the admin tables and their rows.
  // The last copy is kept for this browser session so a reload paints at once,
  // then a fresh copy replaces it in the background.
  function applyBoot(boot) {
    state.meta = boot; state.user = boot.user;
    state.cache = boot.data || {};
    state.lists = boot.lists || {};
    state.settings = boot.settings || {};
    state.assets = boot.assets || [];
    state.legacy = boot.legacy || [];
    state.batches = boot.labelBatches || [];
    state.work = boot.work || { maintenance: [], transfers: [], counts: [] };
    state.notices = boot.notices || { unread: 0, items: [] };
  }
  function loadSession() {
    var shown = false;
    try {
      var saved = JSON.parse(sessionStorage.getItem(BOOT_KEY) || 'null');
      if (saved && saved.user) { applyBoot(saved); route(); shown = true; }
    } catch (e) { /* ignore */ }
    api('bootstrap').then(function (boot) {
      applyBoot(boot);
      try { sessionStorage.setItem(BOOT_KEY, JSON.stringify(boot)); } catch (e) {}
      if (!shown || !document.querySelector('.drawer')) route();
    }).catch(function (e) {
      try { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(BOOT_KEY); } catch (x) {}
      state.token = null;
      renderLogin(e.message);
    });
  }
  function rememberCache() {
    try {
      var boot = JSON.parse(sessionStorage.getItem(BOOT_KEY) || 'null');
      if (boot) { boot.data = state.cache; sessionStorage.setItem(BOOT_KEY, JSON.stringify(boot)); }
    } catch (e) {}
  }

  // ---------------------------------------------------------------- shell
  function shell(active, content) {
    clear(root);
    var u = state.user;
    var items = [['home', 'Home'], ['scan', 'Scan']];
    if (u.role !== 'CountTeam') items.push(['maintenance', 'Maintenance']);
    if (canCount()) items.push(['count', 'Count']);
    if (u.canAdmin) items = items.concat([['labels', 'Labels'], ['matching', 'Matching'], ['recon', 'Reconciliation'], ['admin', 'Admin']]);
    var nav = items.map(function (it) { return h('a', { href: '#/' + it[0], class: active === it[0] ? 'active' : '', text: it[1] }); });
    root.appendChild(h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('img', { src: 'assets/icon.svg', alt: '' }), h('span', { text: 'Foodlabs Assets' })),
      h('nav', null, nav),
      h('div', { class: 'spacer' }),
      bell(),
      h('div', { class: 'userchip' },
        h('div', { class: 'who' }, u.name, h('small', { text: u.role })),
        h('div', { class: 'avatar', text: initials(u.name) }),
        h('button', { class: 'iconbtn', title: 'Sign out', 'aria-label': 'Sign out', onclick: signOut, text: 'Sign out' }))));
    var main = h('main');
    append(main, content);
    root.appendChild(main);
    return main;
  }

  function route() {
    if (!state.user) return;
    var hash = location.hash || '#/home';
    var parts = hash.replace(/^#\//, '').split('/');
    if (window.FAS_stopCamera) window.FAS_stopCamera();
    if (parts[0] === 'admin' && state.user.canAdmin) return renderAdmin(parts[1]);
    if (parts[0] === 'scan') return renderScan(parts[1] ? decodeURIComponent(parts[1]) : '');
    if (parts[0] === 'labels' && state.user.canAdmin) return renderLabels();
    if (parts[0] === 'matching' && state.user.canAdmin) return renderMatching();
    if (parts[0] === 'recon' && state.user.canAdmin) return renderRecon();
    if (parts[0] === 'maintenance') return renderMaintenance(parts[1] ? decodeURIComponent(parts[1]).toUpperCase() : '');
    if (parts[0] === 'count' && canCount()) return parts[1] ? renderCount(decodeURIComponent(parts[1]).toUpperCase()) : renderCountStart();
    renderHome();
  }
  window.addEventListener('hashchange', route);

  // ----------------------------------------------------------------- home
  function renderHome() {
    var u = state.user;
    var locs = h('div', { class: 'pills' });
    var card = h('div', { class: 'card welcome' },
      h('span', { class: 'role', text: u.role }),
      h('h2', { text: 'Welcome, ' + u.name }),
      h('div', { class: 'muted', text: u.email }),
      u.locations.length ? h('div', null, h('div', { class: 'muted', text: 'Your locations' }), locs) : null);
    (u.locationNames || u.locations).forEach(function (name) {
      locs.appendChild(h('span', { class: 'pill', text: name }));
    });
    var w = state.work || { maintenance: [], transfers: [], counts: [] };
    var quick = h('div', { class: 'actions left' }, h('a', { class: 'btn primary', href: '#/scan', text: 'Scan an asset' }),
      canCount() ? h('a', { class: 'btn', href: '#/count', text: 'Start a stock count' }) : null);
    var mTitle = u.role === 'Technician' ? 'Assigned to you' : u.role === 'Accounting' ? 'Maintenance (waiting for invoices first)' : 'Open maintenance';
    var mItems = w.maintenance.slice();
    if (u.role === 'Accounting') mItems.sort(function (a, b) { return (b.Status === 'Work done') - (a.Status === 'Work done'); });
    shell('home', h('div', { class: 'stack' }, card, h('section', { class: 'card' }, searchBox(), quick),
      w.transfers.length ? workList('Transfers waiting for receipt', w.transfers, transferRow, '') : null,
      u.role === 'CountTeam' ? null : workList(mTitle, mItems, requestRow, 'Nothing open.'),
      w.counts.length ? workList('Counts in progress', w.counts, countRow, '') : null));
    loadWork().then(function (fresh) {
      if (location.hash.replace(/^#\/?/, '').split('/')[0] !== 'home' && location.hash !== '' ) return;
      if (fresh && JSON.stringify(fresh) !== JSON.stringify(w)) renderHome();
    });
  }

  // ---------------------------------------------------------------- admin
  function tableOrder() {
    var order = ['Users', 'Locations', 'Departments', 'Brands', 'CostCenters', 'Categories', 'Types', 'Makes', 'LabelTemplates', 'XeroBalances', 'Settings'];
    return order.filter(function (t) { return state.meta.tables[t]; });
  }

  function loadTable(name, force) {
    if (!force && state.cache[name]) return Promise.resolve(state.cache[name]);
    return api('list', { table: name }).then(function (d) { state.cache[name] = d.rows; return d.rows; });
  }

  function renderAdmin(tableName) {
    var tables = tableOrder();
    if (!tableName || tables.indexOf(tableName) === -1) tableName = tables[0];
    var def = state.meta.tables[tableName];
    var tabs = h('div', { class: 'tablist', role: 'tablist' }, tables.map(function (t) {
      return h('button', {
        class: t === tableName ? 'active' : '', role: 'tab', text: state.meta.tables[t].title,
        onclick: function () { location.hash = '#/admin/' + t; }
      });
    }));
    var search = h('input', { class: 'search', type: 'search', placeholder: 'Search', 'aria-label': 'Search' });
    var addBtn = tableName === 'Settings' ? null :
      h('button', { class: 'btn primary', text: 'Add', onclick: function () { openForm(tableName, null); } });
    var refreshBtn = h('button', { class: 'btn', text: 'Refresh', title: 'Reload from the server' });
    var listBox = h('div', null, h('div', { class: 'boot', style: 'min-height:160px' }, h('div', { class: 'spinner' })));
    shell('admin', h('div', { class: 'admin' }, tabs,
      h('section', null, h('div', { class: 'toolbar' }, h('h3', { text: def.title }), search, refreshBtn, addBtn), listBox)));

    var paint = function () { paintTable(listBox, tableName, def, state.cache[tableName] || [], search.value); };
    search.addEventListener('input', paint);
    var load = function (force) {
      var refs = refTablesFor(def);
      return Promise.all([loadTable(tableName, force)].concat(refs.map(function (r) { return loadTable(r, force); })))
        .then(function () { rememberCache(); paint(); })
        .catch(function (e) { clear(listBox); listBox.appendChild(h('div', { class: 'error', text: e.message })); });
    };
    refreshBtn.addEventListener('click', function () {
      refreshBtn.disabled = true; refreshBtn.textContent = 'Refreshing…';
      load(true).then(function () { refreshBtn.disabled = false; refreshBtn.textContent = 'Refresh'; });
    });
    if (state.cache[tableName]) paint(); else load(false);
  }

  function refTablesFor(def) {
    var out = [];
    def.fields.forEach(function (f) {
      if ((f.type === 'ref' || f.type === 'refs') && out.indexOf(f.table) === -1 && state.meta.tables[f.table]) out.push(f.table);
    });
    return out;
  }

  function refName(table, id) {
    var def = state.meta.tables[table];
    var rows = state.cache[table] || [];
    for (var i = 0; i < rows.length; i++) if (String(rows[i][def.key]) === String(id)) return rowLabel(table, rows[i]) || id;
    if (state.lists && state.lists[table]) { var n = listName(table, id); if (n) return n; }
    return id;
  }
  // Locations show their brand in front ("Philly's - Yarmouk"): two brands can share a place name.
  function rowLabel(table, row) {
    if (table !== 'Locations' || !row.Brand) return row.Name;
    var b = '';
    (state.cache.Brands || []).forEach(function (r) { if (String(r.BrandId) === String(row.Brand)) b = r.Name; });
    if (!b) b = listName('Brands', row.Brand);
    return b && b !== row.Brand ? b + ' - ' + row.Name : row.Name;
  }

  function display(f, v) {
    if (f.type === 'bool') return h('span', { class: 'badge ' + (isTrue(v) ? 'on' : 'off'), text: isTrue(v) ? 'Yes' : 'No' });
    if (f.type === 'ref') return v ? refName(f.table, v) : '';
    if (f.type === 'refs') return String(v || '').split(',').filter(String).map(function (id) { return refName(f.table, id.trim()); }).join(', ');
    return v === undefined || v === null ? '' : String(v);
  }

  function paintTable(box, tableName, def, rows, query) {
    clear(box);
    var cols = def.fields;
    var q = String(query || '').toLowerCase();
    // Never show a row without its ID: it cannot be edited safely.
    rows = rows.filter(function (r) { return r[def.key] !== '' && r[def.key] !== null && r[def.key] !== false && r[def.key] !== undefined; });
    var filtered = rows.filter(function (r) {
      if (!q) return true;
      return cols.some(function (f) {
        var d = display(f, r[f.name]);
        return String(d && d.textContent !== undefined ? d.textContent : d).toLowerCase().indexOf(q) !== -1;
      });
    });
    if (!filtered.length) {
      box.appendChild(h('div', { class: 'empty', text: rows.length ? 'No matches.' : 'Nothing here yet. Use Add to create the first one.' }));
      return;
    }
    var thead = h('thead', null, h('tr', null, cols.map(function (f) { return h('th', { text: f.label }); })));
    var tbody = h('tbody', null, filtered.map(function (r) {
      return h('tr', { onclick: function () { openForm(tableName, r); } }, cols.map(function (f) {
        return h('td', { 'data-label': f.label }, display(f, r[f.name]));
      }));
    }));
    box.appendChild(h('div', { class: 'tablewrap' }, h('table', { class: 'datatable' }, thead, tbody)));
  }

  // ----------------------------------------------------------------- form
  function openForm(tableName, row) {
    var def = state.meta.tables[tableName];
    var isNew = !row;
    var inputs = {};
    var fieldEls = {};
    var errBox = h('div');
    var body = h('div', { class: 'body' }, errBox);

    def.fields.forEach(function (f) {
      if (isNew && f.keyField && def.prefix) return;
      if (isNew && f.readOnly && !f.keyField) return;
      var val = row ? row[f.name] : (f.defaultValue !== undefined ? f.defaultValue : '');
      var lockKey = !isNew && f.keyField;
      var readOnly = f.readOnly || lockKey;
      var label = h('label', null, f.label, f.required ? h('span', { class: 'req', text: ' *' }) : null);
      var field = h('div', { class: 'field' });

      if (f.type === 'bool') {
        var cb = h('input', { type: 'checkbox' });
        cb.checked = isTrue(val);
        inputs[f.name] = function () { return cb.checked; };
        field.appendChild(h('label', { class: 'toggle' }, cb, f.label));
      } else if (f.type === 'select' || f.type === 'ref') {
        var sel = h('select', { disabled: readOnly });
        sel.appendChild(h('option', { value: '', text: '—' }));
        var opts = f.type === 'select' ? f.options.map(function (o) { return [o, o]; }) :
          (state.cache[f.table] || []).filter(function (r) { return isTrue(r.Active) || String(r[state.meta.tables[f.table].key]) === String(val); })
            .filter(function (r) { return !f.refFilter || Object.keys(f.refFilter).every(function (k) { return r[k] === f.refFilter[k]; }); })
            .map(function (r) { return [r[state.meta.tables[f.table].key], rowLabel(f.table, r)]; });
        opts.forEach(function (o) {
          if (tableName === 'Users' && f.name === 'Role' && o[0] === 'Admin' && state.user.role !== 'Admin' && val !== 'Admin') return;
          var opt = h('option', { value: o[0], text: o[1] });
          if (String(o[0]) === String(val)) opt.selected = true;
          sel.appendChild(opt);
        });
        inputs[f.name] = function () { return sel.value; };
        field.appendChild(label); field.appendChild(sel);
      } else if (f.type === 'refs') {
        var chosen = String(val || '').split(',').map(function (s) { return s.trim(); }).filter(String);
        var boxes = [];
        var list = h('div', { class: 'checks' });
        var refKey = state.meta.tables[f.table].key;
        (state.cache[f.table] || []).forEach(function (r) {
          var id = String(r[refKey]);
          if (!isTrue(r.Active) && chosen.indexOf(id) === -1) return;
          var c = h('input', { type: 'checkbox', value: id });
          c.checked = chosen.indexOf(id) !== -1;
          boxes.push(c);
          list.appendChild(h('label', null, c, rowLabel(f.table, r)));
        });
        if (!boxes.length) list.appendChild(h('div', { class: 'muted', text: 'Add ' + state.meta.tables[f.table].title.toLowerCase() + ' first.' }));
        inputs[f.name] = function () { return boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; }); };
        field.appendChild(label); field.appendChild(list);
      } else {
        var inp = h('input', { type: f.type === 'number' ? 'number' : 'text', readonly: readOnly, value: val === undefined ? '' : String(val) });
        if (f.type === 'number') { inp.setAttribute('step', 'any'); if (f.min !== undefined) inp.setAttribute('min', f.min); if (f.max !== undefined) inp.setAttribute('max', f.max); }
        if (f.name === 'Email') inp.setAttribute('type', 'email');
        inputs[f.name] = function () { return inp.value; };
        field.appendChild(label); field.appendChild(inp);
      }
      if (f.help) field.appendChild(h('div', { class: 'muted small', text: f.help }));
      fieldEls[f.name] = field;
      body.appendChild(field);
    });
    // Departments: the cost centre list only matters for "Selected cost centres".
    if (fieldEls.CostAllocation && fieldEls.CostCenters) {
      var allocSel = fieldEls.CostAllocation.querySelector('select');
      var syncAlloc = function () { fieldEls.CostCenters.style.display = allocSel.value === 'Selected cost centres' ? '' : 'none'; };
      allocSel.addEventListener('change', syncAlloc);
      syncAlloc();
    }

    if (!isNew) {
      var histBtn = h('button', { class: 'btn', text: 'Show change history' });
      var hist = h('div', { class: 'history' }, histBtn);
      body.appendChild(hist);
      histBtn.addEventListener('click', function () {
        histBtn.disabled = true; histBtn.textContent = 'Loading…';
        api('audit', { table: tableName, id: row[def.key] }).then(function (d) {
          clear(hist);
          hist.appendChild(h('h4', { text: 'Change history' }));
          if (!d.rows.length) { hist.appendChild(h('div', { class: 'muted', text: 'No changes recorded.' })); return; }
          hist.appendChild(h('ul', null, d.rows.slice(0, 30).map(function (a) {
            var what = a.Action === 'create' ? 'Created' : (a.Field + ': ' + (a.OldValue || '—') + ' → ' + (a.NewValue || '—'));
            return h('li', null, what, h('small', { text: a.Timestamp + ' · ' + a.User }));
          })));
        }).catch(function () { histBtn.disabled = false; histBtn.textContent = 'History unavailable. Try again'; });
      });
    }

    var saveBtn = h('button', { class: 'btn primary', text: isNew ? 'Create' : 'Save' });
    var overlay = h('div', { class: 'overlay', onclick: function (e) { if (e.target === overlay) close(); } },
      h('div', { class: 'drawer', role: 'dialog', 'aria-modal': 'true' },
        h('header', null, h('h3', { text: (isNew ? 'New ' : 'Edit ') + singular(def.title) }),
          h('button', { class: 'iconbtn', style: 'color:var(--muted)', text: 'Close', onclick: close })),
        body,
        h('footer', null, h('button', { class: 'btn', text: 'Cancel', onclick: close }), saveBtn)));
    function close() { document.body.removeChild(overlay); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);

    saveBtn.addEventListener('click', function () {
      var record = {};
      if (row) def.fields.forEach(function (f) { record[f.name] = row[f.name]; });
      Object.keys(inputs).forEach(function (k) { record[k] = inputs[k](); });
      clear(errBox);
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      api('save', { table: tableName, record: record, isNew: isNew }).then(function (d) {
        close();
        toast(d.unchanged ? 'No changes' : 'Saved');
        var rows = (state.cache[tableName] || []).slice();
        var key = def.key, idx = -1;
        for (var i = 0; i < rows.length; i++) if (String(rows[i][key]).toLowerCase() === String(d.record[key]).toLowerCase()) idx = i;
        if (idx === -1) rows.push(d.record); else rows[idx] = d.record;
        state.cache[tableName] = rows;
        rememberCache();
        if (tableName === 'Users' && record.Email && record.Email.toLowerCase() === state.user.email) {
          return loadSession();
        }
        renderAdmin(tableName);
      }).catch(function (e) {
        errBox.appendChild(h('div', { class: 'error', text: e.message }));
        saveBtn.disabled = false; saveBtn.textContent = isNew ? 'Create' : 'Save';
      });
    });
  }

  function singular(title) {
    var map = { Users: 'user', Locations: 'location', Departments: 'department', Brands: 'brand', 'Cost centres': 'cost centre', Categories: 'category', 'Asset types': 'asset type', Settings: 'setting', Makes: 'make', 'Label sizes': 'label size', 'Xero balances': 'Xero balance' };
    return map[title] || title.toLowerCase();
  }

  // ------------------------------------------------------ shared helpers
  function listName(list, id) {
    var arr = (state.lists && state.lists[list]) || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === String(id)) return arr[i].name;
    return id || '';
  }
  function money(n) {
    if (n === '' || n === null || n === undefined || isNaN(Number(n))) return '';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  }
  function selectEl(list, value, opts) {
    opts = opts || {};
    var sel = h('select', { required: opts.required });
    sel.appendChild(h('option', { value: '', text: opts.placeholder || 'Choose…' }));
    list.forEach(function (o) {
      var opt = h('option', { value: o.id, text: o.name });
      if (String(o.id) === String(value)) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }
  function field(label, control, required, hint) {
    return h('div', { class: 'field' }, h('label', null, label, required ? h('span', { class: 'req', text: ' *' }) : null), control,
      hint ? h('div', { class: 'hint', text: hint }) : null);
  }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var sc = document.createElement('script'); sc.src = src; sc.onload = resolve; sc.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(sc);
    });
  }
  var QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
  var SCAN_LIB = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
  function downloadCsv(name, rows) {
    var csv = rows.map(function (r) {
      return r.map(function (v) {
        var s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    var a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  function parseCsv(text) {
    var rows = [], row = [], cur = '', q = false;
    text = text.replace(/^\ufeff/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    rows = rows.filter(function (r) { return r.some(function (v) { return v !== ''; }); });
    var head = rows.shift() || [];
    return rows.map(function (r) { var o = {}; head.forEach(function (k, i) { o[k.trim()] = r[i] === undefined ? '' : r[i]; }); return o; });
  }
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var max = 1280, w = img.width, hgt = img.height, k = Math.min(1, max / Math.max(w, hgt));
        var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(hgt * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = function () { reject(new Error('That file is not an image.')); };
      img.src = URL.createObjectURL(file);
    });
  }

  // ------------------------------------------------------------------ scan
  function renderScan(initial) {
    var camBox = h('div', { id: 'cam', class: 'cam' });
    var camBtn = h('button', { class: 'btn primary', text: 'Start camera' });
    var input = h('input', { class: 'scaninput', type: 'text', placeholder: 'FL-000123 or a name', autocomplete: 'off', autocapitalize: 'characters', 'aria-label': 'Asset code' });
    var goBtn = h('button', { class: 'btn', text: 'Open' });
    var result = h('div', { class: 'result' });
    var scanner = null, busy = false, lastCode = '', lastAt = 0;

    shell('scan', h('div', { class: 'scan' },
      h('div', { class: 'card scanpanel' },
        h('h2', { text: 'Scan an asset' }),
        h('div', { class: 'muted small', text: 'Use the camera, a handheld scanner, or type the code, a name or a serial number.' }),
        camBox,
        h('div', { class: 'scanrow' }, camBtn),
        h('form', { class: 'scanrow', onsubmit: function (e) { e.preventDefault(); open(input.value); } }, input, goBtn)),
      result));

    function stopCamera() {
      if (scanner) { try { scanner.stop().then(function () { scanner.clear(); }).catch(function () {}); } catch (e) {} scanner = null; }
      camBtn.textContent = 'Start camera';
      camBox.classList.remove('on');
    }
    window.FAS_stopCamera = stopCamera;
    camBtn.addEventListener('click', function () {
      if (scanner) return stopCamera();
      camBtn.disabled = true;
      loadScript(SCAN_LIB).then(function () {
        camBox.classList.add('on');
        scanner = new Html5Qrcode('cam');
        return scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 220, height: 220 } }, function (text) {
          var now = Date.now();
          if (busy || (text === lastCode && now - lastAt < 4000)) return;
          lastCode = text; lastAt = now;
          if (navigator.vibrate) navigator.vibrate(60);
          open(text);
        });
      }).then(function () { camBtn.textContent = 'Stop camera'; })
        .catch(function (e) {
          stopCamera();
          toast(/Permission|NotAllowed/i.test(String(e)) ? 'Allow camera access to scan.' : 'Camera could not start. Type the code instead.');
        })
        .then(function () { camBtn.disabled = false; });
    });

    function open(raw) {
      var code = String(raw || '').trim().toUpperCase();
      if (!code) return;
      input.value = '';
      if (/^MR-\d+$/.test(code)) { location.hash = '#/maintenance/' + code; return; }
      if (/^CNT-\d+$/.test(code)) { location.hash = '#/count/' + code; return; }
      if (!/^[A-Z]{1,5}X?-\d{6}$/.test(code)) { clear(result); result.appendChild(searchBox()); var si = result.querySelector('input'); si.value = raw; si.form.requestSubmit ? si.form.requestSubmit() : si.form.dispatchEvent(new Event('submit')); return; }
      busy = true;
      clear(result);
      result.appendChild(h('div', { class: 'card' }, h('div', { class: 'spinner' })));
      api('lookup', { code: code }).then(function (r) {
        busy = false;
        clear(result);
        if (r.status === 'registered') {
          var paint = function (asset, ctx) {
            clear(result);
            result.appendChild(assetCard(asset));
            var ops = assetOps(asset, ctx, code, paint);
            if (ops) result.appendChild(ops);
          };
          return paint(r.asset, r.context);
        }
        if (r.status === 'unregistered') {
          if (r.canRegister) return result.appendChild(registerForm(r.code, function (asset) {
            clear(result);
            result.appendChild(h('div', { class: 'notice ok', text: r.code + ' registered. Scan the next label.' }));
            result.appendChild(assetCard(asset));
          }));
          return result.appendChild(h('div', { class: 'card' }, h('h3', { text: r.code + ' is a blank label' }),
            h('p', { class: 'muted', text: 'Only the count team (while the count is open) or accounting can register it.' })));
        }
        var msg = r.status === 'invalid' ? '"' + r.code + '" is not a Foodlabs asset code.' :
          r.status === 'not_issued' ? r.code + ' was never printed. Check the label.' :
          r.code + ' belongs to another location.';
        result.appendChild(h('div', { class: 'error', text: msg }));
      }).catch(function (e) { busy = false; clear(result); result.appendChild(h('div', { class: 'error', text: e.message })); });
    }
    if (initial) open(initial);
    else setTimeout(function () { input.focus(); }, 50);
  }

  function assetCard(a) {
    var rows = [
      ['Category', listName('Categories', a.CategoryId)], ['Type', listName('Types', a.TypeId)],
      ['Location', listName('Locations', a.LocationId)], ['Department', listName('Departments', a.DepartmentId)],
      ['Brand', listName('Brands', a.BrandId)], ['Make', listName('Makes', a.MakeId)], ['Model', a.Model],
      ['Serial number', a.SerialNo], ['Condition', a.Condition], ['Notes', a.Notes],
      ['Registered', a.RegisteredAt ? a.RegisteredAt + ' · ' + a.RegisteredBy : '']
    ];
    if (state.user.isFinance) rows = rows.concat([
      ['Cost', money(a.Cost)], ['Accumulated depreciation 31 Dec 2026', money(a.OpeningAccumDepr)],
      ['Useful life (months)', a.LifeMonths], ['Remaining months at 1 Jan 2027', a.RemainingMonths],
      ['Purchase date', a.PurchaseDate], ['Old register line', a.LegacyLineIds],
      ['Depreciation goes to', costCentreText(a)]
    ]);
    var photos = h('div', { class: 'photos' });
    (a.Photos || []).forEach(function (id) {
      var ph = h('button', { class: 'photo', text: 'Show photo' });
      ph.addEventListener('click', function () {
        ph.disabled = true; ph.textContent = 'Loading…';
        api('photo', { code: a.AssetCode, fileId: id }).then(function (d) {
          var img = h('img', { src: d.dataUrl, alt: a.Name });
          ph.parentNode.replaceChild(img, ph);
        }).catch(function (e) { ph.disabled = false; ph.textContent = e.message; });
      });
      photos.appendChild(ph);
    });
    return h('div', { class: 'card assetcard' },
      h('div', { class: 'assethead' }, h('div', null, h('div', { class: 'code', text: a.AssetCode }), h('h3', { text: a.Name })),
        h('span', { class: 'badge ' + (a.Status === 'Active' ? 'on' : a.Status === 'Under review' ? 'warn' : ''), text: a.Status })),
      h('dl', { class: 'kv' }, rows.filter(function (r) { return r[1] !== '' && r[1] !== undefined && r[1] !== null; }).map(function (r) {
        return [h('dt', { text: r[0] }), h('dd', { text: String(r[1]) })];
      })),
      (a.Photos || []).length ? photos : null);
  }

  /** Mirrors costCentersFor_ in the backend: asset exception, then location, then department. */
  function costCentreText(a) {
    var L = state.lists || {};
    var names = function (ids) { return ids.map(function (id) { return listName('CostCenters', id); }).join(', ') + (ids.length > 1 ? ' (split by sales)' : ''); };
    var own = String(a.CostCenters || '').split(',').map(function (x) { return x.trim(); }).filter(String);
    if (own.length) return names(own) + ' · exception';
    var loc = (L.Locations || []).filter(function (l) { return l.id === String(a.LocationId); })[0];
    if (loc && loc.CostCenterId) return names([String(loc.CostCenterId)]);
    var dep = (L.Departments || []).filter(function (d) { return d.id === String(a.DepartmentId); })[0];
    var depIds = dep ? String(dep.CostCenters || '').split(',').map(function (x) { return x.trim(); }).filter(String) : [];
    if (dep && dep.CostAllocation === 'Selected cost centres' && depIds.length) return names(depIds);
    return 'Whole company (split by sales)';
  }

  var LAST_LOC_KEY = 'fas_last_location';
  function registerForm(code, onDone) {
    var L = state.lists;
    var lastLoc = ''; try { lastLoc = localStorage.getItem(LAST_LOC_KEY) || ''; } catch (e) {}
    var defLoc = lastLoc || (state.user.locations || [])[0] || '';
    var name = h('input', { type: 'text', maxlength: '120', placeholder: 'Combi oven' });
    var cat = selectEl(L.Categories.filter(function (c) { return c.AssetKind !== 'Intangible'; }), '', { required: true });
    var type = selectEl([], '', { required: true, placeholder: 'Choose a category first' });
    var loc = selectEl(L.Locations, defLoc, { required: true });
    var dep = selectEl(L.Departments, '', { required: true });
    var brand = selectEl(L.Brands, '');
    var make = h('input', { type: 'text', list: 'makes-list', placeholder: 'Start typing, or add a new one' });
    var makeList = h('datalist', { id: 'makes-list' }, (L.Makes || []).map(function (m) { return h('option', { value: m.name }); }));
    var model = h('input', { type: 'text', maxlength: '80' });
    var serial = h('input', { type: 'text', maxlength: '80' });
    var cond = selectEl([{ id: 'New', name: 'New' }, { id: 'Used', name: 'Used' }, { id: 'Damaged', name: 'Damaged' }], '', { required: true });
    var notes = h('input', { type: 'text', maxlength: '300' });
    var photoInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true });
    var thumbs = h('div', { class: 'thumbs' });
    var photos = [];
    var err = h('div');
    var save = h('button', { class: 'btn primary', type: 'submit', text: 'Register ' + code });

    cat.addEventListener('change', function () {
      clear(type);
      var opts = L.Types.filter(function (t) { return String(t.CategoryId) === cat.value; });
      type.appendChild(h('option', { value: '', text: opts.length ? 'Choose…' : 'No types for this category yet' }));
      opts.forEach(function (t) { type.appendChild(h('option', { value: t.id, text: t.name })); });
      if (!name.value && opts.length === 1) type.value = opts[0].id;
    });
    type.addEventListener('change', function () { if (!name.value && type.value) name.value = listName('Types', type.value); });
    // A branch's assets carry its brand; the user can still change it.
    var autoBrand = '';
    var followLocation = function () {
      var l = L.Locations.filter(function (x) { return x.id === loc.value; })[0];
      var b = l && l.Brand ? String(l.Brand) : '';
      if (!brand.value || brand.value === autoBrand) { brand.value = b; autoBrand = b; }
    };
    loc.addEventListener('change', followLocation);
    followLocation();
    photoInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(photoInput.files || []);
      photoInput.value = '';
      files.slice(0, 4 - photos.length).forEach(function (f) {
        compressImage(f).then(function (data) {
          photos.push(data);
          var t = h('div', { class: 'thumb' }, h('img', { src: data, alt: '' }),
            h('button', { type: 'button', class: 'x', 'aria-label': 'Remove photo', text: '×', onclick: function () {
              photos.splice(photos.indexOf(data), 1); thumbs.removeChild(t);
            } }));
          thumbs.appendChild(t);
        }).catch(function (e) { toast(e.message); });
      });
    });

    var form = h('form', { class: 'card regform', novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      clear(err);
      var missing = [[cat, 'Category'], [type, 'Type'], [loc, 'Location'], [dep, 'Department'], [cond, 'Condition']]
        .filter(function (x) { return !x[0].value; }).map(function (x) { return x[1]; });
      if (!name.value.trim()) missing.unshift('Name');
      if (missing.length) { err.appendChild(h('div', { class: 'error', text: 'Fill in: ' + missing.join(', ') + '.' })); return; }
      var makeName = make.value.trim();
      var known = (L.Makes || []).filter(function (m) { return m.name.toLowerCase() === makeName.toLowerCase(); })[0];
      var asset = { Name: name.value.trim(), CategoryId: cat.value, TypeId: type.value, LocationId: loc.value, DepartmentId: dep.value,
        BrandId: brand.value, MakeId: known ? known.id : '', Model: model.value, SerialNo: serial.value, Condition: cond.value, Notes: notes.value };
      save.disabled = true; save.textContent = 'Saving…';
      api('register', { code: code, asset: asset, photos: photos, newMake: known ? '' : makeName }).then(function (d) {
        try { localStorage.setItem(LAST_LOC_KEY, loc.value); } catch (x) {}
        if (!known && makeName) L.Makes.push({ id: d.asset.MakeId, name: makeName, Status: 'Pending review' });
        if (state.assets) state.assets.push(d.asset);
        toast('Registered');
        onDone(d.asset);
      }).catch(function (e2) {
        err.appendChild(h('div', { class: 'error', text: e2.message }));
        save.disabled = false; save.textContent = 'Register ' + code;
      });
    } },
      h('div', { class: 'formhead' }, h('div', { class: 'code', text: code }), h('h3', { text: 'New asset' })),
      err,
      field('Category', cat, true), field('Type', type, true), field('Name', name, true, 'Filled from the type; change it if needed.'),
      h('div', { class: 'grid2' }, field('Location', loc, true), field('Department', dep, true)),
      field('Condition', cond, true),
      h('details', { class: 'more' }, h('summary', { text: 'More details' }),
        field('Brand', brand), field('Make', h('div', null, make, makeList), false, 'Pick from the list. A new make is added for accounting to review.'),
        h('div', { class: 'grid2' }, field('Model', model), field('Serial number', serial)), field('Notes', notes)),
      field('Photos', h('div', null, h('label', { class: 'btn filebtn' }, 'Take or add photos', photoInput), thumbs), false, 'Up to 4. Optional.'),
      h('div', { class: 'actions' }, save));
    return form;
  }

  // ---------------------------------------------------------------- labels
  function renderLabels() {
    var openNow = !!state.settings.countTeamOpen;
    var winBtn = h('button', { class: 'btn ' + (openNow ? '' : 'primary'), text: openNow ? 'Close the count' : 'Open the count' });
    winBtn.addEventListener('click', function () {
      winBtn.disabled = true;
      api('setCountWindow', { open: !openNow }).then(function (d) {
        state.settings.countTeamOpen = d.countTeamOpen; toast(d.countTeamOpen ? 'Count is open' : 'Count is closed'); renderLabels();
      }).catch(function (e) { toast(e.message); winBtn.disabled = false; });
    });
    var qty = h('input', { type: 'number', min: '1', max: '2000', value: '100' });
    var notes = h('input', { type: 'text', placeholder: 'For the initial count' });
    var mk = h('button', { class: 'btn primary', text: 'Create batch' });
    var err = h('div');
    mk.addEventListener('click', function () {
      clear(err); mk.disabled = true;
      api('createLabelBatch', { quantity: qty.value, notes: notes.value }).then(function (d) {
        state.batches.push(d.batch); toast('Batch ' + d.batch.BatchId + ' created'); renderLabels();
      }).catch(function (e) { err.appendChild(h('div', { class: 'error', text: e.message })); mk.disabled = false; });
    });
    var used = {};
    (state.assets || []).forEach(function (a) { used[a.AssetCode] = true; });
    var prefix = state.settings.labelPrefix || 'FL';
    function codeOf(n) { return prefix + '-' + String(n).padStart(6, '0'); }
    var rows = state.batches.slice().reverse().map(function (b) {
      var from = Number(b.FromNo), to = Number(b.ToNo), u = 0;
      for (var n = from; n <= to; n++) if (used[codeOf(n)]) u++;
      return h('tr', null,
        h('td', { 'data-label': 'Batch', text: b.BatchId }),
        h('td', { 'data-label': 'Codes', text: codeOf(from) + ' to ' + codeOf(to) }),
        h('td', { 'data-label': 'Labels', text: String(to - from + 1) }),
        h('td', { 'data-label': 'Used', text: u + ' used · ' + (to - from + 1 - u) + ' free' }),
        h('td', { 'data-label': 'Notes', text: b.Notes || '' }),
        h('td', null, h('button', { class: 'btn', text: 'Print', onclick: function () { printDialog(b, used, codeOf); } })));
    });
    shell('labels', h('div', { class: 'stack' },
      h('div', { class: 'card' }, h('div', { class: 'row-between' },
        h('div', null, h('h3', { text: 'Initial count' }),
          h('div', { class: 'muted', text: openNow ? 'Open: the count team can register assets on blank labels.' : 'Closed: only accounting can register assets.' })),
        winBtn)),
      h('div', { class: 'card' }, h('h3', { text: 'Print a new batch' }),
        h('div', { class: 'muted small', text: 'Numbers continue from the last batch, so no code is ever printed twice.' }),
        err, h('div', { class: 'grid2' }, field('How many labels', qty, true), field('Notes', notes)), h('div', { class: 'actions' }, mk)),
      rows.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'datatable static' },
        h('thead', null, h('tr', null, ['Batch', 'Codes', 'Labels', 'Used', 'Notes', ''].map(function (t) { return h('th', { text: t }); }))),
        h('tbody', null, rows))) : h('div', { class: 'empty', text: 'No labels printed yet.' })));
  }

  function printDialog(batch, used, codeOf) {
    var tmpl = selectEl((state.lists.LabelTemplates || []).map(function (t) { return { id: t.id, name: t.name }; }), (state.lists.LabelTemplates[0] || {}).id, { required: true });
    var which = selectEl([{ id: 'free', name: 'Free labels only' }, { id: 'all', name: 'Whole batch' }, { id: 'range', name: 'A range' }], 'free', { required: true });
    var from = h('input', { type: 'number', value: String(batch.FromNo) });
    var to = h('input', { type: 'number', value: String(batch.ToNo) });
    var rangeBox = h('div', { class: 'grid2', style: 'display:none' }, field('From number', from), field('To number', to));
    which.addEventListener('change', function () { rangeBox.style.display = which.value === 'range' ? '' : 'none'; });
    var go = h('button', { class: 'btn primary', text: 'Print' });
    var err = h('div');
    var overlay = modal('Print ' + batch.BatchId, h('div', { class: 'body' }, err, field('Label size', tmpl, true, 'Add sizes in Admin > Label sizes.'), field('Which labels', which, true), rangeBox,
      h('div', { class: 'muted small', text: 'Choose the label printer and turn off headers, footers and margins in the print window.' })), go);
    go.addEventListener('click', function () {
      clear(err);
      var t = state.lists.LabelTemplates.filter(function (x) { return x.id === tmpl.value; })[0];
      var lo = Number(batch.FromNo), hi = Number(batch.ToNo);
      if (which.value === 'range') { lo = Math.max(lo, Number(from.value)); hi = Math.min(hi, Number(to.value)); }
      var codes = [];
      for (var n = lo; n <= hi; n++) { var c = codeOf(n); if (which.value !== 'free' || !used[c]) codes.push(c); }
      if (!t || !codes.length) { err.appendChild(h('div', { class: 'error', text: !t ? 'Choose a label size.' : 'No labels in that selection.' })); return; }
      go.disabled = true; go.textContent = 'Preparing…';
      printLabels(codes, Number(t.WidthMm), Number(t.HeightMm)).then(function () { overlay.close(); })
        .catch(function (e) { err.appendChild(h('div', { class: 'error', text: e.message })); go.disabled = false; go.textContent = 'Print'; });
    });
  }

  /** One label per page at the exact size, so any label printer driver prints it as is. */
  function printLabels(codes, w, hgt) {
    return loadScript(QR_LIB).then(function () {
      var qr = Math.min(hgt - 4, w * 0.48);
      var font = Math.max(2.4, Math.min(hgt * 0.17, (w - qr - 5) / 5.4));
      var pages = codes.map(function (c) {
        var q = qrcode(0, 'M'); q.addData(c); q.make();
        return '<div class="l"><div class="q">' + q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }) + '</div>' +
          '<div class="t"><div class="c">' + c + '</div><div class="o">Property of Foodlabs</div></div></div>';
      }).join('');
      var css = '@page{size:' + w + 'mm ' + hgt + 'mm;margin:0}html,body{margin:0;padding:0}' +
        '.l{width:' + w + 'mm;height:' + hgt + 'mm;box-sizing:border-box;padding:2mm;display:flex;align-items:center;gap:2mm;page-break-after:always;break-after:page;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#000}' +
        '.q{width:' + qr + 'mm;height:' + qr + 'mm;flex:none}.q svg{width:100%;height:100%;display:block}' +
        '.c{font-weight:700;font-size:' + font.toFixed(2) + 'mm;line-height:1.1;white-space:nowrap}.o{font-size:' + (font * 0.45).toFixed(2) + 'mm;margin-top:1mm;white-space:nowrap}';
      var frame = h('iframe', { class: 'printframe', title: 'Labels' });
      document.body.appendChild(frame);
      var doc = frame.contentWindow.document;
      doc.open(); doc.write('<!doctype html><html><head><title>Labels</title><style>' + css + '</style></head><body>' + pages + '</body></html>'); doc.close();
      return new Promise(function (resolve) {
        setTimeout(function () {
          frame.contentWindow.focus(); frame.contentWindow.print();
          setTimeout(function () { document.body.removeChild(frame); resolve(); }, 1500);
        }, 300);
      });
    });
  }

  function modal(title, body, primaryBtn) {
    var overlay = h('div', { class: 'overlay center', onclick: function (e) { if (e.target === overlay) close(); } },
      h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
        h('header', null, h('h3', { text: title }), h('button', { class: 'iconbtn', style: 'color:var(--muted)', text: 'Close', onclick: close })),
        body, h('footer', null, h('button', { class: 'btn', text: 'Cancel', onclick: close }), primaryBtn)));
    function close() { if (overlay.parentNode) document.body.removeChild(overlay); }
    overlay.close = close;
    document.body.appendChild(overlay);
    return overlay;
  }

  // -------------------------------------------------------------- matching
  var matchState = { lineFilter: 'Unmatched', lineQ: '', assetQ: '', assetLoc: '', selected: {}, line: null };
  function applySnapshot(d) {
    if (d.assets) state.assets = d.assets;
    if (d.legacy) state.legacy = d.legacy;
  }
  function renderMatching() {
    if (!state.legacy.length) return renderImport();
    var ms = matchState;
    var review = state.assets.filter(function (a) { return a.Status === 'Under review'; });
    var assetSearch = h('input', { class: 'search', type: 'search', placeholder: 'Search counted assets', value: ms.assetQ });
    var assetLoc = selectEl(state.lists.Locations, ms.assetLoc, { placeholder: 'All locations' });
    var lineSearch = h('input', { class: 'search', type: 'search', placeholder: 'Search old register', value: ms.lineQ });
    var lineFilter = selectEl([{ id: 'Unmatched', name: 'Unmatched' }, { id: 'Matched', name: 'Matched' }, { id: 'Not found', name: 'Not found' }, { id: 'all', name: 'All lines' }], ms.lineFilter);
    var assetList = h('div', { class: 'picklist' });
    var lineList = h('div', { class: 'picklist' });
    var detail = h('div', { class: 'card detail' });
    var counts = { Unmatched: 0, Matched: 0, 'Not found': 0 };
    state.legacy.forEach(function (l) { counts[l.MatchStatus] = (counts[l.MatchStatus] || 0) + 1; });

    function paintAssets() {
      clear(assetList);
      var q = ms.assetQ.toLowerCase();
      var list = review.filter(function (a) {
        if (ms.assetLoc && a.LocationId !== ms.assetLoc) return false;
        return !q || (a.AssetCode + ' ' + a.Name + ' ' + listName('Types', a.TypeId) + ' ' + a.SerialNo).toLowerCase().indexOf(q) !== -1;
      });
      if (!list.length) assetList.appendChild(h('div', { class: 'muted pad', text: review.length ? 'No matches.' : 'No counted assets waiting.' }));
      list.slice(0, 300).forEach(function (a) {
        var cb = h('input', { type: 'checkbox' });
        cb.checked = !!ms.selected[a.AssetCode];
        cb.addEventListener('change', function () { if (cb.checked) ms.selected[a.AssetCode] = true; else delete ms.selected[a.AssetCode]; paintDetail(); });
        assetList.appendChild(h('label', { class: 'pick' }, cb, h('div', null, h('div', { class: 'strong', text: a.AssetCode + ' · ' + a.Name }),
          h('div', { class: 'muted small', text: [listName('Locations', a.LocationId), listName('Types', a.TypeId), a.SerialNo].filter(String).join(' · ') }))));
      });
    }
    function paintLines() {
      clear(lineList);
      var q = ms.lineQ.toLowerCase();
      var list = state.legacy.filter(function (l) {
        if (ms.lineFilter !== 'all' && l.MatchStatus !== ms.lineFilter) return false;
        return !q || (l.LineId + ' ' + l.Name + ' ' + l.LocationSuggested + ' ' + l.GroupName).toLowerCase().indexOf(q) !== -1;
      });
      if (!list.length) lineList.appendChild(h('div', { class: 'muted pad', text: 'No lines.' }));
      list.slice(0, 300).forEach(function (l) {
        var b = h('button', { class: 'pick line' + (ms.line === l.LineId ? ' active' : ''), type: 'button' },
          h('div', null, h('div', { class: 'strong', text: l.Name }),
            h('div', { class: 'muted small', text: [l.LineId, l.LocationSuggested, l.PurchaseDate].filter(String).join(' · ') })),
          h('div', { class: 'num', text: money(l.Cost) }));
        b.addEventListener('click', function () { ms.line = l.LineId; paintLines(); paintDetail(); });
        lineList.appendChild(b);
      });
    }
    function paintDetail() {
      clear(detail);
      var codes = Object.keys(ms.selected).filter(function (c) { return review.some(function (a) { return a.AssetCode === c; }); });
      var line = state.legacy.filter(function (l) { return l.LineId === ms.line; })[0];
      if (!line) {
        detail.appendChild(h('div', { class: 'muted', text: 'Pick a line from the old register on the right, and tick the counted assets it covers.' }));
        if (codes.length === 1) detail.appendChild(h('div', { class: 'actions' }, h('button', { class: 'btn', text: 'No line: enter values for ' + codes[0], onclick: function () { financeDialog(codes[0]); } })));
        return;
      }
      detail.appendChild(h('div', { class: 'row-between' }, h('h3', { text: line.Name }), h('span', { class: 'badge ' + (line.MatchStatus === 'Matched' ? 'on' : line.MatchStatus === 'Not found' ? 'off' : ''), text: line.MatchStatus })));
      detail.appendChild(h('dl', { class: 'kv' }, [
        ['Line', line.LineId + (line.OldAssetId ? ' · ' + line.OldAssetId : '')], ['Group', line.GroupName], ['Location in file', line.LocationRaw + (line.LocationSuggested && line.LocationSuggested !== line.LocationRaw ? ' (' + line.LocationSuggested + ')' : '')],
        ['Purchase date', line.PurchaseDate], ['Cost', money(line.Cost)], ['Accumulated 31 Dec 2026', money(line.AccumDeprDec2026)],
        ['Book value 31 Dec 2026', money(line.NbvDec2026)], ['Life · remaining', line.LifeMonths + ' · ' + line.RemainingMonths + ' months'],
        ['Flags', line.Flags], ['Matched to', line.MatchedAssets], ['Note', line.MatchNote]
      ].filter(function (r) { return r[1] !== '' && r[1] !== undefined; }).map(function (r) { return [h('dt', { text: r[0] }), h('dd', { text: String(r[1]) })]; })));
      var err = h('div'); detail.appendChild(err);
      function run(action, payload, okMsg) {
        return api(action, payload).then(function (d) { applySnapshot(d); ms.selected = {}; toast(okMsg); renderMatching(); })
          .catch(function (e) { clear(err); err.appendChild(h('div', { class: 'error', text: e.message })); });
      }
      if (line.MatchStatus === 'Matched') {
        detail.appendChild(h('div', { class: 'actions' }, h('button', { class: 'btn', text: 'Undo match', onclick: function () { run('unmatch', { lineId: line.LineId }, 'Match undone'); } })));
        return;
      }
      if (codes.length) {
        var cost = Number(line.Cost) || 0, accum = Number(line.AccumDeprDec2026) || 0, n = codes.length;
        var inputs = codes.map(function (c, i) {
          var share = function (total) { var each = Math.floor(total / n * 1000) / 1000; return i === n - 1 ? Math.round((total - each * (n - 1)) * 1000) / 1000 : each; };
          return { code: c, cost: h('input', { type: 'number', step: '0.001', value: String(share(cost)) }), accum: h('input', { type: 'number', step: '0.001', value: String(share(accum)) }) };
        });
        detail.appendChild(h('h4', { text: 'Link ' + n + ' counted asset' + (n > 1 ? 's' : '') + ' to this line' }));
        detail.appendChild(h('div', { class: 'alloc' }, h('div', { class: 'allocrow head' }, h('span', { text: 'Asset' }), h('span', { text: 'Cost' }), h('span', { text: 'Accumulated' })),
          inputs.map(function (x) { return h('div', { class: 'allocrow' }, h('span', { text: x.code }), x.cost, x.accum); })));
        detail.appendChild(h('div', { class: 'muted small', text: 'Split equally by default. Shares must add up to the line.' }));
        detail.appendChild(h('div', { class: 'actions' }, h('button', { class: 'btn primary', text: 'Link', onclick: function () {
          run('match', { lineId: line.LineId, allocations: inputs.map(function (x) { return { code: x.code, cost: x.cost.value, accum: x.accum.value }; }) }, 'Linked');
        } })));
      } else {
        detail.appendChild(h('div', { class: 'muted', text: 'Tick the counted assets on the left that this line covers.' }));
      }
      var catSel = selectEl(state.lists.Categories, '', { placeholder: 'Category' });
      var locSel = selectEl(state.lists.Locations, '', { placeholder: 'Location' });
      var note = h('input', { type: 'text', placeholder: 'Why it was not found' });
      detail.appendChild(h('details', { class: 'more' }, h('summary', { text: 'No physical item (fit-out, software, rights)' }),
        h('div', { class: 'muted small', text: 'Records the line as an asset with no label, code FLX-…, so it keeps depreciating.' }),
        h('div', { class: 'grid2' }, catSel, locSel),
        h('div', { class: 'actions' }, h('button', { class: 'btn', text: 'Record without label', onclick: function () {
          if (!catSel.value || !locSel.value) { clear(err); err.appendChild(h('div', { class: 'error', text: 'Choose a category and a location.' })); return; }
          run('createFromLine', { lineId: line.LineId, asset: { CategoryId: catSel.value, LocationId: locSel.value } }, 'Recorded');
        } }))));
      if (line.MatchStatus === 'Not found') {
        detail.appendChild(h('div', { class: 'actions' }, h('button', { class: 'btn', text: 'Back to unmatched', onclick: function () { run('markLine', { lineId: line.LineId, status: 'Unmatched' }, 'Updated'); } })));
      } else {
        detail.appendChild(h('details', { class: 'more' }, h('summary', { text: 'Not found in the count' }), note,
          h('div', { class: 'actions' }, h('button', { class: 'btn', text: 'Mark not found', onclick: function () { run('markLine', { lineId: line.LineId, status: 'Not found', note: note.value }, 'Marked not found'); } }))));
      }
    }

    assetSearch.addEventListener('input', function () { ms.assetQ = assetSearch.value; paintAssets(); });
    assetLoc.addEventListener('change', function () { ms.assetLoc = assetLoc.value; paintAssets(); });
    lineSearch.addEventListener('input', function () { ms.lineQ = lineSearch.value; paintLines(); });
    lineFilter.addEventListener('change', function () { ms.lineFilter = lineFilter.value; paintLines(); });

    shell('matching', h('div', { class: 'stack' },
      h('div', { class: 'stats' },
        stat('Counted, waiting', review.length), stat('Lines unmatched', counts.Unmatched || 0),
        stat('Lines matched', counts.Matched || 0), stat('Lines not found', counts['Not found'] || 0)),
      h('div', { class: 'match' },
        h('section', { class: 'card col' }, h('h3', { text: 'Counted assets' }), h('div', { class: 'toolbar' }, assetSearch, assetLoc), assetList),
        detail,
        h('section', { class: 'card col' }, h('h3', { text: 'Old register' }), h('div', { class: 'toolbar' }, lineSearch, lineFilter), lineList))));
    paintAssets(); paintLines(); paintDetail();
  }
  function stat(label, value) { return h('div', { class: 'stat' }, h('div', { class: 'muted small', text: label }), h('div', { class: 'statnum', text: String(value) })); }

  function financeDialog(code) {
    var a = state.assets.filter(function (x) { return x.AssetCode === code; })[0];
    var f = {
      PurchaseDate: h('input', { type: 'date', value: a.PurchaseDate || '' }),
      Cost: h('input', { type: 'number', step: '0.001', value: a.Cost === '' ? '' : String(a.Cost) }),
      OpeningAccumDepr: h('input', { type: 'number', step: '0.001', value: a.OpeningAccumDepr === '' ? '0' : String(a.OpeningAccumDepr) }),
      LifeMonths: h('input', { type: 'number', step: '1', value: a.LifeMonths === '' ? '' : String(a.LifeMonths) }),
      RemainingMonths: h('input', { type: 'number', step: '1', value: a.RemainingMonths === '' ? '' : String(a.RemainingMonths) }),
      Supplier: h('input', { type: 'text', value: a.Supplier || '' }),
      InvoiceNo: h('input', { type: 'text', value: a.InvoiceNo || '' })
    };
    var ccChosen = String(a.CostCenters || '').split(',').map(function (x) { return x.trim(); }).filter(String);
    var ccBoxes = (state.lists.CostCenters || []).map(function (c) {
      var cb = h('input', { type: 'checkbox', value: c.id }); cb.checked = ccChosen.indexOf(c.id) !== -1;
      return h('label', null, cb, c.name);
    });
    var ccWrap = h('details', { class: 'more', open: ccChosen.length ? true : null },
      h('summary', { text: 'Cost centre exception' }),
      h('div', { class: 'muted small', text: 'Normally the location or department decides. Tick only to override for this asset.' }),
      h('div', { class: 'checks' }, ccBoxes));
    var err = h('div');
    var go = h('button', { class: 'btn primary', text: 'Save and confirm' });
    var ov = modal('Values for ' + code, h('div', { class: 'body' }, err,
      h('div', { class: 'muted small', text: a.Name + ' · ' + listName('Locations', a.LocationId) }),
      h('div', { class: 'grid2' }, field('Purchase date', f.PurchaseDate), field('Cost', f.Cost, true)),
      h('div', { class: 'grid2' }, field('Accumulated 31 Dec 2026', f.OpeningAccumDepr), field('Useful life (months)', f.LifeMonths)),
      h('div', { class: 'grid2' }, field('Remaining months', f.RemainingMonths), field('Supplier', f.Supplier)),
      field('Invoice number', f.InvoiceNo), ccWrap), go);
    go.addEventListener('click', function () {
      var values = { activate: true };
      Object.keys(f).forEach(function (k) { values[k] = f[k].value; });
      values.CostCenters = ccBoxes.map(function (l) { return l.querySelector('input'); }).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
      go.disabled = true;
      api('setFinance', { code: code, values: values }).then(function (d) { applySnapshot(d); ov.close(); toast('Saved'); renderMatching(); })
        .catch(function (e) { clear(err); err.appendChild(h('div', { class: 'error', text: e.message })); go.disabled = false; });
    });
  }

  function renderImport() {
    var file = h('input', { type: 'file', accept: '.csv,text/csv' });
    var info = h('div');
    var go = h('button', { class: 'btn primary', text: 'Import', disabled: true });
    var rows = null;
    file.addEventListener('change', function () {
      clear(info); rows = null; go.disabled = true;
      var f = file.files && file.files[0];
      if (!f) return;
      f.text().then(function (t) {
        rows = parseCsv(t);
        var need = ['LineId', 'Name', 'Cost', 'AccumDeprDec2026', 'NbvDec2026'];
        var miss = need.filter(function (k) { return !rows.length || !(k in rows[0]); });
        if (miss.length) { info.appendChild(h('div', { class: 'error', text: 'This is not the old-register file. Missing: ' + miss.join(', ') })); rows = null; return; }
        var cost = rows.reduce(function (s, r) { return s + (Number(r.Cost) || 0); }, 0);
        var nbv = rows.reduce(function (s, r) { return s + (Number(r.NbvDec2026) || 0); }, 0);
        info.appendChild(h('div', { class: 'notice', text: rows.length + ' lines · cost ' + money(cost) + ' · book value 31 Dec 2026 ' + money(nbv) }));
        go.disabled = false;
      });
    });
    go.addEventListener('click', function () {
      go.disabled = true; go.textContent = 'Importing…';
      api('importLegacy', { rows: rows }).then(function (d) { state.legacy = d.legacy; toast(d.count + ' lines imported'); renderMatching(); })
        .catch(function (e) { clear(info); info.appendChild(h('div', { class: 'error', text: e.message })); go.disabled = false; go.textContent = 'Import'; });
    });
    shell('matching', h('div', { class: 'card narrow' }, h('h2', { text: 'Import the old register' }),
      h('p', { class: 'muted', text: 'Upload the cleaned old-register file (CSV). Its lines are then matched to the assets found in the count.' }),
      h('label', { class: 'btn filebtn' }, 'Choose file', file), info, h('div', { class: 'actions' }, go)));
  }

  // ----------------------------------------------------------------- recon
  function renderRecon() {
    var box = h('div', null, h('div', { class: 'card' }, h('div', { class: 'spinner' })));
    shell('recon', h('div', { class: 'stack' }, h('div', { class: 'row-between' }, h('h2', { text: 'Reconciliation with Xero, 31 Dec 2026' })), box));
    api('recon').then(function (d) { paintRecon(box, d); }).catch(function (e) { clear(box); box.appendChild(h('div', { class: 'error', text: e.message })); });
  }
  function paintRecon(box, d) {
    clear(box);
    var tbody = h('tbody');
    d.rows.forEach(function (r) {
      var inp = h('input', { type: 'number', step: '0.001', class: 'cellinput', value: r.xero === null ? '' : String(r.xero), 'aria-label': 'Xero balance for ' + r.account });
      var diff = h('td', { 'data-label': 'Difference', class: 'num ' + (r.difference ? 'bad' : 'good'), text: r.difference === null ? '' : money(r.difference) });
      inp.addEventListener('change', function () {
        if (r.account.charAt(0) === '(') { toast('Set the account on the category first.'); return; }
        var exists = r.xero !== null;
        api('save', { table: 'XeroBalances', isNew: !exists, record: { Account: r.account, Balance: inp.value } })
          .then(function () { toast('Saved'); renderRecon(); }).catch(function (e) { toast(e.message); });
      });
      tbody.appendChild(h('tr', null, h('td', { 'data-label': 'Account', text: r.account }), h('td', { 'data-label': 'In the app', class: 'num', text: money(r.app) }),
        h('td', { 'data-label': 'In Xero' }, inp), diff, h('td', { 'data-label': 'Assets', class: 'num', text: r.assets ? String(r.assets) : '' })));
    });
    var exportBtn = h('button', { class: 'btn', text: 'Export to Excel' });
    exportBtn.addEventListener('click', function () {
      var out = [['Account', 'In the app', 'In Xero', 'Difference', 'Assets']].concat(d.rows.map(function (r) { return [r.account, r.app, r.xero, r.difference, r.assets]; }));
      out.push([]); out.push(['Old-register lines not yet matched', d.unmatched.lines, 'Cost', d.unmatched.cost, 'Book value', d.unmatched.nbv]);
      out.push(['Old-register lines not found in the count', d.notFound.lines, 'Cost', d.notFound.cost, 'Book value', d.notFound.nbv]);
      out.push(['Counted assets still under review', d.underReview]);
      out.push([]); out.push(['Line', 'Name', 'Status', 'Cost', 'Accumulated 31 Dec 2026', 'Book value 31 Dec 2026', 'Note']);
      state.legacy.filter(function (l) { return l.MatchStatus !== 'Matched'; }).forEach(function (l) { out.push([l.LineId, l.Name, l.MatchStatus, l.Cost, l.AccumDeprDec2026, l.NbvDec2026, l.MatchNote]); });
      downloadCsv('Xero reconciliation 31 Dec 2026.csv', out);
    });
    box.appendChild(h('div', { class: 'stats' },
      stat('Lines not yet matched', d.unmatched.lines + ' · ' + money(d.unmatched.nbv)),
      stat('Lines not found', d.notFound.lines + ' · ' + money(d.notFound.nbv)),
      stat('Counted, under review', d.underReview)));
    box.appendChild(h('div', { class: 'row-between' }, h('div', { class: 'muted small', text: d.note + ' Type the Xero balance in each row.' }), exportBtn));
    box.appendChild(d.rows.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'datatable static' },
      h('thead', null, h('tr', null, ['Account', 'In the app', 'In Xero', 'Difference', 'Assets'].map(function (t) { return h('th', { text: t }); }))), tbody))
      : h('div', { class: 'empty', text: 'Nothing to reconcile yet. Match assets and set accounts on the categories first.' }));
  }

  // =================================================================
  // Phase 3: maintenance, transfers, stock counts, notifications
  // =================================================================

  function fmtTime(s) { return String(s || '').slice(0, 16); }
  function statusBadge(st) {
    var cls = { 'Open': 'warn', 'In progress': 'warn', 'Work done': 'on', 'Closed': '', 'Cancelled': 'off',
      'Awaiting receipt': 'warn', 'Received': 'on', 'Finished': 'on', 'Active': 'on', 'In maintenance': 'warn', 'Under review': 'warn', 'Disposed': 'off' }[st];
    return h('span', { class: 'badge ' + (cls || ''), text: st });
  }
  function textarea(value, max) {
    return h('textarea', { rows: '3', maxlength: String(max || 1000), class: 'ta', text: value || '' });
  }
  function readFiles(input, allowPdf) {
    var files = Array.prototype.slice.call(input.files || []);
    input.value = '';
    return Promise.all(files.slice(0, 4).map(function (f) {
      if (/^image\//.test(f.type)) return compressImage(f);
      if (allowPdf && f.type === 'application/pdf') {
        if (f.size > 3500000) return Promise.reject(new Error(f.name + ' is larger than 3.5 MB.'));
        return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(f); });
      }
      return Promise.reject(new Error(f.name + ': attach ' + (allowPdf ? 'a PDF or an image.' : 'an image.')));
    }));
  }
  function filePicker(label, allowPdf, capture) {
    var input = h('input', { type: 'file', accept: allowPdf ? 'image/*,application/pdf' : 'image/*', multiple: true });
    if (capture) input.setAttribute('capture', 'environment');
    var list = h('div', { class: 'thumbs' });
    var files = [];
    input.addEventListener('change', function () {
      readFiles(input, allowPdf).then(function (data) {
        data.forEach(function (d) {
          if (files.length >= 4) return;
          files.push(d);
          var isPdf = /^data:application\/pdf/.test(d);
          var t = h('div', { class: 'thumb' + (isPdf ? ' pdf' : '') }, isPdf ? h('div', { class: 'pdficon', text: 'PDF' }) : h('img', { src: d, alt: '' }),
            h('button', { type: 'button', class: 'x', 'aria-label': 'Remove', text: '×', onclick: function () { files.splice(files.indexOf(d), 1); list.removeChild(t); } }));
          list.appendChild(t);
        });
      }).catch(function (e) { toast(e.message); });
    });
    return { el: h('div', null, h('label', { class: 'btn filebtn' }, label, input), list), files: files };
  }
  function openFile(btn, id, fileId) {
    btn.disabled = true;
    api('file', { id: id, fileId: fileId }).then(function (d) {
      btn.disabled = false;
      if (/^data:image\//.test(d.dataUrl)) {
        var img = h('img', { src: d.dataUrl, alt: '' });
        btn.parentNode.replaceChild(img, btn);
      } else {
        var bytes = atob(d.dataUrl.split(',')[1]); var arr = new Uint8Array(bytes.length);
        for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        var url = URL.createObjectURL(new Blob([arr], { type: d.dataUrl.slice(5, d.dataUrl.indexOf(';')) }));
        var a = h('a', { href: url, target: '_blank', rel: 'noopener', download: d.name || 'invoice.pdf' });
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      }
    }).catch(function (e) { btn.disabled = false; toast(e.message); });
  }

  // ----- Notifications bell
  function bell() {
    var n = state.notices || { unread: 0, items: [] };
    var btn = h('button', { class: 'iconbtn bell', title: 'Notifications', 'aria-label': 'Notifications' });
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z"/></svg>';
    if (n.unread) btn.appendChild(h('span', { class: 'dot', text: n.unread > 9 ? '9+' : String(n.unread) }));
    btn.addEventListener('click', function (e) { e.stopPropagation(); toggleNotices(btn); });
    return btn;
  }
  function toggleNotices(anchor) {
    var old = document.querySelector('.noticepanel');
    if (old) { old.parentNode.removeChild(old); return; }
    var n = state.notices || { unread: 0, items: [] };
    var panel = h('div', { class: 'noticepanel', role: 'dialog' },
      h('div', { class: 'row-between' }, h('strong', { text: 'Notifications' }),
        n.unread ? h('button', { class: 'linkbtn', text: 'Mark all read', onclick: function () { markRead('all'); panel.parentNode.removeChild(panel); } }) : null),
      n.items.length ? h('div', { class: 'noticelist' }, n.items.map(function (it) {
        return h('a', { class: 'noticeitem' + (it.read ? '' : ' unread'), href: it.link || '#/home', onclick: function () {
          if (!it.read) markRead([it.id]);
          if (panel.parentNode) panel.parentNode.removeChild(panel);
        } }, h('div', { text: it.text }), h('small', { text: fmtTime(it.at) }));
      })) : h('div', { class: 'muted small pad', text: 'Nothing yet.' }));
    document.body.appendChild(panel);
    var close = function (e) { if (!panel.contains(e.target)) { if (panel.parentNode) panel.parentNode.removeChild(panel); document.removeEventListener('click', close); } };
    setTimeout(function () { document.addEventListener('click', close); }, 0);
  }
  function markRead(ids) {
    api('readNotices', { ids: ids }).then(function (d) { state.notices = d; refreshBell(); }).catch(function () {});
  }
  function refreshBell() {
    var old = document.querySelector('.topbar .bell');
    if (old) old.parentNode.replaceChild(bell(), old);
  }
  function pollNotices() {
    if (!state.user || document.hidden) return;
    api('notices').then(function (d) { state.notices = d; refreshBell(); }).catch(function () {});
  }
  setInterval(pollNotices, 120000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pollNotices(); });

  // ----- Home: search and what is waiting for me
  function canCount() {
    var r = state.user.role;
    return state.user.canAdmin || r === 'CountTeam' || (r === 'Manager' && state.user.locations.length > 0);
  }
  function workList(title, items, render, emptyText) {
    return h('section', { class: 'card' }, h('div', { class: 'row-between' }, h('h3', { text: title }), h('span', { class: 'badge', text: String(items.length) })),
      items.length ? h('div', { class: 'worklist' }, items.slice(0, 50).map(render)) : h('div', { class: 'muted small', text: emptyText }));
  }
  function requestRow(r) {
    return h('a', { class: 'workitem', href: '#/maintenance/' + r.RequestId },
      h('div', null, h('div', { class: 'strong' }, h('span', { class: 'code', text: r.RequestId }), ' ', r.AssetName || r.AssetCode),
        h('div', { class: 'muted small', text: [r.LocationName, r.Type, r.TechnicianName ? 'Technician: ' + r.TechnicianName : 'No technician'].filter(String).join(' · ') })),
      h('div', { class: 'right' }, r.Priority === 'Urgent' ? h('span', { class: 'badge off', text: 'Urgent' }) : null, ' ', statusBadge(r.Status)));
  }
  function transferRow(t) {
    return h('a', { class: 'workitem', href: '#/scan/' + t.AssetCode },
      h('div', null, h('div', { class: 'strong' }, h('span', { class: 'code', text: t.TransferId }), ' ', t.AssetName || t.AssetCode),
        h('div', { class: 'muted small', text: t.FromName + ' → ' + t.ToName + ' · ' + fmtTime(t.RequestedAt) })),
      statusBadge(t.Status));
  }
  function countRow(c) {
    return h('a', { class: 'workitem', href: '#/count/' + c.CountId },
      h('div', null, h('div', { class: 'strong' }, h('span', { class: 'code', text: c.CountId }), ' ', c.LocationName),
        h('div', { class: 'muted small', text: c.found + ' of ' + c.Expected + ' found · started ' + fmtTime(c.StartedAt) })),
      statusBadge(c.Status));
  }
  function searchBox() {
    var input = h('input', { class: 'search big', type: 'search', placeholder: 'Code, name, serial or request number', 'aria-label': 'Search' });
    var out = h('div', { class: 'searchout' });
    var form = h('form', { class: 'searchform', onsubmit: function (e) { e.preventDefault(); go(input.value); } }, input, h('button', { class: 'btn primary', text: 'Search' }));
    function go(q) {
      q = String(q || '').trim();
      if (!q) return;
      var up = q.toUpperCase();
      if (/^[A-Z]{1,5}X?-\d{6}$/.test(up)) { location.hash = '#/scan/' + up; return; }
      if (/^MR-\d+$/.test(up)) { location.hash = '#/maintenance/' + up; return; }
      if (/^CNT-\d+$/.test(up)) { location.hash = '#/count/' + up; return; }
      clear(out); out.appendChild(h('div', { class: 'spinner' }));
      api('search', { q: q }).then(function (d) {
        clear(out);
        var rows = d.assets.map(function (a) {
          return h('a', { class: 'workitem', href: '#/scan/' + a.code },
            h('div', null, h('div', { class: 'strong' }, h('span', { class: 'code', text: a.code }), ' ', a.name),
              h('div', { class: 'muted small', text: [a.location, a.serial ? 'S/N ' + a.serial : ''].filter(String).join(' · ') })), statusBadge(a.status));
        }).concat(d.requests.map(requestRow), d.transfers.map(transferRow));
        out.appendChild(rows.length ? h('div', { class: 'worklist card' }, rows) : h('div', { class: 'muted small pad', text: 'Nothing found.' }));
      }).catch(function (e) { clear(out); out.appendChild(h('div', { class: 'error', text: e.message })); });
    }
    return h('div', { class: 'stack' }, form, out);
  }

  // ----- Maintenance
  function maintenanceDialog(asset, onDone) {
    var L = state.lists;
    var type = selectEl((L.MaintenanceTypes || []).map(function (t) { return { id: t, name: t }; }), '', { required: true });
    var prio = selectEl([{ id: 'Normal', name: 'Normal' }, { id: 'Urgent', name: 'Urgent' }], 'Normal');
    var desc = textarea('', 1000);
    var techs = L.Technicians || [];
    var tech = selectEl(techs, techs.length ? techs[0].id : '', { placeholder: techs.length ? 'Choose…' : 'No technician' });
    var pics = filePicker('Add photos', false, true);
    var err = h('div');
    var go = h('button', { class: 'btn primary', text: 'Send request' });
    var ov = modal('Maintenance for ' + asset.AssetCode, h('div', { class: 'body' }, err,
      h('div', { class: 'muted small', text: asset.Name + ' · ' + listName('Locations', asset.LocationId) }),
      h('div', { class: 'grid2' }, field('Type', type, true), field('Priority', prio)),
      field('What is wrong?', desc, true),
      techs.length ? field('Technician', tech) : h('div', { class: 'hint', text: 'There is no technician now. The request goes to the area and operations managers.' }),
      field('Photos', pics.el)), go);
    go.addEventListener('click', function () {
      clear(err);
      if (!type.value || !desc.value.trim()) { err.appendChild(h('div', { class: 'error', text: 'Choose the type and describe the problem.' })); return; }
      go.disabled = true; go.textContent = 'Sending…';
      api('requestMaintenance', { code: asset.AssetCode, request: { Type: type.value, Priority: prio.value, Description: desc.value, Technician: tech.value }, photos: pics.files })
        .then(function (d) { ov.close(); toast('Request ' + d.request.RequestId + ' sent'); onDone(d); })
        .catch(function (e) { err.appendChild(h('div', { class: 'error', text: e.message })); go.disabled = false; go.textContent = 'Send request'; });
    });
  }

  function renderMaintenance(id) {
    if (!id) {
      var work = state.work || { maintenance: [] };
      var box = h('div', { class: 'stack' });
      shell('maintenance', h('div', { class: 'stack narrowish' }, h('div', { class: 'row-between' }, h('h2', { text: 'Maintenance' }),
        h('button', { class: 'btn', text: 'Refresh', onclick: function () { loadWork().then(function () { renderMaintenance(); }); } })),
        h('div', { class: 'muted small', text: 'To ask for maintenance, scan the asset and choose Request maintenance.' }), box));
      box.appendChild(workList('Open requests', work.maintenance, requestRow, 'No open requests.'));
      return;
    }
    var holder = h('div', { class: 'stack narrowish' }, h('div', { class: 'card' }, h('div', { class: 'spinner' })));
    shell('maintenance', holder);
    api('maintenance', { id: id }).then(function (d) { paintRequest(holder, d); })
      .catch(function (e) { clear(holder); holder.appendChild(h('div', { class: 'error', text: e.message })); });
  }
  function paintRequest(holder, d) {
    var r = d.request, can = d.can, fin = state.user.isFinance;
    clear(holder);
    var rows = [['Asset', r.AssetCode + ' · ' + r.AssetName], ['Location', r.LocationName], ['Type', r.Type], ['Priority', r.Priority],
      ['Problem', r.Description], ['Technician', r.TechnicianName || 'Not assigned'], ['Requested', fmtTime(r.RequestedAt) + ' · ' + r.RequestedByName],
      ['Work done', r.WorkNotes], ['Outcome', r.Outcome], ['Work recorded', r.WorkDoneAt ? fmtTime(r.WorkDoneAt) : '']];
    if (fin) rows = rows.concat([['Supplier', r.Supplier], ['Invoice number', r.InvoiceNo], ['Cost', r.Status === 'Closed' ? money(r.Cost) : '']]);
    rows.push(['Closed', r.ClosedAt ? fmtTime(r.ClosedAt) : ''], ['Notes', r.Notes]);
    var files = h('div', { class: 'photos' });
    (r.Photos || []).forEach(function (fid) { var b = h('button', { class: 'photo', text: 'Show photo' }); b.addEventListener('click', function () { openFile(b, r.RequestId, fid); }); files.appendChild(b); });
    (fin ? r.InvoiceFiles || [] : []).forEach(function (fid, i) { var b = h('button', { class: 'photo', text: 'Open invoice ' + (i + 1) }); b.addEventListener('click', function () { openFile(b, r.RequestId, fid); }); files.appendChild(b); });
    holder.appendChild(h('div', { class: 'card' },
      h('div', { class: 'assethead' }, h('div', null, h('div', { class: 'code', text: r.RequestId }), h('h3', { text: r.AssetName || r.AssetCode })), statusBadge(r.Status)),
      h('dl', { class: 'kv' }, rows.filter(function (x) { return x[1] !== '' && x[1] !== undefined && x[1] !== null; }).map(function (x) {
        return [h('dt', { text: x[0] }), h('dd', { text: String(x[1]) })];
      })), files.childNodes.length ? files : null,
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/scan/' + r.AssetCode, text: 'Open asset' }))));

    var step = function (name, values, files, btn) {
      btn.disabled = true;
      return api('updateMaintenance', { id: r.RequestId, step: name, values: values || {}, files: files || [] })
        .then(function (nd) { toast('Saved'); loadWork(); paintRequest(holder, nd); })
        .catch(function (e) { btn.disabled = false; toast(e.message); throw e; });
    };
    if (can.start) {
      var sb = h('button', { class: 'btn', text: 'Start work' });
      sb.addEventListener('click', function () { step('start', {}, [], sb).catch(function () {}); });
      holder.appendChild(h('div', { class: 'card row-between' }, h('div', { class: 'muted small', text: 'Let the branch know you are on it.' }), sb));
    }
    if (can.workDone) {
      var notes = textarea('', 1000);
      var outcome = selectEl(['Repaired', 'No fault found', 'Needs replacement', 'Could not repair'].map(function (o) { return { id: o, name: o }; }), '', { required: true });
      var wb = h('button', { class: 'btn primary', text: 'Record work done' });
      var werr = h('div');
      wb.addEventListener('click', function () {
        clear(werr);
        if (!notes.value.trim() || !outcome.value) { werr.appendChild(h('div', { class: 'error', text: 'Describe the work and choose the outcome.' })); return; }
        step('workDone', { WorkNotes: notes.value, Outcome: outcome.value }, [], wb).catch(function (e) { werr.appendChild(h('div', { class: 'error', text: e.message })); });
      });
      holder.appendChild(h('div', { class: 'card regform' }, h('h3', { text: 'Work done' }), werr, field('What did you do?', notes, true), field('Outcome', outcome, true), h('div', { class: 'actions' }, wb)));
    }
    if (can.close) {
      var cost = h('input', { type: 'number', step: '0.001', min: '0' });
      var supplier = h('input', { type: 'text', maxlength: '120' });
      var inv = h('input', { type: 'text', maxlength: '60' });
      var invFiles = filePicker('Attach invoice', true, false);
      var cb = h('button', { class: 'btn primary', text: 'Close request' });
      var cerr = h('div');
      cb.addEventListener('click', function () {
        clear(cerr);
        if (cost.value === '') { cerr.appendChild(h('div', { class: 'error', text: 'Enter the cost (0 if there was no charge).' })); return; }
        step('close', { Cost: cost.value, Supplier: supplier.value, InvoiceNo: inv.value }, invFiles.files, cb).catch(function (e) { cerr.appendChild(h('div', { class: 'error', text: e.message })); });
      });
      holder.appendChild(h('div', { class: 'card regform' }, h('h3', { text: 'Invoice and cost' }), cerr,
        h('div', { class: 'grid2' }, field('Cost', cost, true), field('Invoice number', inv)), field('Supplier', supplier),
        field('Invoice', invFiles.el, false, 'PDF or photo. Required when the cost is more than 0.'), h('div', { class: 'actions' }, cb)));
    }
    if (can.assign || can.cancel) {
      var bar = h('div', { class: 'card row-between' });
      if (can.assign) {
        var tsel = selectEl(state.lists.Technicians || [], String(r.Technician || '').toLowerCase());
        var ab = h('button', { class: 'btn', text: 'Assign' });
        ab.addEventListener('click', function () { if (tsel.value) step('assign', { Technician: tsel.value }, [], ab).catch(function () {}); });
        bar.appendChild(h('div', { class: 'inline' }, tsel, ab));
      }
      if (can.cancel) {
        var xb = h('button', { class: 'btn danger', text: 'Cancel request' });
        xb.addEventListener('click', function () {
          var reason = prompt('Why is the request cancelled?');
          if (reason === null) return;
          step('cancel', { Reason: reason }, [], xb).catch(function () {});
        });
        bar.appendChild(xb);
      }
      holder.appendChild(bar);
    }
  }

  // ----- Transfers and custody form
  function transferDialog(asset, onDone) {
    var L = state.lists;
    var to = selectEl((L.Locations || []).filter(function (l) { return l.id !== String(asset.LocationId); }), '', { required: true });
    var dep = selectEl(L.Departments || [], '', { placeholder: 'Keep ' + (listName('Departments', asset.DepartmentId) || 'the same') });
    var reason = h('input', { type: 'text', maxlength: '300' });
    var err = h('div');
    var go = h('button', { class: 'btn primary', text: 'Send' });
    var ov = modal('Move ' + asset.AssetCode, h('div', { class: 'body' }, err,
      h('div', { class: 'muted small', text: asset.Name + ' · now at ' + listName('Locations', asset.LocationId) }),
      field('Move to', to, true), field('Department there', dep), field('Reason', reason),
      h('div', { class: 'hint', text: 'The asset stays with you until the receiving location scans it.' })), go);
    go.addEventListener('click', function () {
      clear(err);
      if (!to.value) { err.appendChild(h('div', { class: 'error', text: 'Choose where it goes.' })); return; }
      go.disabled = true;
      api('requestTransfer', { code: asset.AssetCode, toLocationId: to.value, toDepartmentId: dep.value, reason: reason.value })
        .then(function (d) { ov.close(); toast('Transfer ' + d.transfer.TransferId + ' sent'); onDone(d); })
        .catch(function (e) { err.appendChild(h('div', { class: 'error', text: e.message })); go.disabled = false; });
    });
  }
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function printHtml(title, body) {
    var frame = h('iframe', { class: 'printframe', title: title });
    document.body.appendChild(frame);
    var doc = frame.contentWindow.document;
    doc.open();
    doc.write('<!doctype html><html><head><title>' + esc(title) + '</title><style>' +
      '@page{size:A4;margin:16mm}body{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:12pt}h1{font-size:18pt;margin:0 0 4mm}' +
      '.sub{color:#555;margin-bottom:8mm}table{width:100%;border-collapse:collapse;margin-bottom:10mm}td{border:1px solid #bbb;padding:2.5mm 3mm;vertical-align:top}' +
      'td.k{width:38%;color:#444;background:#f4f4f4}.sign{display:grid;grid-template-columns:1fr 1fr;gap:12mm;margin-top:14mm}' +
      '.sign div{border-top:1px solid #333;padding-top:2mm;min-height:22mm}.note{font-size:10pt;color:#444;margin-top:8mm}</style></head><body>' + body + '</body></html>');
    doc.close();
    setTimeout(function () { frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(function () { document.body.removeChild(frame); }, 1500); }, 300);
  }
  function printCustody(asset, transfer) {
    var rows = [['Asset code', asset.AssetCode], ['Asset', asset.Name], ['Category', listName('Categories', asset.CategoryId)],
      ['Type', listName('Types', asset.TypeId)], ['Make and model', [listName('Makes', asset.MakeId), asset.Model].filter(String).join(' ')],
      ['Serial number', asset.SerialNo], ['Condition', asset.Condition]];
    if (transfer) rows = rows.concat([['From', transfer.FromName], ['To', transfer.ToName], ['Transfer', transfer.TransferId], ['Reason', transfer.Reason]]);
    else rows = rows.concat([['Location', listName('Locations', asset.LocationId)], ['Department', listName('Departments', asset.DepartmentId)]]);
    var body = '<h1>' + (transfer ? 'Asset transfer form' : 'Asset custody form') + '</h1><div class="sub">Foodlabs · printed ' + esc(new Date().toISOString().slice(0, 10)) + '</div><table>' +
      rows.filter(function (r) { return r[1]; }).map(function (r) { return '<tr><td class="k">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>' +
      '<div class="sign"><div>' + (transfer ? 'Handed over by (name, signature, date)' : 'Received by (name, signature, date)') + '</div><div>' +
      (transfer ? 'Received by (name, signature, date)' : 'Witness / manager (name, signature, date)') + '</div></div>' +
      '<div class="note">The person receiving the asset is responsible for it until it is handed over through the asset system.</div>';
    printHtml((transfer ? 'Transfer ' : 'Custody ') + asset.AssetCode, body);
  }

  /** Actions under the asset card: maintenance, move, receive, custody form, history. */
  function assetOps(asset, ctx, scannedCode, rerender) {
    if (!ctx) return null;
    var box = h('div', { class: 'stack' });
    if (ctx.transfer) {
      var t = ctx.transfer;
      var tb = h('div', { class: 'card notice transfer' },
        h('div', { class: 'strong', text: 'On its way: ' + t.FromName + ' → ' + t.ToName }),
        h('div', { class: 'small', text: t.TransferId + ' · asked by ' + t.RequestedByName + ' on ' + fmtTime(t.RequestedAt) + (t.Reason ? ' · ' + t.Reason : '') }));
      var tact = h('div', { class: 'actions' });
      if (ctx.canReceive) {
        var rb = h('button', { class: 'btn primary', text: 'Confirm receipt' });
        rb.addEventListener('click', function () {
          rb.disabled = true;
          api('receiveTransfer', { id: t.TransferId, code: scannedCode || asset.AssetCode }).then(function (d) { toast('Received'); loadWork(); rerender(d.asset, d.context); })
            .catch(function (e) { rb.disabled = false; toast(e.message); });
        });
        tact.appendChild(rb);
      }
      tact.appendChild(h('button', { class: 'btn', text: 'Print transfer form', onclick: function () { printCustody(asset, t); } }));
      if (ctx.canCancelTransfer) {
        var cb = h('button', { class: 'btn', text: 'Cancel transfer' });
        cb.addEventListener('click', function () {
          if (!confirm('Cancel this transfer? The asset stays where it is.')) return;
          cb.disabled = true;
          api('cancelTransfer', { id: t.TransferId }).then(function (d) { toast('Transfer cancelled'); loadWork(); rerender(d.asset, d.context); })
            .catch(function (e) { cb.disabled = false; toast(e.message); });
        });
        tact.appendChild(cb);
      }
      tb.appendChild(tact);
      box.appendChild(tb);
    }
    var acts = h('div', { class: 'actions left' });
    if (ctx.canRequestMaintenance) acts.appendChild(h('button', { class: 'btn primary', text: 'Request maintenance', onclick: function () {
      maintenanceDialog(asset, function () { loadWork(); refreshAsset(asset.AssetCode, rerender); });
    } }));
    if (ctx.canTransfer) acts.appendChild(h('button', { class: 'btn', text: 'Move to another location', onclick: function () {
      transferDialog(asset, function () { loadWork(); refreshAsset(asset.AssetCode, rerender); });
    } }));
    if (asset.Status !== 'Under review') acts.appendChild(h('button', { class: 'btn', text: 'Print custody form', onclick: function () { printCustody(asset, null); } }));
    if (acts.childNodes.length) box.appendChild(h('div', { class: 'card' }, acts));
    if (ctx.openRequests.length) box.appendChild(workList('Open maintenance', ctx.openRequests, requestRow, ''));
    if (ctx.history.length || ctx.maintenanceCost) {
      box.appendChild(workList('Maintenance history' + (ctx.maintenanceCost !== null && ctx.maintenanceCost !== undefined ? ' · total ' + money(ctx.maintenanceCost) : ''),
        ctx.history, requestRow, 'No closed requests.'));
    }
    return box;
  }
  function refreshAsset(code, rerender) {
    api('lookup', { code: code }).then(function (r) { if (r.status === 'registered') rerender(r.asset, r.context); }).catch(function () {});
  }

  // ----- Stock count
  var beepCtx = null;
  function beep(ok) {
    try {
      beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
      var o = beepCtx.createOscillator(), g = beepCtx.createGain();
      o.frequency.value = ok ? 1250 : 360; o.type = 'square';
      g.gain.value = 0.06;
      o.connect(g); g.connect(beepCtx.destination);
      o.start(); o.stop(beepCtx.currentTime + (ok ? 0.08 : 0.3));
    } catch (e) {}
    if (navigator.vibrate) navigator.vibrate(ok ? 40 : [80, 60, 80]);
  }
  function renderCountStart() {
    var u = state.user;
    var mine = (state.lists.Locations || []).filter(function (l) {
      return u.canAdmin || u.role === 'CountTeam' || u.locations.indexOf(l.id) !== -1;
    });
    var loc = selectEl(mine, mine.length === 1 ? mine[0].id : '', { required: true });
    var err = h('div');
    var go = h('button', { class: 'btn primary', text: 'Start count' });
    go.addEventListener('click', function () {
      clear(err);
      if (!loc.value) { err.appendChild(h('div', { class: 'error', text: 'Choose the location to count.' })); return; }
      go.disabled = true;
      api('startCount', { locationId: loc.value }).then(function (d) { countSession = d; location.hash = '#/count/' + d.count.CountId; })
        .catch(function (e) { go.disabled = false; err.appendChild(h('div', { class: 'error', text: e.message })); });
    });
    var work = (state.work && state.work.counts) || [];
    shell('count', h('div', { class: 'stack narrowish' },
      h('div', { class: 'card regform' }, h('h2', { text: 'Stock count' }),
        h('div', { class: 'muted small', text: 'Pick a location, then scan every asset there. A handheld scanner works best: each scan beeps, and the list fills as you go.' }),
        err, field('Location', loc, true), h('div', { class: 'actions' }, go)),
      work.length ? workList('Counts in progress', work, countRow, '') : null));
  }

  var countSession = null;
  function queueKey(id) { return 'fas_count_' + id; }
  function renderCount(id) {
    var holder = h('div', { class: 'stack narrowish' }, h('div', { class: 'card' }, h('div', { class: 'spinner' })));
    shell('count', holder);
    api('count', { id: id }).then(function (d) {
      if (d.count.Status !== 'Open') return paintCountReport(holder, d);
      var start = countSession && countSession.count.CountId === id ? Promise.resolve(countSession) : api('startCount', { locationId: d.count.LocationId });
      return start.then(function (s) { countSession = s; paintCounter(holder, s); });
    }).catch(function (e) { clear(holder); holder.appendChild(h('div', { class: 'error', text: e.message })); });
  }
  function paintCounter(holder, s) {
    clear(holder);
    var id = s.count.CountId;
    var expected = {}; s.expected.forEach(function (e) { expected[e.code] = e.name; });
    var seen = {}; (s.scanned || []).forEach(function (c) { seen[c] = 'synced'; });
    var queue = []; try { queue = JSON.parse(localStorage.getItem(queueKey(id)) || '[]'); } catch (e) {}
    queue.forEach(function (c) { seen[c] = 'queued'; });
    var results = {}; // code -> found | elsewhere | unknown
    (s.scanned || []).forEach(function (c) { results[c] = expected[c] ? 'found' : 'other'; });
    var input = h('input', { class: 'scaninput', type: 'text', placeholder: 'Scan here', autocomplete: 'off', autocapitalize: 'characters', 'aria-label': 'Asset code' });
    var stats = h('div', { class: 'stats' });
    var feed = h('div', { class: 'feed' });
    var syncing = false, timer = null;
    var camBox = h('div', { id: 'cam', class: 'cam' });
    var camBtn = h('button', { class: 'btn', text: 'Use camera' });
    var scanner = null;

    function saveQueue() { try { localStorage.setItem(queueKey(id), JSON.stringify(queue)); } catch (e) {} }
    function paintStats() {
      clear(stats);
      var found = Object.keys(results).filter(function (c) { return results[c] === 'found'; }).length;
      var other = Object.keys(results).filter(function (c) { return results[c] !== 'found'; }).length;
      stats.appendChild(stat('Found here', found + ' of ' + s.expected.length));
      stats.appendChild(stat('Not on this list', other));
      stats.appendChild(stat('Waiting to save', queue.length));
    }
    function line(code, kind, text) {
      var row = h('div', { class: 'feedrow ' + kind }, h('span', { class: 'code', text: code }), h('span', { text: text }));
      feed.insertBefore(row, feed.firstChild);
      while (feed.childNodes.length > 60) feed.removeChild(feed.lastChild);
      return row;
    }
    function scan(raw) {
      var code = String(raw || '').trim().toUpperCase();
      input.value = '';
      if (!code) return;
      if (seen[code]) { beep(true); line(code, 'dup', 'Already scanned'); return; }
      seen[code] = 'queued';
      queue.push(code); saveQueue();
      if (expected[code]) { results[code] = 'found'; beep(true); line(code, 'ok', expected[code]); }
      else { results[code] = 'other'; beep(false); line(code, 'warn', 'Not recorded here, checking…').setAttribute('data-code', code); }
      paintStats();
      if (queue.length >= 10) sync(); else { clearTimeout(timer); timer = setTimeout(sync, 6000); }
    }
    function sync(finish) {
      if (syncing) return Promise.resolve();
      if (!queue.length && !finish) return Promise.resolve();
      syncing = true;
      var batch = queue.slice(0, 500);
      return api('countScans', { id: id, codes: batch, finish: finish === true }).then(function (d) {
        queue = queue.slice(batch.length); saveQueue();
        d.results.forEach(function (r) {
          seen[r.code] = 'synced';
          var row = feed.querySelector('[data-code="' + r.code + '"]');
          if (row && r.result !== 'found') {
            row.lastChild.textContent = r.result === 'elsewhere' ? (r.name + ' · recorded at ' + r.location) : 'Unknown code';
            row.className = 'feedrow ' + (r.result === 'elsewhere' ? 'warn' : 'bad');
          }
        });
        syncing = false; paintStats();
        if (finish) { try { localStorage.removeItem(queueKey(id)); } catch (e) {} countSession = null; stopCam(); loadWork(); paintCountReport(holder, d); }
        else if (queue.length) sync();
      }).catch(function (e) { syncing = false; toast('Not saved yet: ' + e.message); paintStats(); throw e; });
    }
    function stopCam() { if (scanner) { try { scanner.stop().then(function () { scanner.clear(); }).catch(function () {}); } catch (e) {} scanner = null; } camBox.classList.remove('on'); camBtn.textContent = 'Use camera'; }
    window.FAS_stopCamera = function () { stopCam(); clearTimeout(timer); if (queue.length) sync().catch(function () {}); };
    camBtn.addEventListener('click', function () {
      if (scanner) return stopCam();
      loadScript(SCAN_LIB).then(function () {
        camBox.classList.add('on');
        scanner = new Html5Qrcode('cam');
        var last = '', at = 0;
        return scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 220, height: 220 } }, function (text) {
          var now = Date.now(); if (text === last && now - at < 2500) return; last = text; at = now; scan(text);
        });
      }).then(function () { camBtn.textContent = 'Stop camera'; }).catch(function () { stopCam(); toast('Camera could not start.'); });
    });
    var finishBtn = h('button', { class: 'btn primary', text: 'Finish count' });
    finishBtn.addEventListener('click', function () {
      var found = Object.keys(results).filter(function (c) { return results[c] === 'found'; }).length;
      if (!confirm('Finish the count? ' + (s.expected.length - found) + ' assets on the list were not scanned and will be reported missing.')) return;
      finishBtn.disabled = true; finishBtn.textContent = 'Saving…';
      sync(true).catch(function () { finishBtn.disabled = false; finishBtn.textContent = 'Finish count'; });
    });
    var cancelBtn = h('button', { class: 'btn', text: 'Cancel count' });
    cancelBtn.addEventListener('click', function () {
      if (!confirm('Cancel this count? Nothing will be recorded.')) return;
      api('cancelCount', { id: id }).then(function () { try { localStorage.removeItem(queueKey(id)); } catch (e) {} countSession = null; stopCam(); loadWork(); location.hash = '#/count'; })
        .catch(function (e) { toast(e.message); });
    });
    holder.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row-between' }, h('div', null, h('div', { class: 'code', text: id }), h('h2', { text: s.count.LocationName })), camBtn),
      camBox,
      h('form', { class: 'scanrow', onsubmit: function (e) { e.preventDefault(); scan(input.value); } }, input, h('button', { class: 'btn', text: 'Add' })),
      h('div', { class: 'hint', text: 'Green beep: on this location\'s list. Low beep: not recorded here.' })));
    holder.appendChild(stats);
    holder.appendChild(h('div', { class: 'card' }, h('h3', { text: 'Scanned' }), feed));
    holder.appendChild(h('div', { class: 'card row-between' }, cancelBtn, finishBtn));
    paintStats();
    if (queue.length) sync().catch(function () {});
    setTimeout(function () { input.focus(); }, 50);
    // Keep focus in the scan box so a handheld scanner always types into it.
    holder.addEventListener('click', function (e) { if (!/INPUT|BUTTON|SELECT|TEXTAREA|A/.test(e.target.tagName)) input.focus(); });
  }
  function paintCountReport(holder, d) {
    clear(holder);
    var c = d.count, L = c.lists || { found: [], missing: [], elsewhere: [], unknown: [] };
    var exp = h('button', { class: 'btn', text: 'Export to Excel' });
    exp.addEventListener('click', function () {
      var out = [['Count', c.CountId], ['Location', c.LocationName], ['Finished', c.FinishedAt], [], ['Result', 'Code', 'Asset', 'Recorded location']];
      [['Missing', L.missing], ['Found but recorded elsewhere', L.elsewhere], ['Unknown code', L.unknown], ['Found', L.found]].forEach(function (g) {
        g[1].forEach(function (x) { out.push([g[0], x.code, x.name || '', x.location || '']); });
      });
      downloadCsv('Count ' + c.CountId + '.csv', out);
    });
    holder.appendChild(h('div', { class: 'card' }, h('div', { class: 'row-between' },
      h('div', null, h('div', { class: 'code', text: c.CountId }), h('h2', { text: c.LocationName })), h('div', { class: 'inline' }, statusBadge(c.Status), exp)),
      h('div', { class: 'muted small', text: 'Started ' + fmtTime(c.StartedAt) + (c.FinishedAt ? ' · finished ' + fmtTime(c.FinishedAt) : '') })));
    holder.appendChild(h('div', { class: 'stats' }, stat('Found here', c.found + ' of ' + c.Expected), stat('Missing', c.missing),
      stat('From other locations', c.elsewhere), stat('Unknown codes', c.unknown)));
    var group = function (title, list, note) {
      if (!list.length) return null;
      return h('section', { class: 'card' }, h('h3', { text: title + ' (' + list.length + ')' }), note ? h('div', { class: 'muted small', text: note }) : null,
        h('div', { class: 'worklist' }, list.map(function (x) {
          return h('a', { class: 'workitem', href: x.name ? '#/scan/' + x.code : '#/count/' + c.CountId },
            h('div', null, h('div', { class: 'strong' }, h('span', { class: 'code', text: x.code }), ' ', x.name || ''),
              x.location ? h('div', { class: 'muted small', text: 'Recorded at ' + x.location }) : null), x.status ? statusBadge(x.status) : null);
        })));
    };
    [group('Missing', L.missing, 'On this location\'s list but not scanned. Look again, or report a loss through maintenance.'),
      group('Found but recorded elsewhere', L.elsewhere, 'Move them on the system with a transfer, or send them back.'),
      group('Unknown codes', L.unknown, 'Labels never printed or registered. Check them.'),
      group('Found here', L.found)].forEach(function (x) { if (x) holder.appendChild(x); });
  }

  function loadWork() {
    return api('work').then(function (w) { state.work = w; return w; }).catch(function () { return state.work; });
  }

  // ----------------------------------------------------------------- boot
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
  var existing = savedToken();
  if (existing) { state.token = existing; loadSession(); }
  else renderLogin(CFG.backendUrl ? null : 'The app is not connected to its backend yet.');
})();
