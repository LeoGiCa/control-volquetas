/* Control de Volquetas — app del celular.
 * Flujo: foto → se guarda en el celular (cola) → el servidor la lee con Gemini →
 * el encargado revisa → se envía. Sin señal, la cola espera y se envía después. */
'use strict';

const $ = s => document.querySelector(s);
const CAMPOS = ['numero', 'fecha', 'hora', 'proveedor', 'nit', 'cliente', 'placa', 'conductor',
  'origen', 'destino', 'material', 'cantidad', 'unidad', 'firma', 'observaciones'];
const OBLIGATORIOS = { numero: 'N.º remisión', proveedor: 'proveedor', placa: 'placa', material: 'material', cantidad: 'cantidad', fecha: 'fecha' };

let S = leerLS('cv_sesion') || null;   // {token, nombre, rol}
let actual = null;                     // ítem de la cola que se está editando
let enviando = false;

/* ---------------- utilidades ---------------- */
function leerLS(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function guardarLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fechaCO = iso => iso ? String(iso).split('-').reverse().join('/') : '—';
const hoyISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function estado(el, msg, err) { el.textContent = msg || ''; el.classList.toggle('err', !!err); }
let tToast;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(tToast); tToast = setTimeout(() => { t.hidden = true; }, 4500); }
const claseEstado = e => !e ? '' : e === 'En revisión' ? 'warn' : e === 'No cuenta' ? 'gris' : e.indexOf('Válida') === 0 ? 'ok' : '';
function chipEstado(e) {
  if (!e) return '<span class="chip">Sin estado</span>';
  return `<span class="chip ${claseEstado(e)}">${esc(e)}</span>`;
}
const fmtVol = n => Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 1 });
function marcador(el, n) { el.textContent = n > 99 ? '99+' : String(n || ''); el.hidden = !n; }
let nCola = 0, nRevision = 0;

/* ---------------- servidor ---------------- */
async function api(accion, datos) {
  if (!CONFIG.SERVIDOR || CONFIG.SERVIDOR.indexOf('http') !== 0) throw { error: 'config', mensaje: 'Falta la dirección del servidor en config.js.' };
  let r;
  try {
    // Sin encabezados propios: así el navegador no hace la consulta previa (CORS) que Apps Script no responde.
    r = await fetch(CONFIG.SERVIDOR, { method: 'POST', body: JSON.stringify(Object.assign({ accion, token: S && S.token }, datos)) });
  } catch (e) {
    throw { error: 'red', mensaje: 'Sin conexión con el servidor.' };
  }
  if (!r.ok) throw { error: 'red', mensaje: `El servidor respondió ${r.status}.` };
  let j;
  try { j = await r.json(); } catch (e) { throw { error: 'servidor', mensaje: 'El servidor respondió algo inesperado. Intenta de nuevo en un momento.' }; }
  if (j.error === 'sesion') { salir(); throw j; }
  return j;
}

