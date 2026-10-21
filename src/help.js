/**
 * "Ayuda con las impresiones".
 *
 * Los usuarios estandar no reciben avisos de la impresora por defecto: quien
 * decide si hacen falta manos extra es el administrador, y lo decide cada vez
 * que empieza un trabajo. Este modulo guarda esa decision.
 *
 *   off     nadie mas recibe nada. Es el estado normal.
 *   job     "Si": hasta que se retire la pieza del trabajo en curso.
 *   until   "Si 12 h": durante las proximas 12 horas, sean cuantos sean los
 *           trabajos.
 *
 * Mientras la ayuda esta activa, los usuarios reciben el aviso de «ya se
 * puede retirar» (`HELP_TYPES`) y nada mas: lo que se les prometio.
 *
 * Todo lo que importa vive en el almacen JSON, asi que un reinicio a mitad de
 * una impresion no tira la decision. El plazo de 12 h es una marca de tiempo,
 * no un temporizador, por la misma razon que el silencio de la campana (ver
 * `isMuted` en src/push.js).
 */

import crypto from 'node:crypto';

export const HELP_HOURS = 12;
export const HELP_MS = HELP_HOURS * 3600_000;

/**
 * Cuanto vive una pregunta sin contestar. Pasado esto, tocar la notificacion
 * de hace dos dias ya no activa nada: se contesta desde el panel.
 */
export const ASK_TTL_MS = 6 * 3600_000;

/**
 * Tope de seguridad del modo `job`. El fin natural es que se retire la pieza;
 * esto solo evita que una impresion que nadie recoge deje la ayuda abierta
 * indefinidamente.
 */
const JOB_MAX_MS = 48 * 3600_000;

/** Lo unico que un usuario estandar recibe mientras la ayuda esta activa. */
export const HELP_TYPES = new Set(['ready']);

/** Avisos que llegan a TODOS siempre, ayuda o no: operativos, no de seguimiento. */
export const ALWAYS_TYPES = new Set(['announce', 'test']);

export const HELP_CALL_TEXT =
  '¡Necesitaré tu ayuda con las siguientes impresiones! Recibirás una notificación ' +
  'cuando las impresiones estén listas para ser retiradas de la cama. ¡Gracias!';

export const CHOICES = ['yes', 'yes12', 'no'];

export class HelpWindow {
  /**
   * @param {object} opts
   * @param {import('./store.js').Store} opts.store
   * @param {import('./roles.js').AdminRegistry} opts.admins
   */
  constructor({ store, admins }) {
    this.store = store;
    this.admins = admins;
    const saved = store.get('help') || {};
    this.mode = ['job', 'until'].includes(saved.mode) ? saved.mode : 'off';
    this.setAt = saved.setAt || null;
    this.untilAt = saved.untilAt || null;
    // En modo `job`: ya hemos visto que la impresion termino y se enfria.
    // Si despues vuelve a haber `printing`, es OTRO trabajo y la ayuda acaba.
    this.passedPrinting = Boolean(saved.passedPrinting);
    this.pending = store.get('helpAsk') || null; // { id, at, jobName, answered }
  }

  _persist() {
    this.store.set('help', {
      mode: this.mode,
      setAt: this.setAt,
      untilAt: this.untilAt,
      passedPrinting: this.passedPrinting,
    });
    this.store.flush();
  }

  /** Si hay ayuda activa ahora mismo. */
  isActive(now = Date.now()) {
    if (this.mode === 'until') return Boolean(this.untilAt) && this.untilAt > now;
    if (this.mode === 'job') return Boolean(this.setAt) && now - this.setAt < JOB_MAX_MS;
    return false;
  }

  /** Lo que ve cualquiera: no revela nada que no se vaya a notificar igualmente. */
  toJSON(now = Date.now()) {
    const active = this.isActive(now);
    return {
      active,
      mode: active ? this.mode : 'off',
      untilAt: active && this.mode === 'until' ? this.untilAt : null,
    };
  }

  /**
   * A quien se le manda un aviso de este tipo.
   *
   *   'all'      a todos los dispositivos
   *   'admin'    solo a los de administrador
   *
   * Con los roles apagados (aun no hay ningun admin) todo es 'all', que es
   * como funcionaba esto antes. Con los roles en marcha, los usuarios
   * estandar solo reciben lo operativo y, si hay ayuda, la pieza lista.
   */
  audienceFor(type, now = Date.now()) {
    if (!this.admins.active) return 'all';
    if (ALWAYS_TYPES.has(type)) return 'all';
    if (HELP_TYPES.has(type) && this.isActive(now)) return 'all';
    return 'admin';
  }

  // -------------------------------------------------------------------------
  // Ciclo de la impresion
  // -------------------------------------------------------------------------

  /** Alimentado por `jobCycle.on('phase')`: el modo `job` acaba solo. */
  onPhase(phase) {
    if (this.mode !== 'job') return;
    if (phase === 'cooling' || phase === 'ready') {
      if (!this.passedPrinting) {
        this.passedPrinting = true;
        this._persist();
      }
      return;
    }
    // Pieza retirada (o trabajo cancelado), o un trabajo nuevo tras el anterior.
    if (phase === 'idle' || (phase === 'printing' && this.passedPrinting)) this.off();
  }

  // -------------------------------------------------------------------------
  // Decisiones
  // -------------------------------------------------------------------------

  off() {
    if (this.mode === 'off') return;
    this.mode = 'off';
    this.setAt = null;
    this.untilAt = null;
    this.passedPrinting = false;
    this._persist();
  }

