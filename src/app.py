import os, sqlite3, secrets, re, json, logging, html
from datetime import datetime, timezone, timedelta
from urllib.parse import quote, urlsplit, urlencode
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from functools import wraps
from flask import Flask, request, redirect, url_for, render_template, session, flash, abort, g
from werkzeug.security import generate_password_hash, check_password_hash
from mouser_import import ImportFormatError, parse_mouser_xls

app=Flask(__name__)
app.secret_key=os.environ['SECRET_KEY']
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax', SESSION_COOKIE_SECURE=os.getenv('COOKIE_SECURE','false').lower()=='true', MAX_CONTENT_LENGTH=10*1024*1024, PERMANENT_SESSION_LIFETIME=timedelta(days=30))
DB='/data/app.sqlite3'
STATUSES=['Warenkorb','Warenkorb fertig','Bestellt','Unterwegs','Angekommen','Abgeholt']
_tracking_catalog=None

def tracking_catalog():
    global _tracking_catalog
    if _tracking_catalog is None:
        paths=(os.path.join(os.path.dirname(__file__),'carrier_catalog.json'),os.path.join(os.path.dirname(__file__),'..','universal-parcel-scraper','data','catalog.json'))
        for path in paths:
            try:
                with open(path,encoding='utf-8') as source:
                    _tracking_catalog=json.load(source)
                break
            except (OSError,ValueError):
                continue
        if _tracking_catalog is None: _tracking_catalog={}
    return _tracking_catalog

def tracking_url(carrier,number):
    if not carrier or not number: return ''
    normalize=lambda value:' '.join(str(value).casefold().split())
    name=normalize(carrier);catalog=tracking_catalog();matches=[]
    for identifier,details in catalog.items():
        labels=[identifier,details.get('displayName',''),*details.get('aliases',[])]
        if name in {normalize(label) for label in labels if label}:
            matches.append(details)
    if not matches:
        german_ids={'dhl':'dhl','dhl express':'dhl-express','ups':'ups','fedex':'fedex','dpd':'dpd-de','gls':'gls-de','hermes':'hermes-de'}
        details=catalog.get(german_ids.get(name,''),{})
    else:
        templates={details.get('trackingUrlTemplate','') for details in matches}
        details=matches[0] if len(templates)==1 else {}
    template=details.get('trackingUrlTemplate','')
    if not template: return ''
    target=template.replace('{trackingNumber}',quote(str(number).strip(),safe=''))
    parsed=urlsplit(target)
    return target if parsed.scheme=='https' and parsed.netloc else ''

def telegram_notify(message,parse_mode=None):
    token=os.getenv('TELEGRAM_BOT_TOKEN','').strip()
    chat_id=os.getenv('TELEGRAM_CHAT_ID','').strip()
    if not token or not chat_id:
        return False
    try:
        fields={'chat_id':chat_id,'text':message,'disable_web_page_preview':'true'}
        if parse_mode: fields['parse_mode']=parse_mode
        payload=urlencode(fields).encode()
        req=Request(f'https://api.telegram.org/bot{token}/sendMessage',data=payload,method='POST')
        with urlopen(req,timeout=3) as response:
            result=json.loads(response.read(65536))
            if not result.get('ok'):
                logging.warning('Telegram-Benachrichtigung wurde abgelehnt (HTTP %s)',response.status)
                return False
            return True
    except (URLError,HTTPError,TimeoutError,ValueError,OSError):
        logging.warning('Telegram-Benachrichtigung konnte nicht gesendet werden')
        return False

def telegram_order_notification(status,title,supplier,group_name,tracking_number=''):
    german=setting('telegram_language','en')=='de'
    if status=='Warenkorb fertig':
        heading='Warenkorb ist fertig' if german else 'Cart is ready'
        subheading='Bereit zur Bestellung' if german else 'Ready to order'
        icon='🛒'
    else:
        heading='Bestellung abgeholt' if german else 'Order picked up'
        subheading='Die Lieferung wurde angenommen und abgeholt' if german else 'The delivery has been received and collected'
        icon='📦'
    safe_title=html.escape(title or ('Bestellung ohne Bezeichnung' if german else 'Untitled order'))
    safe_supplier=html.escape(supplier or ('Kein Lieferant angegeben' if german else 'No supplier specified'))
    safe_group=html.escape(group_name or ('Keine Gruppe zugewiesen' if german else 'No group assigned'))
    safe_tracking=html.escape(tracking_number or '')
    message=(f"{icon} <b>{heading}</b>\n"
             f"<i>{subheading}</i>\n\n"
             f"<b>{safe_title}</b>\n"
             f"🏪 {safe_supplier}\n"
             f"👥 {safe_group}")
    if safe_tracking:
        message+=f"\n🔎 {'Sendungsnummer' if german else 'Tracking number'}: <code>{safe_tracking}</code>"
    return telegram_notify(message,parse_mode='HTML')