/* ---------------- cola en el celular (IndexedDB) ---------------- */
let dbP;
function db() {
  if (!dbP) dbP = new Promise((ok, mal) => {
    const rq = indexedDB.open('control-volquetas', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('cola', { keyPath: 'id' });
    rq.onsuccess = () => ok(rq.result);
    rq.onerror = () => mal(rq.error);
  });
  return dbP;
}
async function tx(modo, fn) {
  const d = await db();
  return new Promise((ok, mal) => {
    const t = d.transaction('cola', modo), st = t.objectStore('cola');
    const rq = fn(st);
    t.oncomplete = () => ok(rq && rq.result);
    t.onerror = () => mal(t.error);
  });
}
const colaPut = it => tx('readwrite', st => st.put(it));
const colaDel = id => tx('readwrite', st => st.delete(id));
const colaTodas = () => tx('readonly', st => st.getAll());

/* ---------------- ingreso ---------------- */
$('#obraLogin').textContent = CONFIG.OBRA && CONFIG.OBRA !== 'Nombre de la obra' ? CONFIG.OBRA : 'Registro de remisiones';
$('#fLogin').onsubmit = async e => {
  e.preventDefault();
  const pin = $('#pin').value.trim();
  if (!pin) return estado($('#stLogin'), 'Escribe tu PIN.', true);
  $('#btnEntrar').disabled = true;
  estado($('#stLogin'), 'Verificando…');
  try {
    const j = await api('login', { pin });
    if (!j.ok) throw j;
    S = { token: j.token, nombre: j.nombre, rol: j.rol, permisos: j.permisos };
    guardarLS('cv_sesion', S);
    $('#pin').value = '';
    iniciar();
  } catch (err) {
    estado($('#stLogin'), err.mensaje || 'No se pudo entrar.', true);
  } finally {
    $('#btnEntrar').disabled = false;
  }
};
$('#btnSalir').onclick = () => salir();
function salir() {
  S = null;
  guardarLS('cv_sesion', null);
  $('#v-app').hidden = true;
  $('#v-login').hidden = false;
}

/* ---------------- pestañas ---------------- */
document.querySelectorAll('.tabbar button').forEach(b => { b.onclick = () => ver(b.dataset.v); });
function ver(v) {
  document.querySelectorAll('.tabbar button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.v === v)));
  ['capturar', 'pendientes', 'registro', 'revision', 'placas'].forEach(x => { $('#v-' + x).hidden = x !== v; });
  window.scrollTo({ top: 0 });
  if (v === 'capturar' && !actual) actualizarHoy();
  if (v === 'pendientes') pintarPendientes();
  if (v === 'registro') cargarRegistro();
  if (v === 'revision') cargarRevision();
  if (v === 'placas') pintarPlacas();
}

/* ---------------- permisos del rol ---------------- */
// Sesiones viejas (v1.1) no traen permisos: se deducen del rol hasta que el servidor responda.
function puede(k) {
  if (!S) return false;
  const p = S.permisos || (S.rol === 'residente'
    ? { fotos: true, registro: true, revisar: true, placas: true }
    : { fotos: true, registro: true, revisar: false, placas: false });
  return !!p[k];
}
function aplicarPermisos() {
  document.querySelectorAll('.tabbar button').forEach(b => { b.hidden = !puede(b.dataset.perm); });
  $('#inicio .stats').hidden = !puede('registro');
  const activa = document.querySelector('.tabbar button[aria-selected="true"]');
  if (!activa || activa.hidden) {
    const primera = [...document.querySelectorAll('.tabbar button')].find(b => !b.hidden);
    if (primera) ver(primera.dataset.v);
  }
  pintarAvisos();
}

/* ---------------- inicio: resumen del día y avisos ---------------- */
function modoCaptura(on) {
  $('#inicio').hidden = on;
  $('#pFoto').hidden = !on;
  if (!on) { $('#form').hidden = true; $('#pDup').hidden = true; }
}
function calcularHoy(rems) {
  const h = hoyISO();
  const v = rems.filter(r => r.fecha === h && String(r.estado || '').indexOf('Válida') === 0);
  const vol = v.filter(r => /^m3$/i.test(r.unidad || 'm3')).reduce((s, r) => s + Number(r.cantidad || 0), 0);
  return { fecha: h, viajes: v.length, vol };
}
function pintarHoy(x) {
  const ok = x && x.fecha === hoyISO();
  $('#sViajes').textContent = ok ? String(x.viajes) : '—';
  $('#sVol').textContent = ok ? fmtVol(x.vol) + ' m³' : '—';
}
async function actualizarHoy() {
  pintarHoy(leerLS('cv_hoy'));
  pintarAvisos();
  if (!navigator.onLine || !S || !puede('registro')) return;
  try {
    const j = await api('listar', {});
    if (j.ok) { const x = calcularHoy(j.remisiones); guardarLS('cv_hoy', x); pintarHoy(x); }
  } catch (e) { /* queda el último resumen guardado */ }
}
function pintarAvisos() {
  const a = [];
  if (nCola) a.push(`<button class="aviso" data-ir="pendientes"><svg class="ico peq"><use href="#i-reloj"/></svg><span>${nCola} ${nCola === 1 ? 'foto' : 'fotos'} en este celular sin enviar</span>›</button>`);
  if (S && puede('revisar') && nRevision) a.push(`<button class="aviso" data-ir="revision"><svg class="ico peq"><use href="#i-alerta"/></svg><span>${nRevision} ${nRevision === 1 ? 'remisión' : 'remisiones'} por revisar</span>›</button>`);
  $('#avisos').innerHTML = a.join('');
}
$('#avisos').onclick = e => { const b = e.target.closest('[data-ir]'); if (b) ver(b.dataset.ir); };
$('#btnInicio').onclick = () => limpiar();

/* ---------------- foto ---------------- */
$('#foto').onchange = e => nuevaFoto(e.target.files[0]);
$('#fotoGaleria').onchange = e => nuevaFoto(e.target.files[0]);

async function nuevaFoto(file) {
  if (!file) return;
  // Si la foto anterior no se alcanzó a leer, la nueva la reemplaza (no queda basura en Pendientes).
  const previa = actual;
  actual = null;
  ver('capturar');
  modoCaptura(true);
  $('#form').hidden = true; $('#pDup').hidden = true;
  $('#drop').innerHTML = '';
  estado($('#stCap'), 'Preparando la foto…');
  try {
    if (previa && previa.estado === 'sin_leer' && !previa.datos) await colaDel(previa.id);
    const [imagen, hash] = await Promise.all([comprimir(file), huella(file)]);
    const calidad = await revisarCalidad(imagen);
    const it = { id: uuid(), creado: new Date().toISOString(), imagen, hash, estado: 'sin_leer', calidad: calidad.problemas };
    await colaPut(it);
    abrir(it);
    contarPendientes();
    if (calidad.problemas.length) return pintarRepetir(it, 'La foto ' + calidad.problemas.join(' y ') + '. Tómala otra vez: recibo completo, de frente, con buena luz y el celular quieto.', true);
    if (navigator.onLine) leerItem(it);
    else estado($('#stCap'), 'Sin señal: la foto quedó guardada en Pendientes y se leerá sola cuando vuelva la señal. Si prefieres, llena los datos a mano.');
  } catch (err) {
    estado($('#stCap'), 'No se pudo procesar la foto. Intenta con otra.', true);
  } finally {
    $('#foto').value = ''; $('#fotoGaleria').value = '';
  }
}

async function comprimir(file, max = 1600, q = 0.8) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}

/* Revisa la foto en el celular, sin gastar lecturas: oscura, quemada, borrosa o pequeña.
 * Nitidez = varianza del laplaciano sobre la imagen en gris reducida a 640 px. */
const CALIDAD = { LUZ_MIN: 70, LUZ_MAX: 245, NITIDEZ_MIN: 90, LADO_MIN: 700 };
async function revisarCalidad(dataUrl) {
  const problemas = [];
  try {
    const img = new Image();
    await new Promise((ok, mal) => { img.onload = ok; img.onerror = mal; img.src = dataUrl; });
    if (Math.min(img.width, img.height) < CALIDAD.LADO_MIN) problemas.push('tiene muy poca resolución');
    const k = Math.min(1, 640 / Math.max(img.width, img.height));
    const w = Math.max(8, Math.round(img.width * k)), h = Math.max(8, Math.round(img.height * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, w, h);
    const px = cx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    let suma = 0;
    for (let i = 0; i < w * h; i++) { g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]; suma += g[i]; }
    const luz = suma / (w * h);
    let n = 0, m = 0, m2 = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
      n++; m += l; m2 += l * l;
    }
    const nitidez = n ? m2 / n - (m / n) ** 2 : 0;
    if (luz < CALIDAD.LUZ_MIN) problemas.push('está muy oscura');
    else if (luz > CALIDAD.LUZ_MAX) problemas.push('tiene demasiada luz o reflejo');
    if (nitidez < CALIDAD.NITIDEZ_MIN) problemas.push('está borrosa o movida');
    return { problemas, luz: Math.round(luz), nitidez: Math.round(nitidez) };
  } catch (e) {
    return { problemas };   // si el navegador no deja analizarla, no se frena el trabajo
  }
}

