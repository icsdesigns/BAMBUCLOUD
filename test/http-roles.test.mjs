/**
 * Recorrido HTTP completo de los roles contra el servidor de verdad: arranca
 * server.js como proceso aparte, sin cuenta de Bambu, y hace de navegadores
 * con su propio tarro de cookies.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const CODE = '7777';
let proc;
let dir;
/** El navegador del primer administrador; los tests siguientes lo reutilizan. */
let owner = null;

class Browser {
  constructor() { this.jar = new Map(); }
  async req(method, url, body) {
    const res = await fetch(BASE + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const val = pair.slice(eq + 1);
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(name);
      else this.jar.set(name, val);
    }
    let json = null;
    try { json = await res.json(); } catch { /* sin cuerpo */ }
    return { status: res.status, json };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
  del(u) { return this.req('DELETE', u); }
}

async function login() {
  const b = new Browser();
  const r = await b.post('/api/login', { password: 'pw' });
  assert.equal(r.status, 200);
  return b;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambu-e2e-'));
  const keys = webpush.generateVAPIDKeys();
  proc = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      STATE_FILE: path.join(dir, 'state.json'),
      TOKEN_FILE: path.join(dir, 'token.json'),
      DASHBOARD_PASSWORD: 'pw',
      ADMIN_CODE: CODE,
      ADMIN_MAX: '2',
      SESSION_SECRET: 'test-secret',
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      BAMBU_EMAIL: '', BAMBU_PASSWORD: '', BAMBU_TOKEN: '',
      NODE_ENV: 'test',
      HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  proc.log = () => log;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/api/session`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`el servidor no arranco:\n${log}`);
});

after(() => { proc?.kill('SIGTERM'); });

test('sin sesion no hay nada: ni estado de admin ni ayuda', async () => {
  const anon = new Browser();
  assert.equal((await anon.get('/api/admin/status')).status, 401);
  assert.equal((await anon.post('/api/admin/help', { choice: 'yes' })).status, 401);
});

test('un usuario estandar no puede contestar la ayuda ni con el codigo', async () => {
  const user = await login();
  assert.equal((await user.post('/api/admin/help', { choice: 'yes' })).status, 403);
  const unlock = await user.post('/api/admin/unlock', { code: CODE });
  assert.equal(unlock.status, 200, 'sin admins aun, el codigo desbloquea el panel');
  assert.equal((await user.post('/api/admin/help', { choice: 'yes' })).status, 403,
    'el codigo abre el panel, pero no es el rol');
});

test('alta del primer admin, su cookie es httpOnly y el rol sobrevive a relogin', async () => {
  const phone = await login();
  owner = phone;
  assert.equal((await phone.post('/api/admin/enroll', {})).status, 403, 'hay que desbloquear antes');
  assert.equal((await phone.post('/api/admin/unlock', { code: 'mal' })).status, 401);
  assert.equal((await phone.post('/api/admin/unlock', { code: CODE })).status, 200);
  const enrolled = await phone.post('/api/admin/enroll', { label: 'Movil de Ivan' });
  assert.equal(enrolled.status, 200);
  assert.ok(phone.jar.has('bambu.adm'));

  const st = await phone.get('/api/admin/status');
  assert.equal(st.json.isAdmin, true);
  assert.equal(st.json.rolesActive, true);
  assert.equal(st.json.admins.length, 1);
  assert.equal(JSON.stringify(st.json).includes('hash'), false);

  // El testigo nunca va en claro en el estado del servidor.
  const disk = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  assert.equal(disk.includes(phone.jar.get('bambu.adm').split('.').pop()), false);

  // El rol es la cookie, no la sesion: otra sesion con la misma cookie sigue siendo admin.
  const again = await login();
  again.jar.set('bambu.adm', phone.jar.get('bambu.adm'));
  assert.equal((await again.get('/api/admin/status')).json.isAdmin, true);
});

test('con un admin dado de alta, el codigo ya no basta: hace falta invitacion', async () => {
  const thief = await login();
  const r = await thief.post('/api/admin/unlock', { code: CODE });
  assert.equal(r.status, 403);
  assert.equal(r.json.needsInvite, true);
  assert.equal((await thief.post('/api/admin/enroll', {})).status, 403);
  assert.equal((await thief.get('/api/admin/devices')).status, 403, 'tampoco abre el panel');
});

test('invitacion: la genera un admin, se usa una vez y da de alta al segundo', async () => {
  const inv = await owner.post('/api/admin/invite');
  assert.equal(inv.status, 200);
  assert.match(inv.json.code, /^\d{8}$/);

  const second = await login();
  assert.equal((await second.post('/api/admin/unlock', { code: CODE, invite: '00000000' })).status, 403);
  assert.equal((await second.post('/api/admin/unlock', { code: CODE, invite: inv.json.code })).status, 200);
  assert.equal((await second.post('/api/admin/enroll', { label: 'Tablet' })).status, 200);
  assert.equal((await second.get('/api/admin/status')).json.isAdmin, true);

  // La invitacion ya esta gastada.
  const third = await login();
  assert.equal((await third.post('/api/admin/unlock', { code: CODE, invite: inv.json.code })).status, 403);

  // Tope ADMIN_MAX=2: un tercero no entra aunque tenga invitacion.
  const inv2 = await owner.post('/api/admin/invite');
  assert.equal((await third.post('/api/admin/unlock', { code: CODE, invite: inv2.json.code })).status, 200);
  const full = await third.post('/api/admin/enroll', {});
  assert.equal(full.status, 409);
});

test('ayuda: respuestas del admin, su estado visible para todos y el aviso en el historial', async () => {
  const user = await login();

  assert.equal((await user.get('/api/help')).json.active, false);
  assert.equal((await owner.post('/api/admin/help', { choice: 'x' })).status, 400);
  assert.equal((await owner.post('/api/admin/help', { choice: 'yes', askId: 'nope' })).status, 404);

  const yes = await owner.post('/api/admin/help', { choice: 'yes12' });
  assert.equal(yes.status, 200);
  assert.equal(yes.json.help.mode, 'until');
  assert.equal((await user.get('/api/help')).json.active, true);
  assert.equal((await user.get('/api/help')).json.ask, null, 'un usuario nunca ve la pregunta');

  const state = await user.get('/api/state');
  const call = state.json.notifications.find((n) => n.type === 'help');
  assert.ok(call, 'el aviso inmediato queda en el historial');
  assert.match(call.text, /Necesitaré tu ayuda con las siguientes impresiones/);
  assert.equal(call.audience, 'standard');
  assert.equal(state.json.help.active, true);

  const no = await owner.post('/api/admin/help', { choice: 'no' });
  assert.equal(no.json.help.active, false);
});

test('revocar: el admin deja de serlo al instante y la cookie no vale', async () => {
  const st = await owner.get('/api/admin/status');
  const kid = st.json.me;
  const r = await owner.del(`/api/admin/admins/${kid}`);
  assert.equal(r.status, 200);
  assert.equal((await owner.get('/api/admin/status')).json.isAdmin, false);
  assert.equal((await owner.post('/api/admin/help', { choice: 'yes' })).status, 403);
});
