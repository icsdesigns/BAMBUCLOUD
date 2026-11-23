import test from 'node:test';
import assert from 'node:assert/strict';
import { BambuCloud } from '../src/bambu-cloud.js';

function cloudWith(res) {
  const c = new BambuCloud({ accessToken: 'x' });
  c._get = async () => res;
  return c;
}

test('listDevices: 401 es token rechazado', async () => {
  await assert.rejects(cloudWith({ status: 401, json: null, text: '' }).listDevices(), { unauthorized: true });
});

test('listDevices: cuerpo de error sin lista de equipos es token rechazado', async () => {
  const c = cloudWith({ status: 200, json: { code: 1, message: 'token expired' }, text: '' });
  await assert.rejects(c.listDevices(), { unauthorized: true });
});

test('listDevices: lista vacia es una cuenta sin impresoras, no un fallo', async () => {
  const c = cloudWith({ status: 200, json: { message: 'success', devices: [] }, text: '' });
  assert.deepEqual(await c.listDevices(), []);
});

test('listDevices: devuelve los equipos', async () => {
  const c = cloudWith({ status: 200, json: { devices: [{ dev_id: 'S1', name: 'A', online: true }] }, text: '' });
  assert.equal((await c.listDevices())[0].serial, 'S1');
});