/* La foto no sirve: pide repetirla. "Usar esta" solo se ofrece cuando el aviso viene del celular,
 * porque si Gemini ya dijo que no se lee, insistir solo gasta lecturas. */
function pintarRepetir(it, mensaje, permitirUsar) {
  if (!actual || actual.id !== it.id) return;
  $('#form').hidden = true;
  const st = $('#stCap');
  st.classList.remove('err');
  st.innerHTML = `<div class="repetir" role="alert"><p>${esc(mensaje)}</p>
    <label class="btn primary grande" for="foto"><svg class="ico"><use href="#i-camara"/></svg>Tomar otra foto</label>
    <div class="grid">${permitirUsar ? '<button class="btn" type="button" id="btnUsarIgual">Usar esta foto</button>' : ''}
      <button class="btn" type="button" id="btnManual">Llenar a mano</button></div></div>`;
  if (permitirUsar) $('#btnUsarIgual').onclick = () => {
    it.calidad = []; colaPut(it);
    if (navigator.onLine) leerItem(it);
    else estado($('#stCap'), 'Sin señal: la foto quedó en Pendientes y se leerá sola cuando vuelva la señal.');
  };
  $('#btnManual').onclick = () => llenarAMano();
}
function llenarAMano() {
  actual.datos = {}; actual.dudosos = []; actual.estado = 'por_revisar'; actual.calidad = [];
  colaPut(actual); estado($('#stCap'), ''); mostrarFormulario(actual);
}

async function huella(file) {
  const h = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- ítem en edición ---------------- */
function abrir(it) {
  actual = it;
  ver('capturar');
  modoCaptura(true);
  $('#drop').innerHTML = `<img src="${it.imagen}" alt="Foto de la remisión"><span>Toca la foto para tomar otra</span>`;
  $('#pDup').hidden = true;
  if (it.estado === 'sin_leer') {
    $('#form').hidden = true;
    if (it.repetir) pintarRepetir(it, it.repetir, false);
    else if (it.calidad && it.calidad.length) pintarRepetir(it, 'La foto ' + it.calidad.join(' y ') + '. Tómala otra vez: recibo completo, de frente, con buena luz y el celular quieto.', true);
    else pintarBotonesSinLeer();
  } else if (it.estado === 'requiere_decision') {
    mostrarDuplicado(it);
  } else {
    mostrarFormulario(it);
  }
}

function pintarBotonesSinLeer(mensaje) {
  const st = $('#stCap');
  st.innerHTML = mensaje ? `<p class="status err">${esc(mensaje)}</p>` : '';
  st.classList.remove('err');
  const fila = document.createElement('div');
  fila.className = 'grid';
  fila.innerHTML = `<button class="btn primary grande" type="button" id="btnLeer">Leer recibo</button>
    <button class="btn" type="button" id="btnManual">Llenar a mano</button>`;
  st.appendChild(fila);
  $('#btnLeer').onclick = () => leerItem(actual);
  $('#btnManual').onclick = () => llenarAMano();
}

/* Lee la foto en el servidor. Devuelve 'ok' | 'duplicada' | 'repetir' | 'limite' | 'red' | 'error'.
 * auto = lectura sola al volver la señal (no toca la pantalla salvo que esa foto esté abierta). */
/* Mientras Gemini lee, siempre se puede pasar a llenar a mano; la lectura que llegue después se ignora. */
function pintarLeyendo(it, msg) {
  const st = $('#stCap');
  st.classList.remove('err');
  st.innerHTML = `<p class="status">${esc(msg)}</p>
    <button class="btn" type="button" id="btnManualYa">Llenar a mano (no esperar)</button>`;
  $('#btnManualYa').onclick = () => { it.manual = true; llenarAMano(); };
}

async function leerItem(it, auto) {
  it.manual = false;
  const enPantalla = () => actual && actual.id === it.id && !it.manual;
  if (enPantalla()) pintarLeyendo(it, 'Leyendo el recibo… puede tardar entre 10 y 40 segundos.');
  try {
    const j = await leerEnServidor(it, enPantalla);
    if (it.manual) return 'manual';
    if (j.fotoDuplicada) {
      it.estado = 'requiere_decision';
      it.duplicado = j.fotoDuplicada;
      it.fotoRepetida = true;
      await colaPut(it);
      if (enPantalla()) mostrarDuplicado(it);
      return 'duplicada';
    }
    if (!j.ok) throw j;
    Object.assign(it, { datos: j.datos, original: j.datos, dudosos: j.dudosos || [], alertasLectura: j.alertasLectura || [],
      controles: j.controles, leidoIA: true, estado: 'por_revisar', repetir: null });
    await colaPut(it);
    if (enPantalla()) { estado($('#stCap'), 'Listo. Revisa los datos contra el papel.'); mostrarFormulario(it); }
    return 'ok';
  } catch (err) {
    if (it.manual) return 'manual';
    if (err.error === 'repetir' || err.error === 'no_remision') {
      it.repetir = err.mensaje;
      await colaPut(it);
      if (enPantalla()) pintarRepetir(it, err.mensaje, false);
      return 'repetir';
    }
    if (enPantalla()) pintarBotonesSinLeer((err.mensaje || 'No se pudo leer.') + (err.error === 'red' ? ' La foto quedó en Pendientes.' : ''));
    return err.error === 'ia_limite' ? 'limite' : err.error === 'red' ? 'red' : err.error === 'ia_demorada' || err.error === 'ia_ocupada' ? 'limite' : 'error';
  }
}

/* El iPhone deja de esperar a ~1 min, pero el servidor sigue leyendo hasta terminar.
   Por eso cada lectura lleva un número de trabajo: si la espera se corta o se alarga, la app
   le pregunta al servidor cada 5 s por ese trabajo hasta tener el resultado. */
const LECTURA = { ESPERA_DIRECTA: 40000, CADA: 5000, MAXIMO: 390000 };
const pausa = ms => new Promise(ok => setTimeout(ok, ms));

async function leerEnServidor(it, enPantalla) {
  const trabajo = String(it.id).replace(/[^A-Za-z0-9-]/g, '').slice(0, 50) + '-' + Date.now();
  const inicio = Date.now();
  let fin = null;   // { j } o { err }
  const directo = api('leer', { imagen: it.imagen, hash: it.hash, trabajo })
    .then(j => { fin = { j }; }, err => { fin = { err }; });
  await Promise.race([directo, pausa(LECTURA.ESPERA_DIRECTA)]);
  let desconocido = 0, sinRed = 0;
  while (true) {
    if (fin && fin.j) return fin.j;
    if (fin && fin.err && fin.err.error !== 'red') throw fin.err;
    if (Date.now() - inicio > LECTURA.MAXIMO) {
      throw { error: 'ia_demorada', mensaje: 'Gemini está demorado y no respondió. Llena los datos a mano o intenta en unos minutos.' };
    }
    if (enPantalla()) {
      const s = Math.round((Date.now() - inicio) / 1000);
      pintarLeyendo(it, `Sigue leyendo (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})… Gemini está tardando más de lo normal. No cierres la app.`);
    }
    await pausa(LECTURA.CADA);
    if (fin && fin.j) return fin.j;
    let r;
    try { r = await api('resultado', { trabajo }); sinRed = 0; }
    catch (err) {
      if (err.error === 'accion_desconocida') { await directo; continue; }   // servidor viejo: solo queda esperar
      if (err.error !== 'red') throw err;
      if (++sinRed >= 3) throw err;           // de verdad no hay señal: queda en Pendientes
      continue;
    }
    if (r.estado === 'listo') { if (!r.respuesta.ok && !r.respuesta.fotoDuplicada) throw r.respuesta; return r.respuesta; }
    if (r.estado === 'desconocido' && fin && fin.err && ++desconocido >= 2) throw fin.err;   // la foto nunca llegó al servidor
  }
}

function mostrarFormulario(it) {
  $('#form').hidden = false;
  $('#pDup').hidden = true;
  const d = it.datos || {};
  CAMPOS.forEach(k => {
    let v = d[k];
    if (k === 'unidad') v = v || 'm3';
    if (k === 'firma') v = v || 'si';
    if (k === 'fecha') v = v || hoyISO();
    $('#' + k).value = v ?? '';
    $('#' + k).closest('.f').classList.toggle('dudoso', (it.dudosos || []).indexOf(k) >= 0);
  });
  // "Más datos" se abre solo si ahí hay algo dudoso o una firma que revisar.
  $('#masDatos').open = !!$('#masDatos .f.dudoso') || $('#firma').value !== 'si';
  $('#okNumero').checked = false; $('#okCantidad').checked = false;
  pintarConfirma();
  pintarAlertas();
  $('#form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function leerFormulario() {
  const d = {};
  CAMPOS.forEach(k => { d[k] = $('#' + k).value.trim(); });
  d.placa = d.placa.toUpperCase();
  d.cantidad = d.cantidad === '' ? null : Number(d.cantidad);
  return d;
}

$('#form').addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'okNumero' || id === 'okCantidad') return pintarConfirma();
  const f = e.target.closest('.f');
  if (f) f.classList.remove('dudoso');
  // Si cambian el N.º o la cantidad, hay que volver a confirmarlos contra el papel.
  if (id === 'numero') $('#okNumero').checked = false;
  if (id === 'cantidad' || id === 'unidad') $('#okCantidad').checked = false;
  pintarConfirma();
  pintarAlertas();
});

