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
            ctx.route('**/config.js', lambda r: r.fulfill(status=200, content_type='text/javascript',
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
            pg.wait_for_selector('.drawer', state='detached', timeout=5000)

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
        pg.wait_for_selector('.history >> text=UsefulLifeMonths')
        pg.screenshot(path=f'{SHOTS}/04-edit-history.png')
        pg.click('.drawer footer >> text=Cancel')
        pg.click('.tablist >> text=Users')
        pg.wait_for_selector('table.datatable >> text=rima@foodlabs.com.kw')
        pg.screenshot(path=f'{SHOTS}/05-users.png')

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
