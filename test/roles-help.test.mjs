import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';

import { Store } from '../src/store.js';
import { AdminRegistry, ADMIN_COOKIE } from '../src/roles.js';
import { HelpWindow, connectHelp, askPayload, HELP_CALL_TEXT, ASK_TTL_MS } from '../src/help.js';
import { PushHub } from '../src/push.js';
import { Notifier } from '../src/notifier.js';
import { JobCycle } from '../src/job-cycle.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambu-test-'));
  return { file: path.join(dir, 'state.json'), dir };
}

function fakeSub(n) {
  return {
    endpoint: `https://push.example/${n}`,
    keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
  };
}

// ---------------------------------------------------------------------------
// AdminRegistry
// ---------------------------------------------------------------------------

test('roles: el testigo solo se entrega una vez y el JSON no lo contiene', () => {
  const { file } = tmpStore();
  const store = new Store(file, {});
  const reg = new AdminRegistry({ code: '9999', store });
  const r = reg.enroll({ label: 'Movil' });
  assert.ok(r.ok && r.token.includes('.'));
  assert.equal(reg.verify(r.token).kid, r.kid);
  store.flush();
  const disk = fs.readFileSync(file, 'utf8');
  const secret = r.token.split('.')[1];
  assert.ok(!disk.includes(secret), 'el secreto no puede estar en claro en disco');
  assert.ok(!disk.includes('9999'), 'el codigo no puede estar en claro en disco');
  assert.equal(JSON.stringify(reg.list()).includes('hash'), false);
});

test('roles: testigos falsos, mutados o de otro kid no validan', () => {
  const store = new Store(tmpStore().file, {});
  const reg = new AdminRegistry({ code: '1234', store });
  const { token, kid } = reg.enroll({});
  assert.equal(reg.verify(null), null);
  assert.equal(reg.verify('x'), null);
  assert.equal(reg.verify(`${kid}.zzzz`), null);
  assert.equal(reg.verify(`${kid}.${token.split('.')[1]}x`), null);
  assert.equal(reg.verify(`otro.${token.split('.')[1]}`), null);
});

test('roles: cambiar ADMIN_CODE revoca a todos los administradores', () => {
  const { file } = tmpStore();
  let store = new Store(file, {});
  let reg = new AdminRegistry({ code: 'uno', store });
  const { token } = reg.enroll({});
  store.flush();
  assert.equal(reg.active, true);

  store = new Store(file, {});
  reg = new AdminRegistry({ code: 'uno', store });
  assert.ok(reg.verify(token), 'mismo codigo: sigue valiendo tras reiniciar');

  store = new Store(file, {});
  reg = new AdminRegistry({ code: 'dos', store });
  assert.equal(reg.verify(token), null);
  assert.equal(reg.active, false);
});

test('roles: tope de administradores y revocacion', () => {
  const store = new Store(tmpStore().file, {});
  const reg = new AdminRegistry({ code: 'c', store, max: 2 });
  const a = reg.enroll({});
  reg.enroll({});
  assert.equal(reg.enroll({}).ok, false);
  assert.equal(reg.revoke(a.kid), true);
  assert.equal(reg.verify(a.token), null);
  assert.equal(reg.enroll({}).ok, true);
  assert.equal(reg.revoke('nope'), false);
});

test('roles: checkCode y la invitacion de un solo uso que caduca', () => {
  const store = new Store(tmpStore().file, {});
  const reg = new AdminRegistry({ code: '4321', store });
  assert.equal(reg.checkCode('4321'), true);
  assert.equal(reg.checkCode('4322'), false);
  assert.equal(reg.checkCode(''), false);

  const inv = reg.createInvite();
  assert.match(inv.code, /^\d{8}$/);
  assert.equal(reg.consumeInvite('00000000'), false);
  assert.equal(reg.consumeInvite(inv.code), true);
  assert.equal(reg.consumeInvite(inv.code), false, 'un solo uso');

  const inv2 = reg.createInvite();
  reg.invite.expires = Date.now() - 1;
  assert.equal(reg.consumeInvite(inv2.code), false, 'caducada');
});

test('roles: la cookie de la peticion se lee y valida', () => {
  const store = new Store(tmpStore().file, {});
  const reg = new AdminRegistry({ code: 'c', store });
  const { token, kid } = reg.enroll({});
  const req = { headers: { cookie: `a=1; ${ADMIN_COOKIE}=${encodeURIComponent(token)}; b=2` } };
  assert.equal(reg.fromRequest(req).kid, kid);
  assert.equal(reg.fromRequest({ headers: {} }), null);
  assert.equal(reg.fromRequest({ headers: { cookie: `${ADMIN_COOKIE}=basura` } }), null);
});