/* Confirmación obligatoria: N.º y cantidad son los que, si están mal, se pagan mal. */
function pintarConfirma() {
  const n = $('#numero').value.trim(), c = $('#cantidad').value.trim();
  $('#cNumero').textContent = n || '—';
  $('#cCantidad').textContent = c ? `${fmt(c)} ${$('#unidad').value}` : '—';
  const listo = $('#okNumero').checked && $('#okCantidad').checked;
  $('#confirma').classList.toggle('listo', listo);
  if (listo && /casillas/.test($('#stForm').textContent)) estado($('#stForm'), '');
  $('#btnGuardar').textContent = listo ? 'Guardar remisión' : 'Confirma N.º y cantidad para guardar';
}

function pintarAlertas() {
  if (!actual) return;
  const d = leerFormulario();
  const lista = (actual.alertasLectura || []).map(t => ({ t: 'Lectura: ' + t }));
  const faltan = Object.keys(OBLIGATORIOS).filter(k => d[k] === null || d[k] === '');
  if (faltan.length) lista.push({ t: 'Faltan: ' + faltan.map(k => OBLIGATORIOS[k]).join(', ') + '.', bad: true });
  const c = actual.controles;
  if (c && c.duplicado) lista.push({ t: `Remisión duplicada: la N.º ${c.duplicado.numero} ya se registró el ${c.duplicado.registrado}.`, bad: true });
  if (c && c.probable) lista.push({ t: `Posible duplicado de la remisión ${c.probable.numero} (misma placa, día, material y cantidad).`, bad: true });
  if (c && c.excede) lista.push({ t: c.excede, bad: true });
  if (d.firma === 'no') lista.push({ t: 'Sin firma de recibido.', bad: true });
  if (!d.hora) lista.push({ t: 'El recibo no tiene hora.' });
  $('#alertas').innerHTML = lista.map(x => `<li class="${x.bad ? 'bad' : ''}">${esc(x.t)}</li>`).join('');
}

