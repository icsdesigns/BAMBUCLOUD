/**
 * Roles: administrador y usuario estandar.
 *
 * Hasta ahora "ser admin" era saber un codigo: cualquiera que lo tecleara
 * abria el panel durante una hora, y el mismo codigo valia para siempre. Eso
 * no sirve para distinguir a la persona que manda en las impresiones de los
 * demas, que es lo que hace falta para preguntarle a ella —y solo a ella— si
 * quiere pedir ayuda cuando empieza un trabajo.
 *
 * El modelo es el de un dispositivo de confianza, no el de una cuenta:
 *
 *   usuario     cualquiera que haya entrado con la contrasena del dashboard.
 *   admin       un navegador al que se le ha entregado un TESTIGO de
 *               administrador. El testigo viaja en una cookie httpOnly: ni el
 *               JavaScript de la pagina ni un XSS pueden leerlo.
 *
 * Como se proteje la condicion de admin:
 *
 *   - El servidor no guarda el testigo, guarda su HMAC. Quien lea el JSON de
 *     estado ve huellas, no credenciales: no puede hacerse pasar por admin.
 *   - La clave del HMAC sale de scrypt(ADMIN_CODE). Cambiar el codigo en el
 *     entorno deja de validar TODOS los testigos de golpe: es el boton de
 *     panico, y tambien la salida si se pierde el unico dispositivo admin.
 *   - Hacerse admin pide el codigo. Y cuando ya existe algun admin, ademas una
 *     invitacion de un solo uso que solo otro admin puede generar: saber el
 *     codigo ya no basta para colarse.
 *   - Hay un tope de admins (ADMIN_MAX, 3 por defecto).
 *
 * Solo hay estado cuando hay admins. Con cero admins el servidor se comporta
 * como antes de que existieran los roles (ver `AdminRegistry.active`).
 */

import crypto from 'node:crypto';

export const ADMIN_COOKIE = 'bambu.adm';
/** Un testigo de admin dura lo que dura el navegador que lo guarda. */
export const ADMIN_COOKIE_MAX_AGE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

const KEY = 'admins';
const SALT = 'bambustatus-admin-v1';
/** La invitacion para un segundo admin caduca rapido: se teclea al momento. */
export const INVITE_TTL_MS = 5 * 60_000;
const INVITE_DIGITS = 8;

