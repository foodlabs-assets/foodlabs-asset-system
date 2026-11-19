"""Phase 3 end-to-end check: maintenance, transfer with receipt, stock count, bell, search."""
import base64, json, subprocess, sys, time, os, urllib.request
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ui_test_common import fake_token, GSI_STUB, QR_STUB, SCAN_STUB

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..', 'app')
SHOTS = os.path.join(HERE, 'shots')
os.makedirs(SHOTS, exist_ok=True)
PORT_B, PORT_S = '8792', '8793'

backend = subprocess.Popen(['node', os.path.join(HERE, 'mock-server.js')], env=dict(os.environ, PORT=PORT_B))
static = subprocess.Popen([sys.executable, '-m', 'http.server', PORT_S], cwd=APP, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)

PEOPLE = {'osama': ('osama@foodlabs.com.kw', 'Osama Osman'), 'rima': ('rima@foodlabs.com.kw', 'Rima Branch'),
          'sam': ('sam@foodlabs.com.kw', 'Sam Kitchen'), 'ali': ('ali@foodlabs.com.kw', 'Ali Tech'), 'acc': ('acc@foodlabs.com.kw', 'Asma Accounts')}
TOK = {k: fake_token(*v) for k, v in PEOPLE.items()}

def call(who, action, payload=None):
    req = urllib.request.Request('http://localhost:%s/exec' % PORT_B, data=json.dumps({'token': TOK[who], 'action': action, 'payload': payload or {}}).encode(), method='POST')
    out = json.loads(urllib.request.urlopen(req).read())
    assert out['ok'], (action, out)
    return out['data']

