// Local HTTP stand-in for the Apps Script web app, running the real Code.gs on mocks.
// Any token of the form "fake.<base64url json>.sig" is accepted as a Google ID token for that payload.
const http = require('http');
const { makeEnv } = require('./mockenv');

const env = makeEnv();
env.ctx.setup();
const origAdd = env.addToken;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}');
      if (parsed.token && parsed.token.startsWith('fake.')) {
        const payload = JSON.parse(Buffer.from(parsed.token.split('.')[1], 'base64url').toString());
        origAdd(parsed.token, payload.email, { name: payload.name });
      }
    } catch (e) { /* let Code.gs reject it */ }
    const out = env.ctx.doPost({ postData: { contents: body } });
    res.setHeader('Content-Type', 'application/json');
    res.end(out.body);
  });
});
server.listen(Number(process.env.PORT || 8790), () => console.log('mock backend on', server.address().port));