// ---------------------------------------------------------------------------
// HelpWindow
// ---------------------------------------------------------------------------

function makeHelp({ withAdmin = true } = {}) {
  const store = new Store(tmpStore().file, {});
  const admins = new AdminRegistry({ code: 'c', store });
  if (withAdmin) admins.enroll({});
  return { store, admins, help: new HelpWindow({ store, admins }) };
}

test('ayuda: sin administradores todo llega a todos, como antes', () => {
  const { help } = makeHelp({ withAdmin: false });
  assert.equal(help.audienceFor('ready'), 'all');
  assert.equal(help.audienceFor('started'), 'all');
  assert.equal(help.ask({ jobName: 'x' }), null, 'no hay a quien preguntar');
});

test('ayuda: con administradores, los usuarios no reciben nada salvo avisos operativos', () => {
  const { help } = makeHelp();
  for (const t of ['started', 'cooling', 'ready', 'finished', 'failed', 'hms', 'collected', 'progress']) {
    assert.equal(help.audienceFor(t), 'admin', t);
  }
  assert.equal(help.audienceFor('announce'), 'all');
});

test('ayuda: «Si» abre solo el aviso de pieza lista, hasta retirar la pieza', () => {
  const { help } = makeHelp();
  const ask = help.ask({ jobName: 'Benchy' });
  const r = help.answer('yes', ask.id);
  assert.ok(r.ok && r.announce);
  assert.equal(help.toJSON().mode, 'job');
  assert.equal(help.audienceFor('ready'), 'all');
  assert.equal(help.audienceFor('started'), 'admin', 'solo lo prometido');
  help.onPhase('cooling');
  help.onPhase('ready');
  assert.equal(help.isActive(), true);
  help.onPhase('idle');
  assert.equal(help.isActive(), false);
  assert.equal(help.audienceFor('ready'), 'admin');
});

test('ayuda: en modo job, un trabajo nuevo tras el anterior cierra la ayuda', () => {
  const { help } = makeHelp();
  help.answer('yes');
  help.onPhase('printing'); // mismo trabajo aun: sigue
  assert.equal(help.isActive(), true);
  help.onPhase('cooling');
  help.onPhase('printing'); // otro trabajo sin retirar la pieza
  assert.equal(help.isActive(), false);
});

test('ayuda: «Si 12h» dura 12 horas exactas y sobrevive a trabajos', () => {
  const { help } = makeHelp();
  const t0 = 1_000_000_000_000;
  const r = help.answer('yes12', null, t0);
  assert.ok(r.announce);
  assert.equal(help.isActive(t0 + 11.9 * 3600_000), true);
  assert.equal(help.isActive(t0 + 12 * 3600_000 + 1), false);
  help.onPhase('idle');
  help.onPhase('printing');
  assert.equal(help.mode, 'until');
  assert.equal(help.ask({}, t0 + 3600_000), null, 'con 12 h abiertas no se vuelve a preguntar');
  assert.ok(help.ask({}, t0 + 13 * 3600_000), 'pasadas, si');
});

test('ayuda: «Si» no recorta una ventana de 12 h abierta ni vuelve a avisar', () => {
  const { help } = makeHelp();
  help.answer('yes12');
  const r = help.answer('yes');
  assert.equal(r.announce, false);
  assert.equal(help.mode, 'until');
});

test('ayuda: «No» deja las cosas apagadas y no avisa a nadie', () => {
  const { help } = makeHelp();
  const ask = help.ask({});
  const r = help.answer('no', ask.id);
  assert.ok(r.ok);
  assert.equal(r.announce, false);
  assert.equal(help.isActive(), false);
});

test('ayuda: respuestas repetidas, ajenas o caducadas', () => {
  const { help } = makeHelp();
  const t0 = Date.now();
  const ask = help.ask({}, t0);
  assert.equal(help.answer('maybe', ask.id).status, 400);
  assert.equal(help.answer('yes', 'otraid').status, 404);
  assert.ok(help.answer('yes', ask.id, t0 + 1000).announce);
  const again = help.answer('yes12', ask.id, t0 + 2000);
  assert.ok(again.ok && again.already);
  assert.equal(help.mode, 'job', 'la segunda respuesta no cambia nada');

  const stale = help.ask({}, t0);
  assert.equal(help.answer('yes', stale.id, t0 + ASK_TTL_MS + 1).status, 410);
  assert.equal(help.openAsk(t0 + ASK_TTL_MS + 1), null);
});