/** Lee una cookie de la cabecera, sin meter `cookie-parser` por esto. */
export function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Compara dos cadenas en tiempo constante, sea cual sea su longitud. */
function sameString(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export class AdminRegistry {
  /**
   * @param {object} opts
   * @param {string} opts.code ADMIN_CODE
   * @param {import('./store.js').Store} opts.store
   * @param {number} [opts.max] tope de dispositivos admin
   */
  constructor({ code, store, max = 3 }) {
    this.store = store;
    this.max = Math.max(1, Number(max) || 3);
    // scrypt a proposito: el codigo suele ser corto, y esto encarece cada
    // intento de ataque offline contra las huellas guardadas.
    this.key = crypto.scryptSync(String(code), SALT, 32);
    // Del codigo solo se conserva su huella, no el texto.
    this.codeMac = this._mac(`code|${code}`);
    this.invite = null; // { hash, expires } solo en memoria: no sobrevive a un reinicio

    const saved = store.get(KEY);
    const fp = this._mac('fingerprint');
    if (saved && saved.fp !== fp && saved.list?.length) {
      console.warn(
        `[roles] ADMIN_CODE ha cambiado: ${saved.list.length} administrador(es) revocado(s)`,
      );
      this.data = { fp, list: [] };
      this._save();
    } else {
      this.data = { fp, list: Array.isArray(saved?.list) ? saved.list : [] };
    }
  }

  _mac(text) {
    return crypto.createHmac('sha256', this.key).update(String(text)).digest('base64url');
  }

  _save() {
    this.store.set(KEY, this.data);
    // Una revocacion o un alta que se pierde en un reinicio es un agujero.
    this.store.flush();
  }

  /** Cuantos admins hay. */
  get count() {
    return this.data.list.length;
  }

  /**
   * Si los roles estan en marcha. Mientras no haya ningun admin el servidor no
   * puede distinguir a nadie, asi que no restringe nada: activar los roles no
   * puede dejar mudo, de golpe, a un dashboard que ya estaba funcionando.
   */
  get active() {
    return this.count > 0;
  }

  /** Comprobacion en tiempo constante del codigo de administracion. */
  checkCode(given) {
    return sameString(this._mac(`code|${given}`), this.codeMac);
  }

  // -------------------------------------------------------------------------
  // Invitaciones
  // -------------------------------------------------------------------------

  /** Genera la invitacion de un solo uso para dar de alta a otro admin. */
  createInvite() {
    const n = crypto.randomInt(0, 10 ** INVITE_DIGITS);
    const code = String(n).padStart(INVITE_DIGITS, '0');
    this.invite = { hash: this._mac(`invite|${code}`), expires: Date.now() + INVITE_TTL_MS };
    return { code, expiresAt: this.invite.expires };
  }

  /** Comprueba y CONSUME la invitacion. */
  consumeInvite(given) {
    const inv = this.invite;
    if (!inv || inv.expires <= Date.now()) {
      this.invite = null;
      return false;
    }
    const ok = sameString(this._mac(`invite|${String(given).trim()}`), inv.hash);
    if (ok) this.invite = null;
    return ok;
  }

  // -------------------------------------------------------------------------
  // Altas y bajas
  // -------------------------------------------------------------------------

  /**
   * Da de alta un dispositivo admin y devuelve su testigo, UNA sola vez.
   *
   * @param {object} [info]
   * @param {string} [info.label] nombre legible del aparato
   * @param {string|null} [info.deviceId] id de su suscripcion push, si tiene
   * @returns {{ok:true,token:string,kid:string}|{ok:false,error:string}}
   */
  enroll({ label = '', deviceId = null } = {}) {
    if (this.count >= this.max) {
      return {
        ok: false,
        error: `Ya hay ${this.max} administradores. Revoca uno antes de añadir otro.`,
      };
    }
    const kid = crypto.randomBytes(6).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');
    this.data.list.push({
      kid,
      hash: this._mac(`token|${secret}`),
      at: Date.now(),
      lastSeen: Date.now(),
      label: String(label).slice(0, 60),
      deviceId: deviceId ? String(deviceId).slice(0, 40) : null,
    });
    this._save();
    return { ok: true, token: `${kid}.${secret}`, kid };
  }

  /** @returns {object|null} el registro del admin si el testigo es valido */
  verify(token) {
    if (!token || typeof token !== 'string') return null;
    const cut = token.indexOf('.');
    if (cut <= 0) return null;
    const kid = token.slice(0, cut);
    const rec = this.data.list.find((a) => a.kid === kid);
    if (!rec) return null;
    return sameString(this._mac(`token|${token.slice(cut + 1)}`), rec.hash) ? rec : null;
  }

  /** Marca actividad, como mucho una vez cada hora para no escribir en cada peticion. */
  touch(kid) {
    const rec = this.data.list.find((a) => a.kid === kid);
    if (!rec || Date.now() - (rec.lastSeen || 0) < 3600_000) return;
    rec.lastSeen = Date.now();
    this.store.set(KEY, this.data);
  }

  /** Enlaza un admin con el id push del aparato desde el que se dio de alta. */
  bindDevice(kid, deviceId) {
    const rec = this.data.list.find((a) => a.kid === kid);
    if (!rec) return false;
    rec.deviceId = deviceId ? String(deviceId).slice(0, 40) : null;
    this._save();
    return true;
  }

  revoke(kid) {
    const before = this.data.list.length;
    this.data.list = this.data.list.filter((a) => a.kid !== kid);
    if (this.data.list.length === before) return false;
    this._save();
    return true;
  }

  /** Lista para el panel: nunca incluye la huella. */
  list() {
    return this.data.list.map(({ kid, at, lastSeen, label, deviceId }) => ({
      kid, at, lastSeen, label, deviceId,
    }));
  }

  // -------------------------------------------------------------------------
  // Peticiones HTTP
  // -------------------------------------------------------------------------

  /** El registro del admin que hace esta peticion, o null si es un usuario. */
  fromRequest(req) {
    const rec = this.verify(readCookie(req, ADMIN_COOKIE));
    if (rec) this.touch(rec.kid);
    return rec;
  }
}
