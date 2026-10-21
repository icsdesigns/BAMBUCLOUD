/**
 * Detector de eventos + envio de notificaciones.
 *
 * Compara el estado normalizado nuevo contra el anterior y emite eventos
 * solo en las transiciones que importan. Evita el spam tipico de
 * "notificar en cada mensaje MQTT".
 *
 * El historial se guarda en disco y se conserva 15 dias: el panel de actividad
 * del dashboard lo lee de ahi, asi que reiniciar el proceso ya no lo vacia.
 */

import { EventEmitter } from 'node:events';

import { lookupHms, lookupPrintError } from './error-codes.js';

export const HISTORY_DAYS = 15;
const HISTORY_MS = HISTORY_DAYS * 24 * 60 * 60 * 1000;
// Tope duro ademas de la antiguedad: un bucle de errores HMS podria generar
// miles de entradas en un solo dia y reventar el fichero de estado.
const HISTORY_MAX = 600;

/**
 * Las dos categorias de avisos.
 *
 * No son "importantes" y "menos importantes": son DOS REGIMENES DISTINTOS.
 *
 * `basic` es el minimo por el que uno tiene esto instalado —cuando la pieza se
 * esta enfriando, cuando ya se puede tocar, y cuando la maquina reporta un
 * error—, y llega a TODOS los dispositivos siempre. No se elige por aparato:
 * si la impresora esta dando errores, quien tenga la app se entera.
 *
 * `other` es seguimiento del trabajo. El panel de administracion decide cuales
 * de estos avisos existen para todo el mundo, y a partir de ahi CADA
 * DISPOSITIVO elige cuales quiere desde la campana de la pantalla principal
 * (ver `prefs` en src/push.js). El panel pone el techo; el movil, su gusto.
 *
 * Cada categoria tiene ademas su propio interruptor, que actua de llave
 * maestra sobre los avisos que contiene: apagar la categoria los calla todos
 * sin perder que tenia encendido cada uno, y volver a encenderla los devuelve
 * como estaban.
 */
export const CATEGORIES = [
  {
    key: 'basic',
    label: 'Notificaciones básicas',
    desc: 'Enfriamiento, pieza lista y errores. Las reciben todos los dispositivos, siempre.',
    // Encendida de fabrica: es el minimo por el que uno instala esto.
    defaultOn: true,
  },
  {
    key: 'other',
    label: 'Otras notificaciones',
    desc: 'Seguimiento del trabajo. Aquí se decide cuáles existen; cada dispositivo elige '
      + 'después las suyas desde la campana.',
    // Apagada de fabrica: es seguimiento, y encendido convierte una impresion
    // de seis horas en una docena de vibraciones.
    defaultOn: false,
  },
];

/**
 * Catalogo de avisos que la app puede emitir.
 *
 * Es la unica fuente de verdad: el panel de administracion dibuja un
 * interruptor por entrada, agrupados por `category`, asi que anadir un tipo
 * aqui basta para que aparezca en la interfaz. `key` coincide con el `type`
 * que se pasa a fire().
 */
export const TRIGGERS = [
  {
    key: 'cooling',
    category: 'basic',
    label: 'La impresión se está enfriando',
    desc: 'Al terminar, cuando arranca el periodo de enfriamiento.',
  },
  {
    key: 'ready',
    category: 'basic',
    label: 'La impresión puede retirarse',
    desc: 'Cuando la cama ya se ha enfriado y la pieza se puede sacar.',
  },
  {
    key: 'hms',
    category: 'basic',
    label: 'Errores de la impresora (HMS)',
    desc: 'Traducidos del catálogo oficial de Bambu Lab, con qué hacer.',
  },
  {
    key: 'started',
    category: 'other',
    label: 'Impresión iniciada',
    desc: 'Al empezar un trabajo nuevo.',
  },
  {
    key: 'finished',
    category: 'other',
    label: 'Impresión terminada',
    desc: 'Cuando la impresora acaba el trabajo.',
  },
  {
    key: 'collected',
    category: 'other',
    label: 'Cama vaciada',
    desc: 'Al confirmar «ya la he retirado»: la cama queda libre para el siguiente trabajo.',
  },
  {
    key: 'paused',
    category: 'other',
    label: 'Impresión en pausa',
    desc: 'Pausa manual, por AMS o por el usuario.',
  },
  {
    key: 'resumed',
    category: 'other',
    label: 'Impresión reanudada',
    desc: 'Al continuar tras una pausa.',
  },
  {
    key: 'failed',
    category: 'other',
    label: 'Impresión fallida',
    desc: 'Cuando el trabajo termina en error.',
  },
  {
    key: 'attention',
    category: 'other',
    label: 'La impresora necesita atención',
    desc: 'Cambio de filamento, atasco, filamento agotado…',
  },
  {
    key: 'calibrated',
    category: 'other',
    label: 'Calibración terminada',
    desc: 'Cuando la A1 acaba la rutina previa (cama, resonancia, extrusión) y empieza a imprimir.',
  },
  {
    key: 'progress',
    category: 'other',
    label: 'Hitos de progreso',
    desc: 'Avisos cada N % (solo si NOTIFY_PROGRESS_STEP no es 0).',
  },
];