$('#form').onsubmit = async e => {
  e.preventDefault();
  if (!actual) return;
  const d = leerFormulario();
  if (!d.numero || !d.proveedor || d.cantidad === null) return estado($('#stForm'), 'Completa al menos N.º de remisión, proveedor y cantidad.', true);
  if (!$('#okNumero').checked || !$('#okCantidad').checked) {
    $('#confirma').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return estado($('#stForm'), 'Compara con el papel y marca las dos casillas: N.º y cantidad.', true);
  }
  actual.datos = d;
  actual.auto = false;
  actual.corregidos = actual.original ? CAMPOS.filter(k => String(actual.original[k] ?? '') !== String(d[k] ?? '')) : [];
  actual.estado = 'por_enviar';
  await colaPut(actual);
  contarPendientes();
  enviarItem(actual, true);
};

$('#btnDescartar').onclick = async () => {
  if (!actual) return;
  if ($('#btnDescartar').dataset.confirmar !== '1') {
    $('#btnDescartar').dataset.confirmar = '1';
    $('#btnDescartar').textContent = '¿Seguro? Toca otra vez para descartar';
    return;
  }
  await colaDel(actual.id);
  limpiar();
  toast('Foto descartada.');
};

function limpiar() {
  actual = null;
  modoCaptura(false);
  $('#drop').innerHTML = '';
  $('#masDatos').open = false;
  $('#btnDescartar').dataset.confirmar = '';
  $('#btnDescartar').textContent = 'Descartar';
  estado($('#stCap'), ''); estado($('#stForm'), ''); estado($('#stDup'), '');
  $('#explicacion').value = '';
  $('#dupExplica').hidden = true;
  contarPendientes();
  actualizarHoy();
  window.scrollTo({ top: 0 });
}

/* ---------------- envío ---------------- */
async function enviarItem(it, enPantalla, callado) {
  const st = enPantalla ? $('#stForm') : null;
  if (st) estado(st, 'Guardando…');
  try {
    const j = await api('guardar', {
      id: it.id, datos: it.datos, imagen: it.imagen, hash: it.hash, leidoIA: !!it.leidoIA,
      corregidos: it.corregidos || [], alertasLectura: it.alertasLectura || [],
      decision: it.decision || null, explicacion: it.explicacion || '', auto: !!it.auto
    });
    if (j.ok) {
      await colaDel(it.id);
      const msg = j.estado === 'En revisión'
        ? `Remisión ${it.datos.numero} guardada EN REVISIÓN: ${j.motivo}. No suma hasta que el residente decida.`
        : `Remisión ${it.datos.numero} guardada.`;
      if (actual && actual.id === it.id) limpiar();
      if (!callado) toast(msg);
      return true;
    }
    if (j.error === 'requiere_decision' || j.error === 'foto_duplicada' || j.error === 'falta_explicacion') {
      it.estado = 'requiere_decision';
      it.duplicado = j.duplicado;
      it.fotoRepetida = j.error === 'foto_duplicada';
      await colaPut(it);
      if (enPantalla || (actual && actual.id === it.id)) mostrarDuplicado(it);
      else toast(`La remisión ${it.datos.numero} está repetida. Revísala en Pendientes.`);
      return false;
    }
    throw j;
  } catch (err) {
    if (err.error === 'red') {
      if (st) { limpiar(); toast('Sin señal: la remisión quedó en Pendientes y se enviará sola cuando vuelva la señal.'); }
    } else if (st) {
      estado(st, err.mensaje || 'No se pudo guardar.', true);
    }
    return false;
  }
}

async function enviarCola() {
  if (enviando || !S || !navigator.onLine) return;
  enviando = true;
  try {
    // 1. Fotos tomadas sin señal: se leen solas y se guardan EN REVISIÓN, porque nadie las comparó con el papel.
    //    Solo un intento automático por foto; si no se lee, queda en Pendientes pidiendo repetirla.
    let leidas = 0, enRevision = 0;
    if (puede('fotos')) {
      const sinLeer = (await colaTodas()).filter(it => it.estado === 'sin_leer' && !it.autoIntentado && !(it.calidad && it.calidad.length) &&
        (!actual || actual.id !== it.id));
      for (const it of sinLeer) {
        it.autoIntentado = true;
        await colaPut(it);
        const r = await leerItem(it, true);
        if (r === 'limite' || r === 'red') { it.autoIntentado = false; await colaPut(it); break; }
        if (r !== 'ok') continue;
        leidas++;
        it.auto = true;
        it.estado = 'por_enviar';
        await colaPut(it);
      }
    }
    // 2. Envío de lo que está listo
    const items = (await colaTodas()).filter(it => it.estado === 'por_enviar' && (!actual || actual.id !== it.id));
    for (const it of items) {
      const ok = await enviarItem(it, false, !!it.auto);
      if (ok && it.auto) enRevision++;
      if (!ok && !navigator.onLine) break;
    }
    if (leidas) toast(leidas === 1
      ? 'Una foto tomada sin señal se leyó sola' + (enRevision ? ' y quedó EN REVISIÓN: no suma hasta que el residente la compare con el papel.' : '. Revísala en Pendientes.')
      : `${leidas} fotos tomadas sin señal se leyeron solas` + (enRevision ? ` y ${enRevision} quedaron EN REVISIÓN: no suman hasta que el residente las compare con el papel.` : '. Revísalas en Pendientes.'));
  } finally {
    enviando = false;
    contarPendientes();
    if (!$('#v-pendientes').hidden) pintarPendientes();
  }
}

