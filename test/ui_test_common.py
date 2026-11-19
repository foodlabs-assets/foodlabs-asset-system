"""Shared stubs for the UI tests."""
import base64, json, time

def fake_token(email, name):
    body = base64.urlsafe_b64encode(json.dumps({'email': email, 'name': name, 'exp': int(time.time()) + 3600}).encode()).decode().rstrip('=')
    return 'fake.' + body + '.sig'

QR_STUB = """
window.qrcode = function () { return { addData: function () {}, make: function () {}, createSvgTag: function () { return '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'; } }; };
"""
GSI_STUB = """
window.google = { accounts: { id: {
  initialize: function (c) { window.__gsi = c; },
  renderButton: function (el) { var b = document.createElement('button'); b.id = 'fake-google'; b.textContent = 'Sign in with Google'; b.onclick = function () { window.__gsi.callback({ credential: window.__TOKEN }); }; el.appendChild(b); },
  prompt: function () {}, disableAutoSelect: function () {}
} } };
"""

SCAN_STUB = 'window.Html5Qrcode=function(){this.start=function(){return Promise.reject(new Error("NotAllowedError Permission"))};this.stop=function(){return Promise.resolve()};this.clear=function(){}};'