def telegram_registration_notification(display_name,username,role):
    german=setting('telegram_language','en')=='de'
    safe_name=html.escape(display_name or ('Ohne Namen' if german else 'Unnamed user'))
    safe_username=html.escape(username or '')
    role_label=('Extern' if role=='external' else 'Mitarbeiter') if german else ('External' if role=='external' else 'Employee')
    message=(("🆕 <b>Neue Registrierung</b>\n"
              "<i>Prüfung und Freigabe erforderlich</i>\n\n") if german else
             ("🆕 <b>New registration</b>\n"
              "<i>Review and approval required</i>\n\n"))
    message+=(f"👤 <b>{safe_name}</b>\n"
             f"🔑 {'Benutzername' if german else 'Username'}: <code>{safe_username}</code>\n"
             f"🏷 {'Rolle' if german else 'Role'}: {role_label}\n\n"
             + ('⏳ Gruppenzuweisung und Freigabe stehen aus.' if german else '⏳ Group assignment and approval are pending.'))
    return telegram_notify(message,parse_mode='HTML')

def db():
    if 'db' not in g:
        g.db=sqlite3.connect(DB,timeout=15)
        g.db.row_factory=sqlite3.Row
        g.db.execute('PRAGMA foreign_keys=ON')
        g.db.execute('PRAGMA busy_timeout=5000')
    return g.db

@app.teardown_appcontext
def close_db(exc):
    conn=g.pop('db',None)
    if conn: conn.close()