/* ---------------- duplicados ---------------- */
async function mostrarDuplicado(it) {
  actual = it;
  $('#form').hidden = true;
  $('#pDup').hidden = false;
  const v = it.duplicado || {};
  $('#dupTexto').innerHTML = it.fotoRepetida
    ? `<b>Esta misma foto ya se registró</b> como la remisión N.º ${esc(v.numero)} de ${esc(v.proveedor)} (${fechaCO(v.fecha)}, cargada por ${esc(v.registro)} el ${esc(v.registrado)}).`
    : `Ya existe la remisión <b>N.º ${esc(v.numero)}</b> de ${esc(v.proveedor)}: ${fmt(v.cantidad)} ${esc(v.unidad)} de ${esc(v.material)}, placa ${esc(v.placa)}, cargada por ${esc(v.registro)} el ${esc(v.registrado)}. Si es el mismo papel, contarlo otra vez sería pagar dos veces el mismo viaje.`;
  $('#btnDupDistinto').hidden = !!it.fotoRepetida;
  $('#dupExplica').hidden = true;
  $('#dupImgNueva').src = it.imagen;
  $('#dupImgVieja').removeAttribute('src');
  $('#dupCapVieja').textContent = 'Ya registrada (cargando foto…)';
  $('#pDup').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const f = v.id && v.tieneFoto ? await api('foto', { id: v.id }) : null;
    if (f && f.imagen) $('#dupImgVieja').src = f.imagen;
    $('#dupCapVieja').textContent = f && f.imagen ? 'Ya registrada' : 'Ya registrada (sin foto)';
  } catch (e) {
    $('#dupCapVieja').textContent = 'Ya registrada (no se pudo cargar la foto)';
  }
}
$('#btnDupMismo').onclick = async () => {
  if (!actual) return;
  await colaDel(actual.id);
  limpiar();
  toast('No se guardó: era el mismo recibo.');
};
$('#btnDupDistinto').onclick = () => { $('#dupExplica').hidden = false; $('#explicacion').focus(); };
$('#btnDupEnviar').onclick = async () => {
  const exp = $('#explicacion').value.trim();
  if (!exp) return estado($('#stDup'), 'Escribe por qué es un recibo distinto.', true);
  actual.decision = 'distinto';
  actual.explicacion = exp;
  actual.estado = 'por_enviar';
  await colaPut(actual);
  estado($('#stDup'), 'Enviando a revisión…');
  const ok = await enviarItem(actual, false);
  if (!ok) {
    if (navigator.onLine) estado($('#stDup'), 'No se pudo enviar. Intenta de nuevo.', true);
    else estado($('#stDup'), 'Sin señal: quedó en Pendientes y se enviará sola.');
  }
};
$('#dupImgNueva').onclick = e => ampliar(e.target.src);
$('#dupImgVieja').onclick = e => ampliar(e.target.src);

/* ---------------- pendientes ---------------- */
async function contarPendientes() {
  try {
    nCola = (await colaTodas()).length;
    marcador($('#nPend'), nCola);
    pintarAvisos();
  } catch (e) { /* sin IndexedDB */ }
}

async function pintarPendientes() {
  const items = (await colaTodas()).sort((a, b) => a.creado.localeCompare(b.creado));
  const box = $('#listaPend');
  if (!items.length) { box.innerHTML = '<div class="empty">No hay nada pendiente en este celular.</div>'; return; }
  const txt = { repetir: 'Repetir foto', sin_leer: 'Sin leer', por_revisar: 'Por revisar', por_enviar: 'Por enviar', requiere_decision: 'Repetida: decidir' };
  const cls = { repetir: 'bad', sin_leer: 'warn', por_revisar: 'warn', por_enviar: '', requiere_decision: 'bad' };
  const clave = it => it.estado === 'sin_leer' && (it.repetir || (it.calidad && it.calidad.length)) ? 'repetir' : it.estado;
  box.innerHTML = items.map(it => {
    const d = it.datos || {};
    return `<article class="card">
      <img class="thumb" src="${it.imagen}" alt="">
      <div class="main"><span class="num">${d.numero ? 'N.º ' + esc(d.numero) : 'Sin datos'} · tomada ${new Date(it.creado).toLocaleString('es-CO')}</span>
        <div class="meta">${esc(d.material || '')} ${d.proveedor ? '· ' + esc(d.proveedor) : ''}</div></div>
      <span class="chip ${cls[clave(it)] || ''}">${txt[clave(it)] || it.estado}</span>
      <div class="full"><button class="btn" data-abrir="${it.id}">Abrir</button></div>
    </article>`;
  }).join('');
}
$('#listaPend').onclick = async e => {
  const id = e.target.dataset.abrir;
  if (!id) return;
  const it = (await colaTodas()).find(x => x.id === id);
  if (it) abrir(it);
};

/* ---------------- registro ---------------- */
$('#btnActualizar').onclick = () => cargarRegistro();
async function cargarRegistro() {
  estado($('#stReg'), 'Cargando…');
  try {
    const j = await api('listar', {});
    if (!j.ok) throw j;
    estado($('#stReg'), '');
    const x = calcularHoy(j.remisiones);
    guardarLS('cv_hoy', x); pintarHoy(x);
    $('#regResumen').textContent = `Hoy: ${x.viajes} ${x.viajes === 1 ? 'viaje válido' : 'viajes válidos'} · ${fmtVol(x.vol)} m³. Abajo, las últimas ${j.remisiones.length} remisiones.`;
    $('#listaReg').innerHTML = j.remisiones.length ? j.remisiones.map(tarjeta).join('') :
      '<div class="empty">Aún no hay remisiones. Toca Foto y fotografía el primer recibo.</div>';
  } catch (err) {
    estado($('#stReg'), err.mensaje || 'No se pudo cargar el registro.', true);
  }
}
function tarjeta(r) {
  return `<article class="reg ${claseEstado(r.estado)}">
    <div class="linea"><span class="num">N.º ${esc(r.numero)}</span>${chipEstado(r.estado)}</div>
    <div class="linea"><b>${esc(r.material || '—')}</b><span class="qty">${fmt(r.cantidad)} <small>${esc(r.unidad)}</small></span></div>
    <div class="meta">${esc(r.proveedor)} · placa ${esc(r.placa)} · ${fechaCO(r.fecha)}${r.hora ? ' ' + esc(r.hora) : ''}</div>
    <div class="meta">Registró ${esc(r.registro)}${r.tieneFoto ? '' : ' · sin foto'}</div>
    ${r.motivo ? `<ul class="alerts"><li class="${r.estado === 'En revisión' ? '' : 'bad'}">${esc(r.motivo)}</li></ul>` : ''}
  </article>`;
}