/**
 * Etapas (`stg_cur`) que forman la rutina previa de la A1.
 *
 * Antes de la primera capa la maquina se pasa varios minutos nivelando la
 * cama, midiendo resonancias y calibrando la extrusion. Durante ese rato el
 * dashboard dice "Imprimiendo" y no lo esta: no hay nada que mirar todavia, y
 * quien quiera vigilar la primera capa —que es cuando de verdad hay que estar
 * delante— no tiene forma de saber cuando asomarse.
 *
 * Los codigos salen de STAGES en src/normalize.js: los de calibrar, escanear e
 * identificar la cama. La inspeccion de primera capa (12) queda fuera a
 * proposito: para entonces la impresion ya ha empezado, que es justo lo que el
 * aviso anuncia.
 */
const CALIBRATION_STAGES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 14, 16, 17, 19]);

/** type -> categoria, resuelto una vez. */
const CATEGORY_OF = new Map(TRIGGERS.map((t) => [t.key, t.category]));

/**
 * Valores de fabrica: basicas encendidas, el resto apagado.
 *
 * ESTO NO ES SOLO "EL PRIMER ARRANQUE"
 * ------------------------------------
 * En el plan gratuito de Render no hay disco: cada reinicio o redespliegue se
 * lleva por delante `bambu-state.json` y con el los ajustes, asi que lo que
 * este aqui es lo que habra CADA VEZ que el servicio arranque de cero. Es la
 * unica configuracion que se puede dar por segura.
 *
 * Durante un tiempo las dos categorias arrancaban apagadas, buscando que un
 * reinicio no reactivara solo unos avisos recien silenciados. El efecto real
 * fue el contrario y peor: un redespliegue de madrugada dejaba el dashboard
 * mudo sin que nada lo indicara, y la primera senal era una impresion
 * terminada de la que nadie se entero. Silenciar es reversible mirando el
 * panel; no enterarse, no.
 *
 * Asi que el arranque en frio deja lo minimo por lo que uno tiene esto
 * instalado (enfriamiento, pieza lista, errores) y calla el seguimiento. Para
 * "ahora no quiero que suene" esta el silencio de 24 o 48 h de la campana, que
 * es la pregunta que de verdad se hace varias veces al dia, va por dispositivo
 * y caduca sola: ver `mutedUntil` en src/push.js.
 *
 * Los interruptores individuales arrancan todos encendidos: asi encender una
 * categoria enciende de verdad lo que promete, en vez de dejar al usuario
 * delante de una lista que sigue muda hasta que la recorre entera.
 *
 * Con un disco persistente montado (ver render.yaml) esto solo decide el
 * primer arranque; a partir de ahi manda lo guardado.
 */
export const DEFAULT_SETTINGS = {
  enabled: true,
  groups: Object.fromEntries(CATEGORIES.map((c) => [c.key, c.defaultOn === true])),
  triggers: Object.fromEntries(TRIGGERS.map((t) => [t.key, true])),
};

/**
 * Ajustes guardados antes de que existieran las categorias.
 *
 * No traen `groups`, y darles el valor de fabrica (apagado) dejaria mudo de
 * golpe un dashboard que estaba avisando. Se les dan las dos categorias
 * encendidas: los interruptores individuales que ya tenian guardados siguen
 * mandando exactamente igual que antes.
 */
const LEGACY_GROUPS = Object.fromEntries(CATEGORIES.map((c) => [c.key, true]));