def init():
    os.makedirs('/data',exist_ok=True)
    with app.app_context():
        d=db(); d.execute('PRAGMA journal_mode=WAL')
        d.executescript('''CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
        CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL DEFAULT '', password TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, approved INTEGER NOT NULL DEFAULT 1, group_id INTEGER REFERENCES groups(id), role TEXT NOT NULL DEFAULT 'employee');
        CREATE TABLE IF NOT EXISTS user_groups(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id,group_id));
        CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, title TEXT NOT NULL, supplier TEXT DEFAULT '', order_number TEXT DEFAULT '', tracking_number TEXT DEFAULT '', carrier TEXT DEFAULT '', link TEXT DEFAULT '', notes TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'Warenkorb', created_by INTEGER REFERENCES users(id), group_id INTEGER REFERENCES groups(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, name TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 1, price REAL NOT NULL DEFAULT 0, link TEXT DEFAULT '');
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');''')
        event_columns={row['name'] for row in d.execute('PRAGMA table_info(events)').fetchall()}
        if 'actor_name' not in event_columns:
            d.execute("ALTER TABLE events ADD COLUMN actor_name TEXT NOT NULL DEFAULT ''")
        user_columns={row['name'] for row in d.execute('PRAGMA table_info(users)').fetchall()}
        if 'display_name' not in user_columns:
            d.execute("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
        if 'approved' not in user_columns:
            d.execute('ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1')
        if 'group_id' not in user_columns:
            d.execute('ALTER TABLE users ADD COLUMN group_id INTEGER REFERENCES groups(id)')
        if 'role' not in user_columns:
            d.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'employee'")
        d.execute("UPDATE users SET role='admin' WHERE admin=1")
        d.execute("UPDATE users SET role='external' WHERE role='student'")
        d.execute("UPDATE users SET role='employee' WHERE role IS NULL OR role='' OR role NOT IN ('employee','external','admin')")
        order_columns={row['name'] for row in d.execute('PRAGMA table_info(orders)').fetchall()}
        if 'group_id' not in order_columns:
            d.execute('ALTER TABLE orders ADD COLUMN group_id INTEGER REFERENCES groups(id)')
        for column in ('pickup_collected_by','pickup_destination','pickup_documents_location'):
            if column not in order_columns:
                d.execute(f'ALTER TABLE orders ADD COLUMN {column} TEXT NOT NULL DEFAULT \'\'')
        d.execute("UPDATE users SET display_name=username WHERE display_name=''")
        if not d.execute('SELECT 1 FROM groups LIMIT 1').fetchone():
            d.execute('INSERT INTO groups(name) VALUES(?)',('Standard',))
        default_group=d.execute('SELECT id FROM groups ORDER BY id LIMIT 1').fetchone()['id']
        d.execute('UPDATE users SET group_id=? WHERE group_id IS NULL AND approved=1',(default_group,))
        d.execute('INSERT OR IGNORE INTO user_groups(user_id,group_id) SELECT id,group_id FROM users WHERE group_id IS NOT NULL')
        d.execute('UPDATE orders SET group_id=COALESCE((SELECT group_id FROM users WHERE users.id=orders.created_by),?) WHERE group_id IS NULL',(default_group,))
        if not d.execute('SELECT 1 FROM users LIMIT 1').fetchone():
            username=os.getenv('ADMIN_USERNAME','admin'); display_name=os.getenv('ADMIN_DISPLAY_NAME',username); password=os.environ['ADMIN_PASSWORD']
            cur=d.execute("INSERT INTO users(username,display_name,password,admin,group_id,role) VALUES(?,?,?,1,?,'admin')",(username,display_name,generate_password_hash(password),default_group))
            d.execute('INSERT INTO user_groups(user_id,group_id) VALUES(?,?)',(cur.lastrowid,default_group))
        d.commit()

def now(): return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
def setting(key,default=''):
    row=db().execute('SELECT value FROM settings WHERE key=?',(key,)).fetchone()
    return row['value'] if row else default

def setting_list(key):
    values=[];seen=set()
    for line in setting(key).splitlines():
        value=line.strip()[:200]
        marker=value.casefold()
        if value and value!='__custom__' and marker not in seen:
            values.append(value);seen.add(marker)
    return values[:40]

def pickup_form_value(name,option_key,default=''):
    option=request.form.get(name+'_option','').strip()
    if option=='__custom__':
        value=request.form.get(name+'_custom','')
    elif option:
        values=setting_list(option_key)
        if option not in values: abort(400,'Ungültiger Abholort')
        value=option
    elif name in request.form:
        value=request.form.get(name,default)
    else:
        value=default
    return value.strip()[:500]

def carrier_form_value(default=''):
    option=request.form.get('carrier_option')
    if option is None:
        return request.form.get('carrier',default).strip()[:200]
    if option=='__custom__':
        return request.form.get('carrier_custom','').strip()[:200]
    if option and option not in setting_list('shipping_carriers'):
        abort(400,'Ungültiger Versanddienstleister')
    return option.strip()[:200]

def login_required(fn):
    @wraps(fn)
    def wrapper(*a,**kw):
        if not session.get('uid'): return redirect(url_for('login'))
        u=db().execute('SELECT * FROM users WHERE id=? AND active=1',(session['uid'],)).fetchone()
        if not u: session.clear(); return redirect(url_for('login'))
        g.user=u
        return fn(*a,**kw)
    return wrapper

def admin_required(fn):
    @wraps(fn)
    @login_required
    def wrapper(*a,**kw):
        if not g.user['admin']: abort(403)
        return fn(*a,**kw)
    return wrapper

def order_for_current_user(oid):
    order=db().execute('SELECT o.*,g.name group_name FROM orders o LEFT JOIN groups g ON g.id=o.group_id WHERE o.id=?',(oid,)).fetchone()
    if not order: abort(404)
    if not g.user['admin'] and not db().execute('SELECT 1 FROM user_groups WHERE user_id=? AND group_id=?',(g.user['id'],order['group_id'])).fetchone(): abort(404)
    return order

def available_groups():
    return db().execute('SELECT id,name FROM groups ORDER BY name COLLATE NOCASE').fetchall()

def current_user_groups():
    return db().execute('SELECT g.id,g.name FROM user_groups ug JOIN groups g ON g.id=ug.group_id WHERE ug.user_id=? ORDER BY g.name COLLATE NOCASE',(g.user['id'],)).fetchall()

@app.before_request
def csrf():
    if 'csrf' not in session: session['csrf']=secrets.token_urlsafe(32)
    if request.method=='POST' and not secrets.compare_digest(request.form.get('csrf',''),session['csrf']): abort(400,'Ungültiger CSRF-Token')



def page(template,**kwargs):
    context={'csrf':session['csrf'],'statuses':STATUSES,'pickup_destinations':setting_list('pickup_destinations'),'pickup_document_locations':setting_list('pickup_document_locations'),'shipping_carriers':setting_list('shipping_carriers'),'default_carrier':setting('default_carrier')}
    context.update(kwargs)
    body=render_template(template,**context)
    return render_template('base.html',content=body,csrf=session['csrf'],user=getattr(g,'user',None))

@app.route('/login',methods=['GET','POST'])
def login():
    username=''
    if request.method=='POST':
        username=request.form.get('username','')
        u=db().execute('SELECT * FROM users WHERE username=?',(username,)).fetchone()
        if u and check_password_hash(u['password'],request.form.get('password','')):
            if not u['approved']: flash('Die Registrierung wartet noch auf Freigabe durch einen Administrator')
            elif not u['active']: flash('Dieses Konto ist deaktiviert')
            elif not u['admin'] and not db().execute('SELECT 1 FROM user_groups WHERE user_id=? LIMIT 1',(u['id'],)).fetchone(): flash('Für dieses Konto wurde noch keine Gruppe festgelegt')
            else:
                session.clear();session['uid']=u['id'];session['csrf']=secrets.token_urlsafe(32);session.permanent=request.form.get('remember')=='1'
                return redirect(url_for('index'))
        else: flash('Benutzername oder Passwort falsch')
    return page('login.html',username=username)

@app.route('/register',methods=['GET','POST'])
def register():
    display_name='';username='';role='employee'
    if request.method=='POST':
        display_name=request.form.get('display_name','').strip()[:120]
        username=request.form.get('username','').strip().lower()
        role=request.form.get('role','employee')
        password=request.form.get('password','')
        confirmation=request.form.get('password_confirm','')
        if role not in ('employee','external'):
            flash('Bitte eine gültige Rolle auswählen')
        elif not display_name or not re.fullmatch(r'[a-z0-9._-]{3,80}',username):
            flash('Name erforderlich. Benutzername: 3–80 Zeichen, nur Buchstaben, Zahlen, Punkt, Bindestrich oder Unterstrich.')
        elif len(password)<12:
            flash('Das Passwort muss mindestens 12 Zeichen lang sein')
        elif password!=confirmation:
            flash('Die Passwörter stimmen nicht überein')
        else:
            try:
                db().execute('INSERT INTO users(username,display_name,password,admin,active,approved,role) VALUES(?,?,?,0,0,0,?)',(username,display_name,generate_password_hash(password),role))
                db().commit()
                telegram_registration_notification(display_name.replace('\n',' '),username,role)
                flash('Registrierung erhalten. Nach Freigabe durch einen Administrator ist die Anmeldung möglich.')
                return redirect(url_for('login'))
            except sqlite3.IntegrityError:
                flash('Dieser Benutzername ist bereits vergeben')
    return page('register.html',display_name=display_name,username=username,role=role)

@app.post('/logout')
@login_required
def logout(): session.clear();return redirect(url_for('login'))

@app.route('/')
@login_required
def index():
    status=request.args.get('status','').strip();search=request.args.get('q','').strip()
    current_year=datetime.now(timezone.utc).year
    year=request.args.get('year',str(current_year)).strip()
    if year!='all' and (len(year)!=4 or not year.isdigit()): year=str(current_year)
    year_sql="SELECT DISTINCT substr(created_at,1,4) year FROM orders WHERE created_at GLOB '[0-9][0-9][0-9][0-9]*'"
    year_args=[]
    if not g.user['admin']: year_sql+=' AND group_id IN (SELECT group_id FROM user_groups WHERE user_id=?)';year_args.append(g.user['id'])
    years=sorted({current_year,*[int(r['year']) for r in db().execute(year_sql,year_args).fetchall()]},reverse=True)
    sql="SELECT o.*,COALESCE(NULLIF(u.display_name,''),u.username) creator,(SELECT COUNT(*) FROM items i WHERE i.order_id=o.id) item_count,(SELECT e.created_at FROM events e WHERE e.order_id=o.id AND (e.action LIKE '%→ Bestellt' OR e.action='Bestellung angelegt (Bestellt)') ORDER BY e.id DESC LIMIT 1) ordered_at,(SELECT e.created_at FROM events e WHERE e.order_id=o.id AND (e.action LIKE '%→ Angekommen' OR e.action='Bestellung angelegt (Angekommen)') ORDER BY e.id DESC LIMIT 1) arrived_at FROM orders o LEFT JOIN users u ON u.id=o.created_by"
    args=[]
    if not g.user['admin']: sql+=' WHERE o.group_id IN (SELECT group_id FROM user_groups WHERE user_id=?)';args.append(g.user['id'])
    rows=[dict(row) for row in db().execute(sql+' ORDER BY o.updated_at DESC,o.id DESC',args).fetchall()]
    for row in rows: row['tracking_url']=tracking_url(row.get('carrier'),row.get('tracking_number'))
    count_sql='SELECT status,COUNT(*) n FROM orders'
    count_args=[]
    if not g.user['admin']: count_sql+=' WHERE group_id IN (SELECT group_id FROM user_groups WHERE user_id=?)';count_args.append(g.user['id'])
    counts={r['status']:r['n'] for r in db().execute(count_sql+' GROUP BY status',count_args)}
    return page('index.html',rows=rows,counts=counts,status=status,search=search,year=year,years=years,user=g.user)

def order_form(o=None):
    groups=available_groups() if g.user['admin'] else current_user_groups()
    group_id=o['group_id'] if o else (groups[0]['id'] if len(groups)==1 else None)
    group_name=next((group['name'] for group in groups if group['id']==group_id),'')
    return page('order_form.html',o=o,groups=groups,group_id=group_id,group_name=group_name,can_choose_group=g.user['admin'] or len(groups)>1,default_supplier=setting('default_supplier'),default_carrier=setting('default_carrier'))

def save_order(oid=None):
    title=request.form.get('title','').strip()[:200]; status=request.form.get('status','Warenkorb')
    clear_pickup=request.form.get('clear_pickup')=='1'
    if clear_pickup: status='Angekommen'
    if not title or status not in STATUSES: abort(400)
    vals=[request.form.get(k,'').strip()[:2000] for k in ('supplier','order_number','tracking_number')]
    vals.extend((carrier_form_value(),request.form.get('link','').strip()[:2000],request.form.get('notes','').strip()[:2000]))
    if not vals[0]: abort(400,'Lieferant / Shop erforderlich')
    if vals[4] and not vals[4].startswith(('http://','https://')): abort(400,'Link muss mit http(s) beginnen')
    if g.user['admin'] or request.form.get('group_id'):
        try: group_id=int(request.form.get('group_id',''))
        except ValueError: abort(400,'Gruppe erforderlich')
        if g.user['admin']:
            if not db().execute('SELECT 1 FROM groups WHERE id=?',(group_id,)).fetchone(): abort(400,'Ungültige Gruppe')
        elif not db().execute('SELECT 1 FROM user_groups WHERE user_id=? AND group_id=?',(g.user['id'],group_id)).fetchone(): abort(403,'Diese Gruppe ist dem Konto nicht zugewiesen')
    else:
        user_groups=current_user_groups()
        if len(user_groups)!=1: abort(400,'Bitte eine Gruppe auswählen')
        group_id=user_groups[0]['id']
    d=db();t=now();previous_status=None
    if oid:
        old=d.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone()
        if not old: abort(404)
        previous_status=old['status']
        if status=='Abgeholt' and previous_status!='Abgeholt':
            abort(400,'Bitte die Abholung über den Abholschritt dokumentieren')
        pickup_collected_by='' if clear_pickup else request.form.get('pickup_collected_by',old['pickup_collected_by'] or '').strip()[:200]
        pickup_destination='' if clear_pickup else pickup_form_value('pickup_destination','pickup_destinations',old['pickup_destination'] or '')
        pickup_documents_location='' if clear_pickup else pickup_form_value('pickup_documents_location','pickup_document_locations',old['pickup_documents_location'] or '')
        if not clear_pickup and (status=='Abgeholt' or previous_status=='Abgeholt' or any((pickup_collected_by,pickup_destination,pickup_documents_location))) and not all((pickup_collected_by,pickup_destination,pickup_documents_location)):
            abort(400,'Bitte alle Abholangaben ausfüllen')
        d.execute('UPDATE orders SET title=?,supplier=?,order_number=?,tracking_number=?,carrier=?,link=?,notes=?,status=?,group_id=?,pickup_collected_by=?,pickup_destination=?,pickup_documents_location=?,updated_at=? WHERE id=?',(title,*vals,status,group_id,pickup_collected_by,pickup_destination,pickup_documents_location,t,oid))
        if clear_pickup:
            d.execute("UPDATE events SET actor_name='' WHERE id=(SELECT id FROM events WHERE order_id=? AND action LIKE '%→ Abgeholt' ORDER BY id DESC LIMIT 1)",(oid,))
        elif previous_status=='Abgeholt' and pickup_collected_by!=(old['pickup_collected_by'] or ''):
            d.execute("UPDATE events SET actor_name=? WHERE id=(SELECT id FROM events WHERE order_id=? AND action LIKE '%→ Abgeholt' ORDER BY id DESC LIMIT 1)",(pickup_collected_by,oid))
        action='Status: '+old['status']+' → '+status if old['status']!=status else 'Bestellung bearbeitet'
    else:
        if status=='Abgeholt': abort(400,'Neue Bestellungen können nicht direkt als abgeholt angelegt werden')
        cur=d.execute('INSERT INTO orders(title,supplier,order_number,tracking_number,carrier,link,notes,status,created_by,group_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(title,*vals,status,g.user['id'],group_id,t,t));oid=cur.lastrowid;action='Bestellung angelegt ('+status+')'
    d.execute('INSERT INTO events(order_id,user_id,action,created_at) VALUES(?,?,?,?)',(oid,g.user['id'],action,t));d.commit()
    if status!=previous_status and status in ('Warenkorb fertig','Abgeholt'):
        group=d.execute('SELECT name FROM groups WHERE id=?',(group_id,)).fetchone()
        telegram_order_notification(status,title,vals[0],group['name'] if group else '',vals[2])
    return redirect(url_for('detail',oid=oid))

@app.route('/new',methods=['GET','POST'])
@login_required
def new_order(): return save_order() if request.method=='POST' else order_form()

@app.route('/order/<int:oid>/edit',methods=['GET','POST'])
@login_required
def edit_order(oid):
    o=order_for_current_user(oid)
    return save_order(oid) if request.method=='POST' else order_form(o)

@app.route('/order/<int:oid>')
@login_required
def detail(oid):
    d=db();o=order_for_current_user(oid)
    items=d.execute('SELECT * FROM items WHERE order_id=? ORDER BY id',(oid,)).fetchall()
    events=d.execute("SELECT e.*,COALESCE(NULLIF(e.actor_name,''),CASE WHEN e.action LIKE '%→ Abgeholt' THEN NULLIF(o.pickup_collected_by,'') END,NULLIF(u.display_name,''),u.username) username FROM events e JOIN orders o ON o.id=e.order_id LEFT JOIN users u ON u.id=e.user_id WHERE e.order_id=? ORDER BY e.id DESC",(oid,)).fetchall()
    dates=d.execute("SELECT (SELECT e.created_at FROM events e WHERE e.order_id=? AND (e.action LIKE '%→ Bestellt' OR e.action='Bestellung angelegt (Bestellt)') ORDER BY e.id DESC LIMIT 1) ordered_at,(SELECT e.created_at FROM events e WHERE e.order_id=? AND (e.action LIKE '%→ Angekommen' OR e.action='Bestellung angelegt (Angekommen)') ORDER BY e.id DESC LIMIT 1) arrived_at",(oid,oid)).fetchone()
    total=sum(i['quantity']*i['price'] for i in items)
    return page('order_detail.html',o=o,items=items,events=events,total=total,oid=oid,user=g.user,ordered_at=dates['ordered_at'],arrived_at=dates['arrived_at'],tracking_url=tracking_url(o['carrier'],o['tracking_number']))

@app.post('/order/<int:oid>/status')
@login_required
def change_status(oid):
    d=db();o=order_for_current_user(oid)
    s=request.form.get('status')
    if s not in STATUSES: abort(400)
    if s!=o['status']:
        t=now();tracking=request.form.get('tracking_number')
        if s=='Abgeholt':
            collected_by=request.form.get('pickup_collected_by','').strip()[:200]
            destination=pickup_form_value('pickup_destination','pickup_destinations')
            documents_location=pickup_form_value('pickup_documents_location','pickup_document_locations')
            if not collected_by or not destination or not documents_location:
                abort(400,'Bitte alle Abholangaben ausfüllen')
            d.execute('UPDATE orders SET status=?,pickup_collected_by=?,pickup_destination=?,pickup_documents_location=?,updated_at=? WHERE id=?',(s,collected_by,destination,documents_location,t,oid))
        elif tracking is not None and s=='Unterwegs':
            tracking=tracking.strip()[:2000];carrier=carrier_form_value(o['carrier'] or '')
            if not tracking: abort(400,'Sendungsnummer erforderlich')
            d.execute('UPDATE orders SET status=?,tracking_number=?,carrier=?,updated_at=? WHERE id=?',(s,tracking,carrier,t,oid))
        else:
            d.execute('UPDATE orders SET status=?,updated_at=? WHERE id=?',(s,t,oid))
        event_actor=collected_by if s=='Abgeholt' else ''
        d.execute('INSERT INTO events(order_id,user_id,action,actor_name,created_at) VALUES(?,?,?,?,?)',(oid,g.user['id'],'Status: '+o['status']+' → '+s,event_actor,t));d.commit()
        if s in ('Warenkorb fertig','Abgeholt'):
            telegram_order_notification(s,o['title'],o['supplier'],o['group_name'],o['tracking_number'])
    target=request.form.get('return_to','')
    parsed=urlsplit(target)
    allowed_paths={'/',url_for('detail',oid=oid)}
    if not parsed.scheme and not parsed.netloc and parsed.path in allowed_paths:
        return redirect(target)
    return redirect(url_for('detail',oid=oid))

@app.post('/order/<int:oid>/item')
@login_required
def add_item(oid):
    d=db()
    order_for_current_user(oid)
    name=request.form.get('name','').strip()[:200];link=request.form.get('link','').strip()[:2000]
    try: quantity=float(request.form.get('quantity','1'));price=float(request.form.get('price','0'))
    except ValueError: abort(400)
    if not name or not quantity.is_integer() or not 1<=quantity<=1000000 or not 0<=price<=100000000 or (link and not link.startswith(('http://','https://'))): abort(400)
    d.execute('INSERT INTO items(order_id,name,quantity,price,link) VALUES(?,?,?,?,?)',(oid,name,quantity,price,link));d.execute('INSERT INTO events(order_id,user_id,action,created_at) VALUES(?,?,?,?)',(oid,g.user['id'],'Artikel hinzugefügt: '+name,now()));d.commit()
    return redirect(url_for('detail',oid=oid))

@app.post('/order/<int:oid>/items/import')
@login_required
def import_items(oid):
    d=db()
    order_for_current_user(oid)
    upload=request.files.get('workbook')
    if not upload or not upload.filename:
        flash('Bitte eine Mouser-XLS-Datei auswählen')
        return redirect(url_for('detail',oid=oid))
    if not upload.filename.lower().endswith('.xls'):
        flash('Bitte eine Excel-Datei im XLS-Format hochladen')
        return redirect(url_for('detail',oid=oid))
    contents=upload.stream.read(10*1024*1024+1)
    if len(contents)>10*1024*1024:
        flash('Die Datei ist zu groß (maximal 10 MB)')
        return redirect(url_for('detail',oid=oid))
    try:
        items=parse_mouser_xls(contents)
    except ImportFormatError as exc:
        flash('Import fehlgeschlagen: '+str(exc))
        return redirect(url_for('detail',oid=oid))
    t=now()
    d.executemany('INSERT INTO items(order_id,name,quantity,price,link) VALUES(?,?,?,?,?)',((oid,name,quantity,price,link) for name,quantity,price,link in items))
    d.execute('INSERT INTO events(order_id,user_id,action,created_at) VALUES(?,?,?,?)',(oid,g.user['id'],f'{len(items)} Artikel aus Mouser-XLS importiert',t))
    d.commit()
    flash(f'{len(items)} Artikel aus der XLS-Datei übernommen')
    return redirect(url_for('detail',oid=oid))

@app.post('/order/<int:oid>/item/<int:iid>/delete')
@login_required
def delete_item(oid,iid):
    d=db();order_for_current_user(oid);i=d.execute('SELECT name FROM items WHERE id=? AND order_id=?',(iid,oid)).fetchone()
    if not i: abort(404)
    d.execute('DELETE FROM items WHERE id=?',(iid,));d.execute('INSERT INTO events(order_id,user_id,action,created_at) VALUES(?,?,?,?)',(oid,g.user['id'],'Artikel entfernt: '+i['name'],now()));d.commit()
    return redirect(url_for('detail',oid=oid))

@app.post('/order/<int:oid>/delete')
@admin_required
def delete_order(oid):
    db().execute('DELETE FROM orders WHERE id=?',(oid,));db().commit();flash('Bestellung gelöscht');return redirect(url_for('index'))

@app.route('/users',methods=['GET','POST'])
@admin_required
def users():
    if request.method=='POST':
        name=request.form.get('username','').strip();display_name=request.form.get('display_name','').strip();pwd=request.form.get('password','')
        try: group_ids=list(dict.fromkeys(int(value) for value in request.form.getlist('group_ids')))
        except ValueError: group_ids=[]
        if not name or len(name)>80 or not display_name or len(display_name)>120 or len(pwd)<12: flash('Benutzername und Name erforderlich; Passwort mindestens 12 Zeichen')
        elif not group_ids or len(group_ids)!=len(db().execute('SELECT id FROM groups WHERE id IN ('+','.join('?' for _ in group_ids)+')',group_ids).fetchall()): flash('Bitte mindestens eine gültige Gruppe auswählen')
        else:
            try:
                role=request.form.get('role','employee')
                if role not in ('employee','external','admin'): abort(400)
                cur=db().execute('INSERT INTO users(username,display_name,password,admin,group_id,role) VALUES(?,?,?,?,?,?)',(name,display_name,generate_password_hash(pwd),int(role=='admin'),group_ids[0],role))
                db().executemany('INSERT INTO user_groups(user_id,group_id) VALUES(?,?)',((cur.lastrowid,group_id) for group_id in group_ids));db().commit();flash('Benutzer angelegt')
            except sqlite3.IntegrityError: flash('Benutzername existiert bereits')
    rows=db().execute('SELECT u.id,u.username,u.display_name,u.admin,u.role,u.active,u.approved,u.group_id,group_concat(g.name, \' · \') group_names FROM users u LEFT JOIN user_groups ug ON ug.user_id=u.id LEFT JOIN groups g ON g.id=ug.group_id GROUP BY u.id ORDER BY u.approved,u.display_name,u.username').fetchall()
    user_group_ids={row['id']:{item['group_id'] for item in db().execute('SELECT group_id FROM user_groups WHERE user_id=?',(row['id'],)).fetchall()} for row in rows}
    pending_count=sum(1 for row in rows if not row['approved'])
    return page('users.html',rows=rows,me=g.user['id'],pending_count=pending_count,groups=available_groups(),user_group_ids=user_group_ids)

@app.route('/groups',methods=['GET','POST'])
@admin_required
def groups():
    d=db()
    if request.method=='POST':
        name=request.form.get('name','').strip()[:100]
        if not name: flash('Gruppenname erforderlich')
        else:
            try: d.execute('INSERT INTO groups(name) VALUES(?)',(name,));d.commit();flash('Gruppe angelegt')
            except sqlite3.IntegrityError: flash('Eine Gruppe mit diesem Namen existiert bereits')
    rows=d.execute('SELECT g.id,g.name,COUNT(DISTINCT ug.user_id) members,(SELECT COUNT(*) FROM orders o WHERE o.group_id=g.id) orders FROM groups g LEFT JOIN user_groups ug ON ug.group_id=g.id GROUP BY g.id ORDER BY g.name COLLATE NOCASE').fetchall()
    return page('groups.html',groups=rows)

@app.post('/groups/<int:gid>/delete')
@admin_required
def delete_group(gid):
    d=db()
    group=d.execute('SELECT id,name FROM groups WHERE id=?',(gid,)).fetchone()
    if not group: abort(404)
    if d.execute('SELECT COUNT(*) FROM groups').fetchone()[0]<=1:
        flash('Die letzte Gruppe kann nicht gelöscht werden')
        return redirect(url_for('groups'))
    members=d.execute('SELECT COUNT(DISTINCT user_id) FROM user_groups WHERE group_id=?',(gid,)).fetchone()[0]
    legacy_members=d.execute('SELECT COUNT(*) FROM users WHERE group_id=?',(gid,)).fetchone()[0]
    orders=d.execute('SELECT COUNT(*) FROM orders WHERE group_id=?',(gid,)).fetchone()[0]
    if members or legacy_members or orders:
        flash(f"Gruppe „{group['name']}“ kann noch nicht gelöscht werden: erst {members or legacy_members} Mitarbeiter und {orders} Bestellungen anderen Gruppen zuweisen.")
        return redirect(url_for('groups'))
    d.execute('DELETE FROM groups WHERE id=?',(gid,));d.commit()
    flash(f"Gruppe „{group['name']}“ gelöscht")
    return redirect(url_for('groups'))

@app.post('/users/<int:uid>/group')
@admin_required
def assign_user_group(uid):
    try: group_ids=list(dict.fromkeys(int(value) for value in request.form.getlist('group_ids')))
    except ValueError: abort(400)
    d=db()
    target=d.execute('SELECT id,approved,active FROM users WHERE id=?',(uid,)).fetchone()
    if not target: abort(404)
    if target['approved'] and target['active'] and not group_ids:
        flash('Aktiven Mitarbeiterinnen und Mitarbeitern muss mindestens eine Gruppe zugewiesen sein')
        return redirect(url_for('users'))
    if group_ids:
        valid=d.execute('SELECT id FROM groups WHERE id IN ('+','.join('?' for _ in group_ids)+')',group_ids).fetchall()
        if len(valid)!=len(group_ids): abort(400)
    d.execute('DELETE FROM user_groups WHERE user_id=?',(uid,))
    d.executemany('INSERT INTO user_groups(user_id,group_id) VALUES(?,?)',((uid,group_id) for group_id in group_ids))
    d.execute('UPDATE users SET group_id=? WHERE id=?',(group_ids[0] if group_ids else None,uid));d.commit()
    flash('Gruppenzugehörigkeiten aktualisiert')
    return redirect(url_for('users'))

@app.post('/users/<int:uid>/toggle')
@admin_required
def toggle_user(uid):
    if uid==g.user['id']: abort(400)
    d=db();d.execute('UPDATE users SET active=1-active WHERE id=? AND approved=1',(uid,));d.commit();return redirect(url_for('users'))

@app.post('/users/<int:uid>/approve')
@admin_required
def approve_user(uid):
    d=db()
    if not d.execute('SELECT id FROM users WHERE id=?',(uid,)).fetchone(): abort(404)
    if not d.execute('SELECT 1 FROM user_groups WHERE user_id=? LIMIT 1',(uid,)).fetchone():
        flash('Vor der Freigabe muss eine Gruppe zugewiesen werden')
        return redirect(url_for('users'))
    cur=d.execute('UPDATE users SET approved=1,active=1 WHERE id=? AND approved=0',(uid,))
    if not cur.rowcount: abort(404)
    d.commit();flash('Mitarbeiterkonto freigeschaltet');return redirect(url_for('users'))

@app.post('/users/<int:uid>/delete')
@admin_required
def delete_user(uid):
    if uid==g.user['id']: abort(400)
    d=db();target=d.execute('SELECT id,admin,active FROM users WHERE id=?',(uid,)).fetchone()
    if not target: abort(404)
    if target['admin'] and target['active'] and d.execute('SELECT COUNT(*) FROM users WHERE admin=1 AND active=1').fetchone()[0]<=1:
        flash('Der letzte aktive Administrator kann nicht gelöscht werden')
        return redirect(url_for('users'))
    d.execute('UPDATE orders SET created_by=NULL WHERE created_by=?',(uid,))
    d.execute('UPDATE events SET user_id=NULL WHERE user_id=?',(uid,))
    d.execute('DELETE FROM users WHERE id=?',(uid,));d.commit()
    flash('Mitarbeiterkonto gelöscht')
    return redirect(url_for('users'))

@app.route('/settings',methods=['GET','POST'])
@admin_required
def settings():
    d=db()
    if request.method=='POST':
        if 'default_supplier' in request.form or 'default_carrier' in request.form:
            supplier=request.form.get('default_supplier','').strip()[:200]
            carrier=request.form.get('default_carrier','').strip()[:200]
            for key,value in (('default_supplier',supplier),('default_carrier',carrier)):
                d.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,value))
        telegram_language=request.form.get('telegram_language')
        if telegram_language:
            if telegram_language not in ('de','en'): abort(400)
            d.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',('telegram_language',telegram_language))
        d.commit();flash('Einstellungen gespeichert');return redirect(url_for('settings'))
    return page('settings.html',default_supplier=setting('default_supplier'),default_carrier=setting('default_carrier'),telegram_language=setting('telegram_language','en'),telegram_configured=bool(os.getenv('TELEGRAM_BOT_TOKEN','').strip() and os.getenv('TELEGRAM_CHAT_ID','').strip()))