/* ---------------- revisión (residente) ---------------- */
async function cargarRevision() {
  estado($('#stRev'), 'Cargando…');
  try {
    const j = await api('revision', {});
    if (!j.ok) throw j;
    nRevision = j.pendientes.length;
    marcador($('#nRev'), nRevision);
    pintarAvisos();
    estado($('#stRev'), '');
    const box = $('#listaRev');
    if (!j.pendientes.length) { box.innerHTML = '<div class="empty">No hay remisiones pendientes de revisión.</div>'; return; }
    box.innerHTML = j.pendientes.map(r => `<article class="reg warn">
      <div class="linea"><span class="num">N.º ${esc(r.numero)}</span>${chipEstado(r.estado)}</div>
      <div class="linea"><b>${esc(r.material || '—')}</b><span class="qty">${fmt(r.cantidad)} <small>${esc(r.unidad)}</small></span></div>
      <div class="meta">${esc(r.proveedor)} · placa ${esc(r.placa)} · ${fechaCO(r.fecha)}${r.hora ? ' ' + esc(r.hora) : ''}</div>
      <div class="meta">Registró ${esc(r.registro)}</div>
      <div class="card-cuerpo">
        <ul class="alerts"><li class="bad">${esc(r.motivo)}</li>${r.explicacion ? `<li>Explicación del encargado: ${esc(r.explicacion)}</li>` : ''}</ul>
        <div class="compara">
          <figure><img data-foto="${esc(r.id)}" alt="Remisión en revisión"><figcaption>En revisión: N.º ${esc(r.numero)}</figcaption></figure>
          ${r.relacionado ? `<figure><img data-foto="${esc(r.relacionado.id)}" alt="Remisión relacionada"><figcaption>Ya registrada: N.º ${esc(r.relacionado.numero)} · ${fmt(r.relacionado.cantidad)} ${esc(r.relacionado.unidad)} · ${esc(r.relacionado.registrado)} · ${esc(r.relacionado.estado)}</figcaption></figure>` : '<figure><figcaption>Sin remisión relacionada (revisión por capacidad).</figcaption></figure>'}
        </div>
        <div class="f"><label for="nota-${esc(r.id)}">Nota de revisión</label><input id="nota-${esc(r.id)}" placeholder="Ej.: confirmado con el proveedor"></div>
        <div class="grid">
          <button class="btn primary" data-decidir="contar" data-id="${esc(r.id)}">Contar</button>
          <button class="btn bad" data-decidir="no_contar" data-id="${esc(r.id)}">No contar</button>
        </div>
      </div>
    </article>`).join('');
    box.querySelectorAll('img[data-foto]').forEach(cargarFoto);
  } catch (err) {
    estado($('#stRev'), err.mensaje || 'No se pudo cargar la revisión.', true);
  }
}
async function cargarFoto(img) {
  try {
    const f = await api('foto', { id: img.dataset.foto });
    if (f.imagen) { img.src = f.imagen; img.onclick = () => ampliar(f.imagen); }
  } catch (e) { /* queda sin imagen */ }
}
$('#listaRev').onclick = async e => {
  const b = e.target.closest('[data-decidir]');
  if (!b) return;
  b.disabled = true;
  try {
    const j = await api('decidir', { id: b.dataset.id, decision: b.dataset.decidir, nota: ($('#nota-' + CSS.escape(b.dataset.id)) || {}).value || '' });
    if (!j.ok) throw j;
    toast(b.dataset.decidir === 'contar' ? 'Marcada para contar.' : 'Marcada como NO cuenta.');
    cargarRevision();
  } catch (err) {
    b.disabled = false;
    estado($('#stRev'), err.mensaje || 'No se pudo guardar la decisión.', true);
  }
};

/* ---------------- varios ---------------- */
function ampliar(src) { if (!src) return; $('#ovImg').src = src; $('#ov').hidden = false; }
$('#ovCerrar').onclick = () => { $('#ov').hidden = true; };
$('#ov').onclick = e => { if (e.target.id === 'ov') $('#ov').hidden = true; };

function pintarRed() {
  const r = $('#red');
  r.textContent = navigator.onLine ? 'En línea' : 'Sin señal';
  r.className = 'red' + (navigator.onLine ? '' : ' off');
}
window.addEventListener('online', () => { pintarRed(); enviarCola(); });
window.addEventListener('offline', pintarRed);