test('ayuda: el estado sobrevive a un reinicio', () => {
  const { file } = tmpStore();
  let store = new Store(file, {});
  let admins = new AdminRegistry({ code: 'c', store });
  admins.enroll({});
  let help = new HelpWindow({ store, admins });
  help.answer('yes12');
  store.flush();

  store = new Store(file, {});
  admins = new AdminRegistry({ code: 'c', store });
  help = new HelpWindow({ store, admins });
  assert.equal(help.isActive(), true);
  assert.equal(help.mode, 'until');
});

// ---------------------------------------------------------------------------
// PushHub: la audiencia
// ---------------------------------------------------------------------------

function makePush() {
  const keys = webpush.generateVAPIDKeys();
  const store = new Store(tmpStore().file, {});
  const push = new PushHub({ publicKey: keys.publicKey, privateKey: keys.privateKey, store });
  const sent = [];
  webpush.sendNotification = async (sub, body) => {
    sent.push({ endpoint: sub.endpoint, body: JSON.parse(body) });
  };
  return { push, store, sent };
}

test('push: audience admin / standard / all reparte donde toca', async () => {
  const { push, sent } = makePush();
  push.subscribe(fakeSub('admin'), { ua: 'x', adminKid: 'k1' });
  push.subscribe(fakeSub('user1'), { ua: 'x' });
  push.subscribe(fakeSub('user2'), { ua: 'x' });

  await push.send({ title: 't' }, { audience: 'admin' });
  assert.deepEqual(sent.splice(0).map((s) => s.endpoint), ['https://push.example/admin']);

  await push.send({ title: 't' }, { audience: 'standard' });
  assert.deepEqual(
    sent.splice(0).map((s) => s.endpoint).sort(),
    ['https://push.example/user1', 'https://push.example/user2'],
  );

  await push.send({ title: 't' });
  assert.equal(sent.splice(0).length, 3);
});

test('push: renovar la suscripcion conserva el rol; un usuario no lo hereda', () => {
  const { push } = makePush();
  push.subscribe(fakeSub('a'), { ua: 'x', adminKid: 'k1' });
  push.subscribe(fakeSub('a'), { ua: 'x' }); // renovacion sin cookie (service worker)
  assert.equal(push.devices[0].admin, true);
  push.subscribe(fakeSub('b'), { ua: 'x' });
  assert.equal(push.devices.find((d) => !d.admin) != null, true);
});

test('push: reconcileAdmins degrada a los dispositivos sin testigo valido', () => {
  const { push } = makePush();
  push.subscribe(fakeSub('a'), { ua: 'x', adminKid: 'k1' });
  push.subscribe(fakeSub('b'), { ua: 'x', adminKid: 'k2' });
  assert.equal(push.reconcileAdmins(['k2']), 1);
  assert.deepEqual(push.devices.map((d) => d.admin).sort(), [false, true]);
});

test('push: un dispositivo admin silenciado desde su campana no recibe la pregunta', async () => {
  const { push, sent } = makePush();
  push.subscribe(fakeSub('admin'), { ua: 'x', adminKid: 'k1' });
  push.mute(push.devices[0].id, 24);
  await push.send({ title: 't' }, { audience: 'admin' });
  assert.equal(sent.length, 0);
});

// ---------------------------------------------------------------------------
// Flujo completo: ciclo -> pregunta -> respuesta -> avisos a usuarios
// ---------------------------------------------------------------------------

function world() {
  const { push, store, sent } = makePush();
  const admins = new AdminRegistry({ code: 'c', store });
  const help = new HelpWindow({ store, admins });
  const notifier = new Notifier({ store, push, help });
  notifier.updateSettings({ groups: { other: true } }); // todo encendido
  const jobCycle = new JobCycle({ coolMs: 50, store });
  const broadcasts = [];
  connectHelp({ jobCycle, help, push, broadcast: (t, p) => broadcasts.push([t, p]) });
  // Lo mismo que hace server.js con las fases.
  jobCycle.on('phase', (info) => {
    if (info.silent) return;
    if (info.phase === 'cooling') notifier.fire('cooling', 'enfriando', { printerName: 'A1' });
    else if (info.phase === 'ready') notifier.fire('ready', 'lista', { printerName: 'A1' });
  });
  return { push, admins, help, notifier, jobCycle, sent, broadcasts };
}

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = { state: 'RUNNING', jobName: 'Benchy' };