@app.post('/settings/delete-orders')
@admin_required
def delete_all_orders():
    d=db()
    d.execute('DELETE FROM orders')
    d.commit()
    flash('Alle Bestellungen und deren Verlauf wurden gelöscht')
    return redirect(url_for('settings'))

@app.route('/settings/pickup-dropdowns',methods=['GET','POST'])
@admin_required
def pickup_dropdowns():
    d=db()
    if request.method=='POST':
        for key in ('pickup_destinations','pickup_document_locations'):
            values=[];seen=set()
            for line in request.form.get(key,'').splitlines():
                value=line.strip()[:200]
                marker=value.casefold()
                if value and value!='__custom__' and marker not in seen:
                    values.append(value);seen.add(marker)
            d.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,'\n'.join(values[:40])))
        d.commit();flash('Abholdropdowns gespeichert');return redirect(url_for('pickup_dropdowns'))
    return page('pickup_dropdowns.html',pickup_destinations_text=setting('pickup_destinations'),pickup_document_locations_text=setting('pickup_document_locations'))

@app.route('/settings/shipping-carriers',methods=['GET','POST'])
@admin_required
def shipping_carriers():
    if request.method=='POST':
        values=[];seen=set()
        for line in request.form.get('shipping_carriers','').splitlines():
            value=line.strip()[:200]
            marker=value.casefold()
            if value and value!='__custom__' and marker not in seen:
                values.append(value);seen.add(marker)
        d=db();d.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',('shipping_carriers','\n'.join(values[:40])));d.commit()
        flash('Versanddienstleister gespeichert');return redirect(url_for('shipping_carriers'))
    return page('shipping_carriers.html',shipping_carriers_text=setting('shipping_carriers'))