export class Notifier extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.telegramToken]
   * @param {string} [opts.telegramChatId]
   * @param {string} [opts.discordWebhook]
   * @param {string} [opts.genericWebhook] POST JSON a una URL cualquiera
   * @param {number} [opts.progressStep] notificar cada N% (0 = desactivado)
   * @param {import('./store.js').Store} [opts.store]
   * @param {import('./push.js').PushHub} [opts.push]
   * @param {import('./help.js').HelpWindow} [opts.help] decide a quien llega cada aviso
   */
  constructor(opts = {}) {
    super();
    this.telegramToken = opts.telegramToken || null;
    this.telegramChatId = opts.telegramChatId || null;
    this.discordWebhook = opts.discordWebhook || null;
    this.genericWebhook = opts.genericWebhook || null;
    this.progressStep = Number(opts.progressStep ?? 0);
    this.store = opts.store || null;
    this.push = opts.push || null;
    this.help = opts.help || null;

    this.prev = null;
    this.seenHms = new Set();
    this.lastProgressBucket = -1;

    this.history = this._prune(this.store?.get('history') || []);
  }

  get enabled() {
    return Boolean(this.telegramToken || this.discordWebhook || this.genericWebhook);
  }

  // -------------------------------------------------------------------------
  // Ajustes
  // -------------------------------------------------------------------------

  get settings() {
    const saved = this.store?.get('settings');
    if (!saved) return structuredClone(DEFAULT_SETTINGS);
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      groups: { ...(saved.groups ? DEFAULT_SETTINGS.groups : LEGACY_GROUPS), ...(saved.groups || {}) },
      triggers: { ...DEFAULT_SETTINGS.triggers, ...(saved.triggers || {}) },
    };
  }

  /** Acepta parches parciales; devuelve los ajustes ya resueltos. */
  updateSettings(patch = {}) {
    const current = this.settings;
    const next = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      groups: { ...current.groups },
      triggers: { ...current.triggers },
    };
    for (const [key, value] of Object.entries(patch.groups || {})) {
      if (typeof value === 'boolean' && key in next.groups) next.groups[key] = value;
    }
    for (const [key, value] of Object.entries(patch.triggers || {})) {
      if (typeof value === 'boolean') next.triggers[key] = value;
    }
    this.store?.set('settings', next);
    // Sin pasar por el agrupador: esto es una accion deliberada del usuario y
    // no puede evaporarse porque el proceso se reinicie medio segundo despues.
    this.store?.flush();
    return next;
  }

  /**
   * Tres llaves en serie, de la mas general a la mas concreta: el interruptor
   * maestro, el de la categoria a la que pertenece el aviso, y el suyo propio.
   * Basta con que una este cerrada para que no salga nada.
   *
   * Esto decide si el aviso SE EMITE. Lo que cada movil quiere recibir de lo
   * que se emite —y si esta silenciado ahora mismo— se filtra despues, por
   * dispositivo, en src/push.js: son dos preguntas distintas y viven separadas.
   *
   * Un tipo que no este en el catalogo (uno nuevo que aun no tenga ficha) pasa
   * la parte de categoria: mejor que avise de mas a que se pierda en silencio.
   */
  allows(type) {
    const s = this.settings;
    if (!s.enabled) return false;
    const category = CATEGORY_OF.get(type);
    if (category && s.groups[category] === false) return false;
    return s.triggers[type] !== false;
  }

  // -------------------------------------------------------------------------
  // Deteccion
  // -------------------------------------------------------------------------

  /** Procesa un estado normalizado y dispara lo que corresponda. */
  update(next, printerName = 'Bambu Lab A1') {
    const prev = this.prev;
    this.prev = next;
    if (!next) return;

    // --- Transiciones de estado ---
    if (prev && prev.state !== next.state) {
      if (next.state === 'FINISH') {
        this.fire('finished', '✅ Impresión terminada', {
          printerName,
          level: 'success',
        });
        this.lastProgressBucket = -1;
      } else if (next.state === 'FAILED') {
        // La impresora suele decir POR QUE ha fallado en `print_error`, que es
        // un codigo del mismo catalogo oficial que los HMS. Sin traducirlo, el
        // aviso se queda en "ha fallado" y hay que ir a mirar a la maquina.
        const error = lookupPrintError(next.printError);
        this.fire('failed', '❌ Impresión fallida', {
          printerName,
          level: 'error',
          ...(error && {
            code: error.code,
            detail: error.description,
            remedy: error.remedy,
            url: error.url,
          }),
        });
        this.lastProgressBucket = -1;
      } else if (next.state === 'PAUSE') {
        const reason = next.stage ? ` (${next.stage})` : '';
        this.fire('paused', `⏸️ Impresión en pausa${reason}`, {
          printerName,
          level: 'warning',
        });
      } else if (next.state === 'RUNNING' && prev.state === 'PAUSE') {
        this.fire('resumed', '▶️ Impresión reanudada', {
          printerName,
          level: 'info',
        });
      } else if (next.state === 'RUNNING' && prev.state !== 'RUNNING') {
        this.fire('started', '🖨️ Impresión iniciada', {
          printerName,
          level: 'info',
        });
        this.lastProgressBucket = -1;
      }
    }

    // --- Etapas que requieren atencion humana ---
    if (prev && prev.stageCode !== next.stageCode) {
      const needsUser = [22, 23, 24, 25, 29, 31, 32];
      if (needsUser.includes(next.stageCode)) {
        this.fire('attention', `⚠️ La impresora necesita atención: ${next.stage}`, {
          printerName,
          level: 'warning',
        });
      }
    }

    // --- Fin de la calibracion previa ---
    //
    // Se dispara al SALIR del grupo de etapas de calibracion, no al entrar en
    // una concreta: la rutina salta entre varias (nivelar, escanear, medir) y
    // avisar en cada salto seria una docena de vibraciones por trabajo.
    //
    // Y solo con el trabajo vivo: una calibracion que acaba porque alguien ha
    // cancelado no es "ya empieza a imprimir", es un trabajo que se fue al
    // traste, y de eso avisa 'failed'.
    if (
      prev &&
      prev.stageCode !== next.stageCode &&
      CALIBRATION_STAGES.has(prev.stageCode) &&
      !CALIBRATION_STAGES.has(next.stageCode) &&
      next.printing
    ) {
      this.fire('calibrated', '🎯 Calibración terminada, empieza la impresión', {
        printerName,
        level: 'info',
        ...(next.remainingText && { detail: `Quedan ${next.remainingText}` }),
      });
    }

    // --- Errores HMS nuevos ---
    //
    // El aviso lleva QUE pasa (texto oficial de Bambu) y QUE HACER, no el
    // codigo: "0700_2000_0002_0001" no le dice nada a nadie a las tres de la
    // madrugada. El codigo sigue viajando en `code` para el historial y para
    // el enlace a la ficha oficial.
    for (const h of next.hms || []) {
      if (this.seenHms.has(h.id)) continue;
      this.seenHms.add(h.id);
      const info = lookupHms(h.id, h.severity);
      const headline = info.known ? info.description : `Error ${info.id} (${info.severityLabel})`;
      this.fire('hms', `🔧 ${headline}`, {
        printerName,
        level: info.severity <= 2 ? 'error' : 'warning',
        code: info.id,
        severity: info.severity,
        severityLabel: info.severityLabel,
        remedy: info.remedy,
        url: info.url,
      });
    }
    // Limpiar los que ya se resolvieron
    const activeIds = new Set((next.hms || []).map((h) => h.id));
    for (const id of this.seenHms) {
      if (!activeIds.has(id)) this.seenHms.delete(id);
    }

    // --- Hitos de progreso ---
    // Solo a partir del segundo estado: al arrancar el servidor con una
    // impresion a medias no tiene sentido avisar del progreso actual.
    if (prev && this.progressStep > 0 && next.printing && next.percent != null) {
      const bucket = Math.floor(next.percent / this.progressStep);
      if (bucket > this.lastProgressBucket && next.percent > 0 && next.percent < 100) {
        this.lastProgressBucket = bucket;
        this.fire(
          'progress',
          `📊 ${next.percent}%${next.remainingText ? ` · quedan ${next.remainingText}` : ''}`,
          { printerName, level: 'info', silent: true },
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Emision
  // -------------------------------------------------------------------------

  /**
   * Registra el evento y lo reparte. El historial se escribe siempre (es el
   * registro de lo que ha pasado, no un canal de aviso), pero el envio a
   * Telegram, webhooks y Web Push respeta los interruptores del panel.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.force] salta los interruptores. Solo para lo que
   *   dispara una persona a mano desde el panel —el aviso de "va a haber una
   *   actualizacion"—: si alguien lo pulsa, tiene que salir. El silencio de
   *   cada dispositivo sigue mandando, eso se respeta en src/push.js.
   */
  fire(type, text, meta = {}, { force = false } = {}) {
    const allowed = force || this.allows(type);
    // `notify` viaja hasta el navegador: es lo que decide si ademas de entrar
    // en el historial el evento hace saltar un aviso en pantalla. Sin esto, un
    // tipo apagado desde el panel seguia avisando en las pestanas abiertas,
    // que es justo lo que el interruptor dice que no debe pasar.
    // A quien va dirigido, calculado UNA vez aqui y no en cada canal: el
    // navegador tambien lo necesita, porque una pestana abierta de un usuario
    // estandar recibe todos los eventos por WebSocket y, sin esto, los
    // mostraria como aviso aunque el push no se los haya mandado.
    const audience = meta.audience || this.help?.audienceFor(type) || 'all';
    const event = { type, text, at: Date.now(), notify: allowed, ...meta, audience };

    this.history.unshift(event);
    this.history = this._prune(this.history);
    this.store?.set('history', this.history);

    this.emit('notification', event);

    if (!allowed) return event;
    this.send(text, { ...meta, type, audience }).catch((err) => this.emit('error', err));
    return event;
  }

  /**
   * El aviso que no nace de la impresora, sino de una persona.
   *
   * Cargar una version nueva reinicia la interfaz de todos los navegadores
   * abiertos, y un movil que lleve dias con la pestana dormida se queda con
   * una copia vieja que ya no entiende lo que le manda el servidor. Esto avisa
   * antes: "abre la app". No pasa por los interruptores —lo esta pulsando
   * alguien a proposito— pero si por el silencio de cada dispositivo, que es
   * una decision de su dueno y no la pisa nadie.
   */
  announce(text, meta = {}) {
    return this.fire('announce', text, { level: 'warning', ...meta }, { force: true });
  }

  /**
   * «Necesitaré tu ayuda…»: el admin ha dicho que si. Va a los usuarios
   * estandar —el admin ya sabe lo que ha pulsado— y deja rastro en el
   * historial como cualquier otro aviso. Salta los interruptores del panel
   * (lo ha pedido una persona), pero no el silencio de cada dispositivo.
   */
  callForHelp(text, meta = {}) {
    return this.fire(
      'help',
      text,
      { level: 'info', printerName: 'Bambustatus', audience: 'standard', ...meta },
      { force: true },
    );
  }

  _prune(list) {
    const cutoff = Date.now() - HISTORY_MS;
    return list
      .filter((e) => e && typeof e.at === 'number' && e.at >= cutoff)
      .sort((a, b) => b.at - a.at)
      .slice(0, HISTORY_MAX);
  }

  /**
   * Un aviso traducido tiene tres partes y no todos los canales admiten las
   * tres: Telegram y Discord se llevan el texto entero (que hace, que hacer y
   * el enlace a la ficha), y el push del movil solo las dos primeras — el
   * enlace no se puede pulsar desde la notificacion, y ocupa dos lineas.
   */
  static compose(text, meta = {}, { withUrl = true } = {}) {
    const lines = [text];
    if (meta.detail && meta.detail !== text) lines.push(meta.detail);
    if (meta.remedy) lines.push(`👉 ${meta.remedy}`);
    if (withUrl && meta.url) lines.push(meta.url);
    return lines.join('\n');
  }

  async send(text, meta = {}) {
    const jobs = [];
    const full = Notifier.compose(text, meta);
    const short = Notifier.compose(text, meta, { withUrl: false });

    if (this.telegramToken && this.telegramChatId) {
      jobs.push(
        fetch(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.telegramChatId,
            text: full,
            disable_notification: Boolean(meta.silent),
          }),
        }),
      );
    }

    if (this.discordWebhook) {
      jobs.push(
        fetch(this.discordWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: full }),
        }),
      );
    }

    if (this.genericWebhook) {
      jobs.push(
        fetch(this.genericWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, ...meta }),
        }),
      );
    }

    // Los hitos de progreso son ruido en el movil: van al historial y a los
    // canales de texto, pero no vibran el telefono.
    if (this.push?.enabled && !meta.silent) {
      jobs.push(
        this.push.send(
          {
            title: meta.printerName || 'Bambustatus',
            body: short,
            tag: meta.type || 'bambu',
            url: '/',
          },
          // El tipo y su categoria viajan hasta el reparto porque ahi vive el
          // segundo filtro: el de lo que cada movil ha elegido recibir. Y la
          // audiencia, el primero de todos: con los roles en marcha, un usuario
          // estandar solo recibe lo que el admin le ha abierto (src/help.js).
          {
            type: meta.type || null,
            category: CATEGORY_OF.get(meta.type) || null,
            audience: meta.audience || 'all',
          },
        ),
      );
    }

    const results = await Promise.allSettled(jobs);
    for (const r of results) {
      if (r.status === 'rejected') this.emit('error', r.reason);
    }
  }
}