test('flujo: al empezar una impresion solo el admin recibe la pregunta, con tres botones', async () => {
  const w = world();
  w.admins.enroll({});
  w.push.subscribe(fakeSub('admin'), { ua: 'x', adminKid: 'k' });
  w.push.subscribe(fakeSub('user'), { ua: 'x' });

  w.jobCycle.update({ state: 'IDLE' }, true);
  w.jobCycle.update(running);
  await tick();

  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].endpoint, 'https://push.example/admin');
  assert.deepEqual(w.sent[0].body.actions.map((a) => a.action), ['yes', 'yes12', 'no']);
  assert.equal(w.sent[0].body.askId, w.help.openAsk().id);
  assert.match(w.sent[0].body.url, /^\/\?help=[0-9a-f]+$/);
  assert.ok(w.broadcasts.some(([t]) => t === 'help-ask'));
});

test('flujo: «Si» avisa a los usuarios al momento y luego recibe «pieza lista»', async () => {
  const w = world();
  w.admins.enroll({});
  w.push.subscribe(fakeSub('admin'), { ua: 'x', adminKid: 'k' });
  w.push.subscribe(fakeSub('user'), { ua: 'x' });
  w.jobCycle.update({ state: 'IDLE' }, true);
  w.jobCycle.update(running);
  await tick();
  w.sent.length = 0;

  const ask = w.help.openAsk();
  const r = w.help.answer('yes', ask.id);
  if (r.announce) w.notifier.callForHelp(HELP_CALL_TEXT);
  await tick();
  assert.equal(w.sent.length, 1, 'el aviso inmediato va a los usuarios, no al admin');
  assert.equal(w.sent[0].endpoint, 'https://push.example/user');
  assert.equal(w.sent[0].body.body, HELP_CALL_TEXT);
  w.sent.length = 0;

  w.jobCycle.update({ state: 'FINISH', jobName: 'Benchy' });
  await sleep(120); // enfriamiento de 50 ms -> ready
  await tick();
  const toUser = w.sent.filter((s) => s.endpoint.endsWith('/user'));
  const toAdmin = w.sent.filter((s) => s.endpoint.endsWith('/admin'));
  assert.equal(toUser.length, 1, 'el usuario solo recibe «lista»');
  assert.match(toUser[0].body.body, /lista/);
  assert.equal(toAdmin.length, 2, 'el admin recibe enfriando y lista');

  w.jobCycle.clear({ collected: true });
  assert.equal(w.help.isActive(), false, 'al retirar la pieza se cierra');
});

test('flujo: «No» y sin ayuda, el usuario no recibe nada de la impresion', async () => {
  const w = world();
  w.admins.enroll({});
  w.push.subscribe(fakeSub('admin'), { ua: 'x', adminKid: 'k' });
  w.push.subscribe(fakeSub('user'), { ua: 'x' });
  w.jobCycle.update({ state: 'IDLE' }, true);
  w.jobCycle.update(running);
  w.help.answer('no', w.help.openAsk().id);
  w.sent.length = 0;
  w.jobCycle.update({ state: 'FINISH', jobName: 'Benchy' });
  await sleep(120);
  await tick();
  assert.equal(w.sent.filter((s) => s.endpoint.endsWith('/user')).length, 0);
  assert.ok(w.sent.filter((s) => s.endpoint.endsWith('/admin')).length >= 1);
});

test('flujo: sin administradores el comportamiento es el de siempre (todos reciben)', async () => {
  const w = world();
  w.push.subscribe(fakeSub('user'), { ua: 'x' });
  w.jobCycle.update({ state: 'IDLE' }, true);
  w.jobCycle.update(running);
  await tick();
  assert.equal(w.sent.length, 0, 'ninguna pregunta: no hay admin');
  w.jobCycle.update({ state: 'FINISH', jobName: 'Benchy' });
  await sleep(120);
  await tick();
  assert.ok(w.sent.length >= 1);
});

test('flujo: con ventana de 12 h no se vuelve a preguntar en el siguiente trabajo', async () => {
  const w = world();
  w.admins.enroll({});
  w.push.subscribe(fakeSub('admin'), { ua: 'x', adminKid: 'k' });
  w.jobCycle.update({ state: 'IDLE' }, true);
  w.jobCycle.update(running);
  w.help.answer('yes12', w.help.openAsk().id);
  w.jobCycle.update({ state: 'FINISH', jobName: 'Benchy' });
  await sleep(120);
  w.jobCycle.clear({ collected: true });
  w.sent.length = 0;
  w.jobCycle.update({ state: 'RUNNING', jobName: 'Otro' });
  await tick();
  assert.equal(w.sent.filter((s) => s.body.tag === 'help-ask').length, 0);
});

test('payload: el aviso de pregunta lleva su id y el texto del trabajo', () => {
  const p = askPayload({ id: 'abc', jobName: 'Benchy' }, 'A1');
  assert.equal(p.askId, 'abc');
  assert.match(p.body, /Benchy/);
  assert.equal(p.requireInteraction, true);
});
