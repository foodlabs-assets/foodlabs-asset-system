"""End-to-end UI check against the mock backend (real Code.gs logic, mocked Google services)."""
import base64, json, subprocess, sys, time, os
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..', 'app')
SHOTS = os.path.join(HERE, 'shots')
os.makedirs(SHOTS, exist_ok=True)

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

backend = subprocess.Popen(['node', os.path.join(HERE, 'mock-server.js')], env=dict(os.environ, PORT='8790'))
static = subprocess.Popen([sys.executable, '-m', 'http.server', '8791'], cwd=APP, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
errors = []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])

        def page_for(email, name, viewport):
            ctx = browser.new_context(viewport=viewport)
            ctx.add_init_script('window.__TOKEN = %s;' % json.dumps(fake_token(email, name)))
            ctx.route('**/gsi/client', lambda r: r.fulfill(status=200, content_type='text/javascript', body=GSI_STUB))
            ctx.route('**/qrcode.min.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=QR_STUB))
            ctx.route('**/html5-qrcode.min.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body='window.Html5Qrcode=function(){this.start=function(){return Promise.reject(new Error("NotAllowedError Permission"))};this.stop=function(){return Promise.resolve()};this.clear=function(){}};'))
            ctx.route('**/config.js*', lambda r: r.fulfill(status=200, content_type='text/javascript',
                body="window.FAS_CONFIG={clientId:'x',backendUrl:'http://localhost:8790/exec'};"))
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append(str(e)))
            pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
            return pg

        # Admin on desktop
        pg = page_for('osama@foodlabs.com.kw', 'Osama Osman', {'width': 1280, 'height': 800})
        pg.goto('http://localhost:8791/index.html')
        pg.screenshot(path=f'{SHOTS}/01-login.png')
        pg.click('#fake-google')
        pg.wait_for_selector('text=Welcome, Osama Osman')
        assert pg.is_visible('nav >> text=Admin')
        pg.screenshot(path=f'{SHOTS}/02-home-admin.png')

        pg.click('nav >> text=Admin')
        pg.wait_for_selector('table.datatable >> text=osama@foodlabs.com.kw')

        def add(table_title, fill):
            pg.click(f'.tablist >> text="{table_title}"')
            pg.wait_for_selector('.toolbar h3:has-text("%s")' % table_title)
            pg.wait_for_selector('.toolbar >> text=Add')
            pg.click('.toolbar >> text=Add')
            pg.wait_for_selector('.drawer')
            fill()
            pg.click('.drawer footer >> text=Create')
            try:
                pg.wait_for_selector('.drawer', state='detached', timeout=5000)
            except Exception:
                print('drawer stuck on', table_title, pg.inner_text('.drawer'))
                raise

        def fill_name(name):
            return lambda: pg.fill('.drawer .field:has(label:has-text("Name")) input', name)

        add('Brands', fill_name("Philly's"))
        add('Brands', fill_name("Smashy's"))

        def fill_loc():
            pg.fill('.drawer .field:has(label:has-text("Name")) input', 'Salwa')
            pg.select_option('.drawer .field:has(label:has-text("Type")) select', 'Branch')
            pg.select_option('.drawer .field:has(label:has-text("Brand")) select', label="Philly's")
        add('Locations', fill_loc)
        add('Locations', lambda: (pg.fill('.drawer .field:has(label:has-text("Name")) input', 'Central kitchen'),
                                  pg.select_option('.drawer .field:has(label:has-text("Type")) select', 'Central kitchen')))
        pg.wait_for_selector('table.datatable >> text=Central kitchen')
        assert pg.is_visible("table.datatable >> text=Philly's")

        # Validation error shows inside the drawer
        pg.click('.toolbar >> text=Add')
        pg.fill('.drawer .field:has(label:has-text("Name")) input', 'salwa')
        pg.select_option('.drawer .field:has(label:has-text("Type")) select', 'Branch')
        pg.select_option('.drawer .field:has(label:has-text("Brand")) select', label="Philly's")
        pg.click('.drawer footer >> text=Create')
        pg.wait_for_selector('.drawer .error >> text=already exists')
        pg.screenshot(path=f'{SHOTS}/03-validation.png')
        pg.click('.drawer footer >> text=Cancel')

        def fill_user():
            pg.fill('.drawer .field:has(label:has-text("Google email")) input', 'rima@foodlabs.com.kw')
            pg.fill('.drawer .field:has(label:has-text("Name")) input', 'Rima')
            pg.select_option('.drawer .field:has(label:has-text("Role")) select', 'Manager')
            pg.check('.drawer .checks label:has-text("Salwa") input')
        add('Users', fill_user)
        pg.wait_for_selector('table.datatable >> text=rima@foodlabs.com.kw')

        # Edit a category and see history
        pg.click('.tablist >> text=Categories')
        pg.click('table.datatable >> text=Kitchen equipment')
        pg.fill('.drawer .field:has(label:has-text("Useful life")) input', '60')
        pg.click('.drawer footer >> text=Save')
        pg.wait_for_selector('.drawer', state='detached')
        pg.click('table.datatable >> text=Kitchen equipment')
        pg.click('.history >> text=Show change history')
        pg.wait_for_selector('.history >> text=UsefulLifeMonths')
        pg.screenshot(path=f'{SHOTS}/04-edit-history.png')
        pg.click('.drawer footer >> text=Cancel')
        pg.click('.tablist >> text=Users')
        pg.wait_for_selector('table.datatable >> text=rima@foodlabs.com.kw')
        pg.screenshot(path=f'{SHOTS}/05-users.png')

        # Switching admin tabs uses the local copy: no backend calls
        calls = []
        pg.on('request', lambda r: '8790' in r.url and calls.append(r.url))
        for t in ['Locations', 'Brands', 'Departments', 'Users']:
            pg.click(f'.tablist >> text="{t}"')
            pg.wait_for_selector('.toolbar h3:has-text("%s")' % t)
        assert calls == [], calls
        # A reload paints from the session copy, then refreshes with one call
        calls.clear()
        pg.reload()
        pg.wait_for_selector('table.datatable >> text=rima@foodlabs.com.kw')
        pg.wait_for_timeout(800)
        assert len(calls) == 1, calls

        # ---------------- phase 2: lists for the form
        add('Departments', fill_name('Kitchen'))

        # Departments: the cost centre list appears only for "Selected cost centres"
        pg.click('.toolbar >> text=Add')
        pg.wait_for_selector('.drawer')
        pg.fill('.drawer .field:has(label:text-is("Name")) input', 'Juice production')
        assert not pg.is_visible('.drawer .field:has(label:text-is("Cost centres"))')
        pg.select_option('.drawer .field:has(label:has-text("Depreciation goes to")) select', 'Selected cost centres')
        pg.wait_for_selector('.drawer .field:has(label:text-is("Cost centres"))')
        pg.check('.drawer label:has-text("Juiced - b2b - CK") input')
        pg.screenshot(path=f'{SHOTS}/06b-department-cost-centres.png')
        pg.click('.drawer footer >> text=Create')
        pg.wait_for_selector('.drawer', state='detached', timeout=5000)
        pg.wait_for_selector('table.datatable >> text=Juiced - b2b - CK')

        # Cost centres table is seeded with the Xero tracking options
        pg.click('.tablist >> text="Cost centres"')
        pg.wait_for_selector("table.datatable >> text=Philly's - Hawally")
        add('Asset types', lambda: (pg.fill('.drawer .field:has(label:has-text("Name")) input', 'Oven'),
                                    pg.select_option('.drawer .field:has(label:has-text("Category")) select', label='Kitchen equipment')))
        def fill_count_user():
            pg.fill('.drawer .field:has(label:has-text("Google email")) input', 'count1@foodlabs.com.kw')
            pg.fill('.drawer .field:has(label:has-text("Name")) input', 'Count One')
            pg.select_option('.drawer .field:has(label:has-text("Role")) select', 'CountTeam')
        add('Users', fill_count_user)
        pg.reload(); pg.wait_for_selector('nav >> text=Labels')

        # Labels: create a batch, print free labels, open the count
        pg.click('nav >> text=Labels')
        pg.fill('.field:has(label:has-text("How many labels")) input', '20')
        pg.click('text=Create batch')
        pg.wait_for_selector('td >> text=FL-000001 to FL-000020')
        pg.evaluate("window.__printed = 0; HTMLIFrameElement.prototype.__p = 1;")
        pg.click('td >> text=Print')
        pg.wait_for_selector('.dialog')
        pg.evaluate("""() => { const orig = document.body.appendChild.bind(document.body);
          document.body.appendChild = (el) => { const r = orig(el); if (el.tagName === 'IFRAME') { el.contentWindow.print = () => { window.__printed = el.contentWindow.document.querySelectorAll('.l').length; window.__css = el.contentWindow.document.querySelector('style').textContent; }; } return r; }; }""")
        pg.click('.dialog footer >> text=Print')
        pg.wait_for_function('window.__printed > 0')
        assert pg.evaluate('window.__printed') == 20, pg.evaluate('window.__printed')
        assert '@page{size:50mm 25mm' in pg.evaluate('window.__css')
        pg.screenshot(path=f'{SHOTS}/09-labels.png')
        pg.click('text=Open the count')
        pg.wait_for_selector('text=Close the count')

        # Count team registers a blank label on a phone
        ct = page_for('count1@foodlabs.com.kw', 'Count One', {'width': 390, 'height': 844})
        ct.goto('http://localhost:8791/index.html#/scan')
        ct.click('#fake-google')
        ct.wait_for_selector('.scaninput')
        assert not ct.is_visible('nav >> text=Labels')
        ct.fill('.scaninput', 'hello'); ct.press('.scaninput', 'Enter')
        ct.wait_for_selector('.searchout >> text=Nothing found.')
        ct.fill('.scaninput', 'FL-000500'); ct.press('.scaninput', 'Enter')
        ct.wait_for_selector('.error >> text=never printed')
        ct.click('text=Start camera')
        ct.wait_for_selector('#toast.show >> text=Allow camera access')
        ct.fill('.scaninput', 'fl-000001'); ct.press('.scaninput', 'Enter')
        ct.wait_for_selector('.regform')
        ct.click('text=Register FL-000001')
        ct.wait_for_selector('.regform .error >> text=Fill in')
        ct.select_option('.regform .field:has(label:has-text("Category")) select', label='Kitchen equipment')
        ct.select_option('.regform .field:has(label:has-text("Type")) select', label='Oven')
        assert ct.input_value('.regform .field:has(label:has-text("Name")) input') == 'Oven'
        ct.select_option('.regform .field:has(label:has-text("Location")) select', label="Philly's - Salwa")
        ct.select_option('.regform .field:has(label:has-text("Department")) select', label='Kitchen')
        ct.select_option('.regform .field:has(label:has-text("Condition")) select', 'Used')
        ct.click('summary >> text=More details')
        ct.fill('.regform .field:has(label:has-text("Make")) input', 'Rational')
        ct.fill('.regform .field:has(label:has-text("Serial number")) input', 'SN-123')
        import struct, zlib
        def png():
            raw = b'\x00' + b'\xff\x00\x00' * 4
            def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
            return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 4, 4, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw * 4)) + chunk(b'IEND', b'')
        ct.set_input_files('.regform input[type=file]', files=[{'name': 'oven.png', 'mimeType': 'image/png', 'buffer': png()}])
        ct.wait_for_selector('.thumb img')
        ct.screenshot(path=f'{SHOTS}/10-register-phone.png', full_page=True)
        ct.click('text=Register FL-000001')
        ct.wait_for_selector('.notice >> text=FL-000001 registered')
        ct.wait_for_selector('.assetcard >> text=Under review')
        assert not ct.is_visible('.assetcard >> text=Cost')
        ct.click('.photo')
        ct.wait_for_selector('.photos img')
        ct.screenshot(path=f'{SHOTS}/11-registered-phone.png', full_page=True)
        ct.fill('.scaninput', 'FL-000002'); ct.press('.scaninput', 'Enter')
        ct.wait_for_selector('.regform')
        ct.select_option('.regform .field:has(label:has-text("Category")) select', label='Kitchen equipment')
        ct.select_option('.regform .field:has(label:has-text("Type")) select', label='Oven')
        ct.select_option('.regform .field:has(label:has-text("Location")) select', label="Philly's - Salwa")
        ct.select_option('.regform .field:has(label:has-text("Department")) select', label='Kitchen')
        ct.select_option('.regform .field:has(label:has-text("Condition")) select', 'Used')
        ct.click('text=Register FL-000002')
        ct.wait_for_selector('.notice >> text=FL-000002 registered')

        # Accounting: import the old register, link both ovens to one line
        csv_text = 'LineId,Source,Name,LocationRaw,LocationSuggested,PurchaseDate,Cost,LifeMonths,AccumDeprDec2026,NbvDec2026,RemainingMonths,Flags\n' \
                   'OLD-EQP1,Old register,"Ovens (2 pcs)",HOF,Head office,2023-01-10,1000,60,600,400,24,Several units on one line\n' \
                   'NEW-001,New register,Shop fit-out,B.Salmiya,Boba Salmiya,2025-01-05,5000,60,1000,4000,48,\n'
        pg.reload(); pg.wait_for_selector('nav >> text=Matching')
        pg.click('nav >> text=Matching')
        pg.wait_for_selector('text=Import the old register')
        pg.set_input_files('input[type=file]', files=[{'name': 'legacy.csv', 'mimeType': 'text/csv', 'buffer': csv_text.encode()}])
        pg.wait_for_selector('.notice >> text=2 lines')
        pg.click('.actions >> text=Import')
        pg.wait_for_selector('.match')
        pg.click('button.pick >> text=Ovens (2 pcs)')
        pg.check('label.pick:has-text("FL-000001") input')
        pg.check('label.pick:has-text("FL-000002") input')
        pg.wait_for_selector('.alloc')
        assert pg.input_value('.allocrow:has-text("FL-000002") input >> nth=0') == '500'
        pg.screenshot(path=f'{SHOTS}/12-matching.png', full_page=True)
        pg.click('.detail button:text-is("Link")')
        pg.wait_for_selector('#toast.show >> text=Linked', timeout=8000) if not pg.is_visible('.detail .error') else None
        err = pg.inner_text('.detail .error') if pg.is_visible('.detail .error') else ''
        assert not err, err
        pg.wait_for_selector('.stat:has-text("Lines matched") >> text=1')
        pg.click('button.pick >> text=Shop fit-out')
        pg.click('summary >> text=No physical item')
        pg.select_option('.detail details select >> nth=0', label='Leasehold improvements')
        pg.select_option('.detail details select >> nth=1', label="Philly's - Salwa")
        pg.click('text=Record without label')
        pg.wait_for_selector('.stat:has-text("Lines matched") >> text=2')

        # Reconciliation
        pg.click('nav >> text=Reconciliation')
        pg.wait_for_selector('h2 >> text=Reconciliation with Xero')
        pg.wait_for_selector('table.datatable >> text=(category has no asset account)')
        assert pg.is_visible('table.datatable >> text=-1,600.000')
        pg.screenshot(path=f'{SHOTS}/13-recon.png', full_page=True)

        # Admin can see the value on scan
        pg.goto('http://localhost:8791/index.html#/scan/FL-000001')
        pg.wait_for_selector('.assetcard >> text=Active')
        assert pg.is_visible('.assetcard >> text=500.000')

        # Manager on a phone
        mg = page_for('rima@foodlabs.com.kw', 'Rima', {'width': 390, 'height': 844})
        mg.goto('http://localhost:8791/index.html')
        mg.click('#fake-google')
        mg.wait_for_selector('text=Welcome, Rima')
        assert not mg.is_visible('nav >> text=Admin')
        assert mg.is_visible('.pill >> text=Salwa')
        mg.goto('http://localhost:8791/index.html#/admin')
        mg.wait_for_selector('text=Welcome, Rima')
        mg.screenshot(path=f'{SHOTS}/06-manager-phone.png')

        # Stranger
        st = page_for('nobody@gmail.com', 'Nobody', {'width': 390, 'height': 844})
        st.goto('http://localhost:8791/index.html')
        st.click('#fake-google')
        st.wait_for_selector('.error >> text=no access')
        st.screenshot(path=f'{SHOTS}/07-stranger.png')

        # Admin on phone: admin list layout
        ap = page_for('osama@foodlabs.com.kw', 'Osama Osman', {'width': 390, 'height': 844})
        ap.goto('http://localhost:8791/index.html#/admin/Locations')
        ap.click('#fake-google')
        ap.wait_for_selector('table.datatable >> text=Salwa')
        ap.screenshot(path=f'{SHOTS}/08-admin-phone.png', full_page=True)
        browser.close()
finally:
    backend.terminate(); static.terminate()

real_errors = [e for e in errors if 'favicon' not in e]
print('console errors:', real_errors)
assert not real_errors
print('UI test passed')