/* ---------------- placas (roles con permiso "Editar placas") ---------------- */
let placaEditando = null;
function pintarPlacas() {
  const lista = ((catalogo && catalogo.placas) || []).slice().sort((a, b) => a.placa.localeCompare(b.placa));
  const sinCap = lista.filter(p => !(p.capacidad > 0)).length;
  $('#plConteo').textContent = lista.length
    ? `Placas registradas (${lista.length})${sinCap ? ` · ${sinCap} sin capacidad` : ''}` : 'Placas registradas';
  $('#listaPlacas').innerHTML = lista.length ? lista.map(p => `<article class="reg ${p.capacidad > 0 ? 'ok' : 'warn'}">
      <div class="linea"><span class="num">${esc(p.placa)}</span>
        <span class="qty">${p.capacidad > 0 ? fmtVol(p.capacidad) + ' <small>m³</small>' : '<small>sin capacidad</small>'}</span></div>
      <div class="meta">${[p.tipo, p.proveedor].filter(Boolean).map(esc).join(' · ') || 'Sin tipo ni proveedor'}</div>
      <button class="btn chico" type="button" data-placa="${esc(p.placa)}">Editar</button>
    </article>`).join('')
    : '<div class="empty">Todavía no hay placas. Agrega la primera con el formulario de arriba.</div>';
}
function formPlaca(p) {
  placaEditando = p ? p.placa : null;
  $('#plTitulo').textContent = p ? `Editar placa ${p.placa}` : 'Agregar placa';
  $('#plPlaca').value = p ? p.placa : '';
  $('#plPlaca').readOnly = !!p;
  $('#plCapacidad').value = p && p.capacidad > 0 ? p.capacidad : '';
  $('#plTipo').value = p ? (p.tipo || '') : '';
  $('#plProveedor').value = p ? (p.proveedor || '') : '';
  $('#plNota').value = '';
  $('#btnPlacaNueva').hidden = !p;
  $('#btnPlacaBorrar').hidden = !p;
  $('#btnPlacaBorrar').dataset.confirmar = '';
  $('#btnPlacaBorrar').textContent = 'Quitar de la lista';
  estado($('#stPlaca'), '');
}
$('#listaPlacas').onclick = e => {
  const b = e.target.closest('[data-placa]');
  if (!b) return;
  formPlaca(((catalogo && catalogo.placas) || []).find(p => p.placa === b.dataset.placa));
  window.scrollTo({ top: 0, behavior: 'smooth' });
};
$('#btnPlacaNueva').onclick = () => formPlaca(null);
async function enviarPlaca(datos, msg) {
  if (!navigator.onLine) return estado($('#stPlaca'), 'Sin señal: las placas solo se guardan con internet.', true);
  estado($('#stPlaca'), 'Guardando…');
  try {
    const j = await api('guardarPlaca', datos);
    if (!j.ok) throw j;
    catalogo = Object.assign(catalogo || {}, { placas: j.placas });
    guardarLS('cv_catalogos', catalogo);
    pintarCatalogos(catalogo);
    formPlaca(null);
    pintarPlacas();
    toast(msg);
  } catch (err) {
    estado($('#stPlaca'), err.mensaje || 'No se pudo guardar la placa.', true);
  }
}
$('#fPlaca').onsubmit = e => {
  e.preventDefault();
  const placa = $('#plPlaca').value.trim().toUpperCase();
  const cap = Number(String($('#plCapacidad').value).replace(',', '.'));
  if (!placa) return estado($('#stPlaca'), 'Escribe la placa.', true);
  if (!(cap > 0)) return estado($('#stPlaca'), 'Escribe la capacidad en m³.', true);
  enviarPlaca({ placa, capacidad: cap, tipo: $('#plTipo').value, proveedor: $('#plProveedor').value.trim(), nota: $('#plNota').value.trim() },
    `Placa ${placa} guardada con ${fmtVol(cap)} m³.`);
};
$('#btnPlacaBorrar').onclick = () => {
  const b = $('#btnPlacaBorrar');
  if (!placaEditando) return;
  if (b.dataset.confirmar !== '1') { b.dataset.confirmar = '1'; b.textContent = '¿Seguro? Toca otra vez'; return; }
  enviarPlaca({ placa: placaEditando, eliminar: true }, `Placa ${placaEditando} quitada de la lista.`);
};

let catalogo = null;
function pintarCatalogos(c) {
  if (!c) return;
  catalogo = c;
  if (!$('#v-placas').hidden) pintarPlacas();
  $('#dlProv').innerHTML = (c.proveedores || []).map(p => `<option>${esc(p)}</option>`).join('');
  $('#dlPlacas').innerHTML = (c.placas || []).map(p => `<option>${esc(p.placa)}</option>`).join('');
  const extra = (c.materiales || []).filter(m => ![...$('#dlMat').options].some(o => o.value === m));
  $('#dlMat').insertAdjacentHTML('beforeend', extra.map(m => `<option>${esc(m)}</option>`).join(''));
  $('#lnkExcel').hidden = !c.excel; if (c.excel) $('#lnkExcel').href = c.excel;
  $('#lnkHoja').hidden = !c.hoja; if (c.hoja) $('#lnkHoja').href = c.hoja;
}

async function iniciar() {
  $('#v-login').hidden = true;
  $('#v-app').hidden = false;
  pintarQuien();
  aplicarPermisos();
  pintarRed();
  contarPendientes();
  pintarHoy(leerLS('cv_hoy'));
  pintarCatalogos(leerLS('cv_catalogos'));
  if (navigator.onLine) {
    try {
      const c = await api('catalogos', {});
      if (c.ok) {
        guardarLS('cv_catalogos', c);
        pintarCatalogos(c);
        S.rol = c.rol; S.nombre = c.nombre; if (c.permisos) S.permisos = c.permisos; guardarLS('cv_sesion', S);
        pintarQuien();
        aplicarPermisos();
      }
    } catch (e) { /* se usan los catálogos guardados */ }
    enviarCola();
    actualizarHoy();
    if (S && puede('revisar')) api('revision', {}).then(j => {
      if (j.ok) { nRevision = j.pendientes.length; marcador($('#nRev'), nRevision); pintarAvisos(); }
    }).catch(() => {});
  }
}
function pintarQuien() {
  const nombre = String(S.nombre || '').trim();
  // Se salta el título (Ing., Arq., Dr.…): "Ing Leonardo Giraldo" → "Hola, Leonardo".
  const partes = /^residente\b/i.test(nombre) ? [] : nombre.split(/\s+/);
  while (partes.length > 1 && /^(ing|arq|dr|dra|sr|sra|tec|top|lic)\.?$/i.test(partes[0])) partes.shift();
  const primer = partes[0] || '';
  $('#hola').textContent = primer ? `Hola, ${primer}` : 'Hola';
  const rol = S.rol ? S.rol.charAt(0).toUpperCase() + S.rol.slice(1) : '';
  $('#quien').textContent = [rol, CONFIG.OBRA && CONFIG.OBRA !== 'Nombre de la obra' ? CONFIG.OBRA : ''].filter(Boolean).join(' · ');
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (S && S.token) iniciar(); else { $('#v-login').hidden = false; }
