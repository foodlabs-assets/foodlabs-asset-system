// In-memory mocks of Apps Script services, shared by tests and the local mock server.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

// Any Apps Script method the tests do not model (formatting, validation, banding) becomes a chainable no-op.
function chain() {
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, { get: (t, k) => (k === 'then' ? undefined : (k === 'length' ? 0 : fn)), apply: () => proxy });
  return proxy;
}
function tolerant(obj) {
  return new Proxy(obj, { get: (t, k) => (k in t ? t[k] : (typeof k === 'symbol' ? undefined : chain())) });
}

function makeEnv() {
  const sheets = {};
  const props = {};
  const cache = {};
  let tokenInfo = {};
  let fetchCalls = 0;

  function makeSheet(name) {
    const data = [];
    const sh = {
      name, data, protections: [],
      getName: () => name,
      getLastRow: () => data.length,
      getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
      getRange(r, c, nr = 1, nc = 1) {
        return tolerant({
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) {
              const row = [];
              for (let j = 0; j < nc; j++) {
                const v = (data[r - 1 + i] || [])[c - 1 + j];
                row.push(v === undefined ? '' : v);
              }
              out.push(row);
            }
            return out;
          },
          setValues(vals) {
            vals.forEach((row, i) => row.forEach((v, j) => {
              while (data.length < r + i) data.push([]);
              data[r - 1 + i][c - 1 + j] = v;
            }));
            return this;
          },
          setValue(v) { return this.setValues([[v]]); },
          setFontWeight() { return this; }
        });
      },
      appendRow(row) { data.push(row.slice()); },
      setFrozenRows() {},
      getProtections() { return sh.protections; },
      getMaxRows: () => Math.max(data.length, 1000),
      getBandings: () => [],
      protect() {
        const p = { setDescription() { return p; }, setWarningOnly() { sh.protections.push(p); return p; } };
        return p;
      }
    };
    return tolerant(sh);
  }

  const ss = tolerant({
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: (s) => { delete sheets[s.name]; },
    getId: () => 'mock-sheet-id',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/mock-sheet-id',
    setActiveSheet: () => {}, moveActiveSheet: () => {}
  });

  const ctx = {
    console,
    SpreadsheetApp: tolerant({ getActive: () => ss, openById: () => ss, create: () => ss, ProtectionType: { SHEET: 'SHEET' }, BandingTheme: { LIGHT_GREY: 'LIGHT_GREY' } }),
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cache ? cache[k] : null),
        put: (k, v) => { cache[k] = v; },
        getAll: (ks) => { const o = {}; ks.forEach((k) => { if (k in cache) o[k] = cache[k]; }); return o; },
        putAll: (m) => Object.assign(cache, m),
        removeAll: (ks) => ks.forEach((k) => delete cache[k])
      })
    },
    UrlFetchApp: {
      fetch: (url) => {
        fetchCalls++;
        const tok = decodeURIComponent(url.split('id_token=')[1]);
        const info = tokenInfo[tok];
        return {
          getResponseCode: () => (info ? 200 : 400),
          getContentText: () => JSON.stringify(info || { error: 'invalid_token' })
        };
      }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_, s) => Array.from(crypto.createHash('sha256').update(s).digest()),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
      formatDate: (d) => d.toISOString().replace('T', ' ').slice(0, 19),
      base64Decode: (b64) => Array.from(Buffer.from(b64, 'base64')),
      base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
      newBlob: (bytes, type, name) => ({ getBytes: () => bytes, getContentType: () => type, getName: () => name })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    DriveApp: (() => {
      const files = {};
      let n = 0;
      const folder = { getId: () => 'folder-1', createFile: (blob) => { const id = 'file-' + (++n); files[id] = blob; return { getId: () => id }; } };
      return {
        _files: files,
        createFolder: () => folder,
        getFolderById: () => folder,
        getFileById: (id) => ({ getBlob: () => files[id] })
      };
    })(),
    Session: { getEffectiveUser: () => ({ getEmail: () => 'osama@foodlabs.com.kw' }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ body: s, setMimeType() { return this; } })
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../backend/Code.gs', 'utf8'), ctx);

  const exp = Math.floor(Date.now() / 1000) + 3600;
  ctx.__drive = ctx.DriveApp;
  function addToken(tok, email, extra = {}) {
    tokenInfo[tok] = Object.assign({
      aud: '496334927044-7u4a914om1dbv4qb7j6bfr0rmr0kggdi.apps.googleusercontent.com',
      iss: 'https://accounts.google.com', email, email_verified: 'true', exp: String(exp), name: email
    }, extra);
  }
  function call(token, action, payload) {
    const res = ctx.doPost({ postData: { contents: JSON.stringify({ token, action, payload }) } });
    return JSON.parse(res.body);
  }
  return { ctx, sheets, props, cache, addToken, call, fetchCount: () => fetchCalls };
}

module.exports = { makeEnv };