  /**
   * Abre una pregunta nueva para el admin. Devuelve null si no tiene sentido
   * hacerla: no hay admins, o ya hay una ventana de 12 h abierta.
   */
  ask({ jobName = null } = {}, now = Date.now()) {
    if (!this.admins.active) return null;
    if (this.mode === 'until' && this.isActive(now)) return null;
    this.pending = {
      id: crypto.randomBytes(6).toString('hex'),
      at: now,
      jobName: jobName ? String(jobName).slice(0, 80) : null,
      answered: null,
    };
    this.store.set('helpAsk', this.pending);
    this.store.flush();
    return this.pending;
  }

  /** La pregunta que sigue esperando respuesta, si queda alguna. */
  openAsk(now = Date.now()) {
    const p = this.pending;
    if (!p || p.answered || now - p.at > ASK_TTL_MS) return null;
    return p;
  }

  /**
   * Aplica la respuesta del admin.
   *
   * @param {'yes'|'yes12'|'no'} choice
   * @param {string|null} [askId] la pregunta que se contesta. Sin id es una
   *   orden directa desde el panel y no exige pregunta abierta.
   * @returns {{ok:true, announce:boolean, state:object, already?:boolean}
   *   | {ok:false, status:number, error:string}}
   */
  answer(choice, askId = null, now = Date.now()) {
    if (!CHOICES.includes(choice)) {
      return { ok: false, status: 400, error: 'Respuesta no válida' };
    }
    if (askId) {
      const p = this.pending;
      if (!p || p.id !== askId) {
        return { ok: false, status: 404, error: 'Esa pregunta ya no existe' };
      }
      if (p.answered) {
        // Doble toque, o el aviso contestado desde otro admin: idempotente.
        return { ok: true, announce: false, already: true, state: this.toJSON(now) };
      }
      if (now - p.at > ASK_TTL_MS) {
        return { ok: false, status: 410, error: 'La pregunta ha caducado' };
      }
      p.answered = { choice, at: now };
      this.store.set('helpAsk', p);
    }

    const wasActive = this.isActive(now);
    const wasUntil = wasActive && this.mode === 'until';

    if (choice === 'no') {
      this.off();
      this.store.flush();
      return { ok: true, announce: false, state: this.toJSON(now) };
    }

    if (choice === 'yes12') {
      this.mode = 'until';
      this.setAt = now;
      this.untilAt = now + HELP_MS;
      this.passedPrinting = false;
    } else if (!wasUntil) {
      // «Si» no recorta una ventana de 12 h que ya estaba abierta.
      this.mode = 'job';
      this.setAt = now;
      this.untilAt = null;
      this.passedPrinting = false;
    }
    this._persist();
    return {
      ok: true,
      // Solo se avisa a los usuarios si esto ha cambiado algo para ellos.
      announce: !wasUntil || choice === 'yes12',
      state: this.toJSON(now),
    };
  }
}

/**
 * El aviso push de «¿pides ayuda?», con sus tres botones.
 *
 * Los navegadores recortan los botones a los que caben —Android deja dos, iOS
 * ninguno—, asi que tocar el cuerpo del aviso abre la app con la misma
 * pregunta (`?help=<id>`) y callarse equivale a «No»: la pregunta caduca.
 */
export function askPayload(ask, title = 'Bambu Lab A1') {
  const job = ask.jobName ? ` «${ask.jobName}»` : '';
  return {
    title,
    body: `🖨️ Impresión${job} iniciada. ¿Pides ayuda a los usuarios para retirarla?`,
    tag: 'help-ask',
    url: `/?help=${ask.id}`,
    askId: ask.id,
    requireInteraction: true,
    actions: [
      { action: 'yes', title: 'Sí' },
      { action: 'yes12', title: 'Sí 12h' },
      { action: 'no', title: 'No' },
    ],
  };
}

/**
 * Engancha la ayuda al ciclo de la impresion.
 *
 *   - Cada cambio de fase puede cerrar la ayuda de «esta impresion».
 *   - Cuando empieza un trabajo de verdad (no el estado heredado al arrancar el
 *     proceso: `silent`) se le pregunta al admin. La pregunta va SOLO a los
 *     dispositivos de administrador, y tambien por WebSocket por si ya esta
 *     mirando la app.
 *
 * @param {object} deps
 * @param {import('./job-cycle.js').JobCycle} deps.jobCycle
 * @param {HelpWindow} deps.help
 * @param {import('./push.js').PushHub} deps.push
 * @param {(type:string,payload:object)=>void} deps.broadcast
 * @param {() => string} [deps.title] nombre de la impresora, para el aviso
 */
export function connectHelp({ jobCycle, help, push, broadcast, title = () => 'Bambu Lab A1' }) {
  jobCycle.on('phase', (info) => {
    // Antes del `silent`: que se acabe la ayuda de esta impresion no depende de
    // si hay que avisar a alguien.
    if (help.mode === 'job') {
      help.onPhase(info.phase);
      broadcast('help', help.toJSON());
    }
    if (info.silent || info.phase !== 'printing') return;

    const ask = help.ask({ jobName: info.jobName });
    if (!ask) return;
    broadcast('help-ask', { id: ask.id, jobName: ask.jobName, at: ask.at });
    if (!push.enabled) return;
    push
      .send(askPayload(ask, title()), { audience: 'admin' })
      .then((r) => console.log(`[ayuda] pregunta enviada a ${r.sent} admin(s)`))
      .catch((err) => console.error('[ayuda]', err.message));
  });
}
