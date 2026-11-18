/* Foodlabs Asset System — front end (plain JavaScript, no build step). */
(function () {
  'use strict';

  var CFG = window.FAS_CONFIG || {};
  var TOKEN_KEY = 'fas_token';
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
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    renderLogin();
  }

  // ------------------------------------------------------------------ api
  function api(action, payload) {
    if (!CFG.backendUrl) return Promise.reject(new Error('The app is not connected to its backend yet.'));
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
  function loadSession() {
    api('meta').then(function (meta) {
      state.meta = meta; state.user = meta.user;
      route();
    }).catch(function (e) {
      try { sessionStorage.removeItem(TOKEN_KEY); } catch (x) {}
      state.token = null;
      renderLogin(e.message);
    });
  }

  // ---------------------------------------------------------------- shell
  function shell(active, content) {
    clear(root);
    var u = state.user;
    var nav = [h('a', { href: '#/home', class: active === 'home' ? 'active' : '', text: 'Home' })];
    if (u.canAdmin) nav.push(h('a', { href: '#/admin', class: active === 'admin' ? 'active' : '', text: 'Admin' }));
    root.appendChild(h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('img', { src: 'assets/icon.svg', alt: '' }), h('span', { text: 'Foodlabs Assets' })),
      h('nav', null, nav),
      h('div', { class: 'spacer' }),
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
    if (parts[0] === 'admin' && state.user.canAdmin) return renderAdmin(parts[1]);
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
    shell('home', card);
  }

  // ---------------------------------------------------------------- admin
  function tableOrder() {
    var order = ['Users', 'Locations', 'Departments', 'Brands', 'Categories', 'Types', 'Settings'];
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
    var listBox = h('div', null, h('div', { class: 'boot', style: 'min-height:160px' }, h('div', { class: 'spinner' })));
    shell('admin', h('div', { class: 'admin' }, tabs,
      h('section', null, h('div', { class: 'toolbar' }, h('h3', { text: def.title }), search, addBtn), listBox)));

    var refs = refTablesFor(def);
    Promise.all([loadTable(tableName, true)].concat(refs.map(function (r) { return loadTable(r); })))
      .then(function (res) {
        var rows = res[0];
        var paint = function () { paintTable(listBox, tableName, def, rows, search.value); };
        search.addEventListener('input', paint);
        paint();
      })
      .catch(function (e) { clear(listBox); listBox.appendChild(h('div', { class: 'error', text: e.message })); });
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
    for (var i = 0; i < rows.length; i++) if (String(rows[i][def.key]) === String(id)) return rows[i].Name || id;
    return id;
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
            .map(function (r) { return [r[state.meta.tables[f.table].key], r.Name]; });
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
          list.appendChild(h('label', null, c, r.Name));
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
      body.appendChild(field);
    });

    if (!isNew) {
      var hist = h('div', { class: 'history' }, h('h4', { text: 'Change history' }), h('div', { class: 'muted', text: 'Loading…' }));
      body.appendChild(hist);
      api('audit', { table: tableName, id: row[def.key] }).then(function (d) {
        hist.removeChild(hist.lastChild);
        if (!d.rows.length) { hist.appendChild(h('div', { class: 'muted', text: 'No changes recorded.' })); return; }
        hist.appendChild(h('ul', null, d.rows.slice(0, 30).map(function (a) {
          var what = a.Action === 'create' ? 'Created' : (a.Field + ': ' + (a.OldValue || '—') + ' → ' + (a.NewValue || '—'));
          return h('li', null, what, h('small', { text: a.Timestamp + ' · ' + a.User }));
        })));
      }).catch(function () { hist.lastChild.textContent = 'History unavailable.'; });
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
        delete state.cache[tableName];
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
    var map = { Users: 'user', Locations: 'location', Departments: 'department', Brands: 'brand', Categories: 'category', 'Asset types': 'asset type', Settings: 'setting' };
    return map[title] || title.toLowerCase();
  }

  // ----------------------------------------------------------------- boot
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
  var existing = savedToken();
  if (existing) { state.token = existing; loadSession(); }
  else renderLogin(CFG.backendUrl ? null : 'The app is not connected to its backend yet.');
})();