errors = []
try:
    # Seed through the API
    call('osama', 'me')
    call('osama', 'save', {'table': 'Brands', 'isNew': True, 'record': {'Name': "Philly's"}})
    L1 = call('osama', 'save', {'table': 'Locations', 'isNew': True, 'record': {'Name': 'Salwa', 'Type': 'Branch', 'Brand': 'BRD-001'}})['record']['LocationId']
    L2 = call('osama', 'save', {'table': 'Locations', 'isNew': True, 'record': {'Name': 'Central kitchen', 'Type': 'Central kitchen'}})['record']['LocationId']
    call('osama', 'save', {'table': 'Departments', 'isNew': True, 'record': {'Name': 'Kitchen'}})
    for k, role, locs in [('rima', 'Manager', [L1]), ('sam', 'Manager', [L2]), ('ali', 'Technician', []), ('acc', 'Accounting', [])]:
        call('osama', 'save', {'table': 'Users', 'isNew': True, 'record': {'Email': PEOPLE[k][0], 'Name': PEOPLE[k][1], 'Role': role, 'Locations': locs, 'Active': True}})
    typ = call('osama', 'save', {'table': 'Types', 'isNew': True, 'record': {'Name': 'Oven', 'CategoryId': 'CAT-001'}})['record']['TypeId']
    call('osama', 'createLabelBatch', {'quantity': 10})
    for code, loc in [('FL-000001', L1), ('FL-000002', L1), ('FL-000003', L2)]:
        call('osama', 'register', {'code': code, 'asset': {'Name': 'Combi oven ' + code[-1], 'CategoryId': 'CAT-001', 'TypeId': typ, 'LocationId': loc, 'DepartmentId': 'DEP-001', 'Condition': 'Used', 'SerialNo': 'SN-' + code[-1]}})
        call('osama', 'setFinance', {'code': code, 'values': {'Cost': 1200, 'OpeningAccumDepr': 300, 'activate': True}})

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])

        def page_for(who, viewport):
            ctx = browser.new_context(viewport=viewport)
            ctx.add_init_script('window.__TOKEN = %s;' % json.dumps(TOK[who]))
            ctx.route('**/gsi/client', lambda r: r.fulfill(status=200, content_type='text/javascript', body=GSI_STUB))
            ctx.route('**/qrcode.min.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=QR_STUB))
            ctx.route('**/html5-qrcode.min.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=SCAN_STUB))
            ctx.route('**/config.js*', lambda r: r.fulfill(status=200, content_type='text/javascript',
                body="window.FAS_CONFIG={clientId:'x',backendUrl:'http://localhost:%s/exec'};" % PORT_B))
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append(str(e)))
            pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
            pg.on('dialog', lambda d: d.accept('Duplicate') if d.type == 'prompt' else d.accept())
            pg.goto('http://localhost:%s/index.html' % PORT_S)
            pg.click('#fake-google')
            pg.wait_for_selector('text=Welcome, ' + PEOPLE[who][1])
            return pg

        phone = {'width': 390, 'height': 844}
        desk = {'width': 1280, 'height': 860}

        # 1. Branch manager asks for maintenance from the asset card
        rima = page_for('rima', phone)
        rima.screenshot(path=f'{SHOTS}/p3-01-home-manager.png', full_page=True)
        rima.click('nav >> text=Scan')
        rima.fill('.scaninput', 'FL-000001'); rima.press('.scaninput', 'Enter')
        rima.wait_for_selector('.assetcard >> text=Combi oven 1')
        assert rima.is_visible('text=Print custody form')
        rima.click('text=Request maintenance')
        rima.select_option('.dialog .field:has(label:has-text("Type")) select', 'Breakdown')
        rima.select_option('.dialog .field:has(label:has-text("Priority")) select', 'Urgent')
        rima.fill('.dialog textarea', 'Does not heat up')
        assert rima.input_value('.dialog .field:has(label:has-text("Technician")) select') == PEOPLE['ali'][0]
        rima.screenshot(path=f'{SHOTS}/p3-02-request-form.png')
        rima.click('.dialog >> text=Send request')
        rima.wait_for_selector('text=Open maintenance')
        rima.wait_for_selector('.assetcard >> text=In maintenance')
        rima.screenshot(path=f'{SHOTS}/p3-03-asset-in-maintenance.png', full_page=True)

        # 2. Technician: bell, start, work done
        ali = page_for('ali', phone)
        ali.wait_for_selector('.bell .dot >> text=1')
        ali.wait_for_selector('text=Assigned to you')
        ali.click('.bell')
        ali.wait_for_selector('.noticepanel >> text=MR-001')
        ali.screenshot(path=f'{SHOTS}/p3-04-bell.png')
        ali.click('.noticeitem')
        ali.wait_for_selector('h3:has-text("Combi oven 1")')
        assert not ali.is_visible('text=Invoice and cost')
        ali.click('text=Start work')
        ali.wait_for_selector('.assethead >> text=In progress')
        ali.fill('.regform textarea', 'Replaced heating element')
        ali.select_option('.regform select', 'Repaired')
        ali.click('text=Record work done')
        ali.wait_for_selector('.assethead >> text=Work done')
        ali.screenshot(path=f'{SHOTS}/p3-05-work-done.png', full_page=True)

        # 3. Accounting closes with the invoice
        acc = page_for('acc', desk)
        acc.wait_for_selector('.workitem >> text=Work done')
        acc.click('.workitem:has-text("MR-001")')
        acc.wait_for_selector('text=Invoice and cost')
        acc.fill('.regform .field:has(label:has-text("Cost")) input', '35.250')
        acc.fill('.regform .field:has(label:has-text("Invoice number")) input', 'INV-881')
        acc.set_input_files('.regform input[type=file]', files=[{'name': 'inv.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 test'}])
        acc.wait_for_selector('.pdficon')
        acc.screenshot(path=f'{SHOTS}/p3-06-close-invoice.png', full_page=True)
        acc.click('text=Close request')
        acc.wait_for_selector('.assethead >> text=Closed')
        acc.wait_for_selector('text=Open invoice 1')
        assert acc.is_visible('dd >> text=35.250')

        # 4. Transfer: the sender asks, the receiver confirms by scanning
        rima.goto('http://localhost:%s/index.html#/scan/FL-000002' % PORT_S)
        rima.wait_for_selector('.assetcard >> text=Combi oven 2')
        rima.click('text=Move to another location')
        rima.select_option('.dialog .field:has(label:has-text("Move to")) select', label='Central kitchen')
        rima.fill('.dialog .field:has(label:has-text("Reason")) input', 'Needed for juice prep')
        rima.click('.dialog >> text=Send')
        rima.wait_for_selector('text=On its way')
        assert not rima.is_visible('text=Confirm receipt')
        rima.screenshot(path=f'{SHOTS}/p3-07-transfer-sent.png', full_page=True)

        sam = page_for('sam', phone)
        sam.wait_for_selector('text=Transfers waiting for receipt')
        sam.click('nav >> text=Scan')
        sam.fill('.scaninput', 'FL-000002'); sam.press('.scaninput', 'Enter')
        sam.wait_for_selector('text=Confirm receipt')
        sam.click('text=Confirm receipt')
        sam.wait_for_selector('#toast.show >> text=Received')
        sam.wait_for_selector('dd >> text=Central kitchen')
        assert not sam.is_visible('text=On its way')

        # 5. Stock count with a handheld scanner (keyboard input)
        sam.click('nav >> text=Count')
        sam.wait_for_selector('text=Start count')
        sam.click('text=Start count')
        sam.wait_for_selector('.scaninput')
        for c in ['FL-000003', 'FL-000001', 'FL-000009', 'FL-000003']:
            sam.fill('.scaninput', c); sam.press('.scaninput', 'Enter')
        sam.wait_for_selector('.feedrow.dup >> text=Already scanned')
        sam.wait_for_selector('.feedrow.warn >> text=recorded at', timeout=15000)
        sam.wait_for_selector('.feedrow.bad >> text=Unknown code', timeout=15000)
        sam.screenshot(path=f'{SHOTS}/p3-08-counting.png', full_page=True)
        sam.click('text=Finish count')
        sam.wait_for_selector('h3:has-text("Missing (1)")')
        sam.wait_for_selector('.workitem >> text=FL-000002')
        sam.screenshot(path=f'{SHOTS}/p3-09-count-report.png', full_page=True)

        # 6. Admin: search, bell after count, history on the card
        adm = page_for('osama', desk)
        adm.fill('.search.big', 'oven'); adm.press('.search.big', 'Enter')
        adm.wait_for_selector('.searchout .workitem >> text=Combi oven 3')
        adm.fill('.search.big', 'SN-1'); adm.press('.search.big', 'Enter')
        adm.wait_for_selector('.searchout .workitem >> text=Combi oven 1')
        adm.wait_for_selector('.bell .dot')
        adm.goto('http://localhost:%s/index.html#/scan/FL-000001' % PORT_S)
        adm.wait_for_selector('text=Maintenance history · total 35.250')
        adm.screenshot(path=f'{SHOTS}/p3-10-admin-asset.png', full_page=True)
        # Users form has the backup switch for area and operations managers
        adm.goto('http://localhost:%s/index.html#/admin/Users' % PORT_S)
        adm.click('table.datatable >> text=rima@foodlabs.com.kw')
        adm.wait_for_selector('.drawer >> text=Gets maintenance requests when there is no technician')
        browser.close()
    real = [e for e in errors if 'favicon' not in e]
    print('console errors:', real)
    assert not real, real
    print('Phase 3 UI test passed')
finally:
    backend.terminate(); static.terminate()
