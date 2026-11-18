// In-memory mocks of Apps Script services, shared by tests and the local mock server.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

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
        return {
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
        };
      },
      appendRow(row) { data.push(row.slice()); },
      setFrozenRows() {},
      getProtections() { return sh.protections; },
      protect() {
        const p = { setDescription() { return p; }, setWarningOnly() { sh.protections.push(p); return p; } };
        return p;
      }
    };
    return sh;
  }

  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: (s) => { delete sheets[s.name]; }
  };

  const ctx = {
    console,
    SpreadsheetApp: { getActive: () => ss, ProtectionType: { SHEET: 'SHEET' } },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; }
      })
    },
    CacheService: {
      getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } })
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
      formatDate: (d) => d.toISOString().replace('T', ' ').slice(0, 19)
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'osama@foodlabs.com.kw' }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ body: s, setMimeType() { return this; } })
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../backend/Code.gs', 'utf8'), ctx);

  const exp = Math.floor(Date.now() / 1000) + 3600;
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
  return { ctx, sheets, props, addToken, call, fetchCount: () => fetchCalls };
}

module.exports = { makeEnv };