@app.post('/settings/telegram-test')
@admin_required
def telegram_test():
    german=setting('telegram_language','en')=='de'
    sample=('Beispielbestellung','Beispiel-Shop','Beispielgruppe') if german else ('Sample order','Sample shop','Sample group')
    if telegram_order_notification('Warenkorb fertig',*sample,'00340434123456789012'):
        flash('Testnachricht wurde an den konfigurierten Telegram-Chat gesendet')
    else:
        flash('Telegram-Test fehlgeschlagen. TELEGRAM_BOT_TOKEN und TELEGRAM_CHAT_ID prüfen; der Server muss api.telegram.org erreichen können.')
    return redirect(url_for('settings'))

@app.route('/password',methods=['GET','POST'])
@login_required
def password():
    if request.method=='POST':
        if not check_password_hash(g.user['password'],request.form.get('old','')): flash('Altes Passwort falsch')
        elif len(request.form.get('new',''))<12: flash('Neues Passwort muss mindestens 12 Zeichen haben')
        else: db().execute('UPDATE users SET password=? WHERE id=?',(generate_password_hash(request.form['new']),g.user['id']));db().commit();flash('Passwort geändert');return redirect(url_for('index'))
    return page('password.html')

init()
if __name__=='__main__': app.run(host='0.0.0.0',port=8000)
