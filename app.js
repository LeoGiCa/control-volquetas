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
  const j = await r.json();
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
    S = { token: j.token, nombre: j.nombre, rol: j.rol };
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
  ['capturar', 'pendientes', 'registro', 'revision'].forEach(x => { $('#v-' + x).hidden = x !== v; });
  window.scrollTo({ top: 0 });
  if (v === 'capturar' && !actual) actualizarHoy();
  if (v === 'pendientes') pintarPendientes();
  if (v === 'registro') cargarRegistro();
  if (v === 'revision') cargarRevision();
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
  if (!navigator.onLine || !S) return;
  try {
    const j = await api('listar', {});
    if (j.ok) { const x = calcularHoy(j.remisiones); guardarLS('cv_hoy', x); pintarHoy(x); }
  } catch (e) { /* queda el último resumen guardado */ }
}
function pintarAvisos() {
  const a = [];
  if (nCola) a.push(`<button class="aviso" data-ir="pendientes"><svg class="ico peq"><use href="#i-reloj"/></svg><span>${nCola} ${nCola === 1 ? 'foto' : 'fotos'} en este celular sin enviar</span>›</button>`);
  if (S && S.rol === 'residente' && nRevision) a.push(`<button class="aviso" data-ir="revision"><svg class="ico peq"><use href="#i-alerta"/></svg><span>${nRevision} ${nRevision === 1 ? 'remisión' : 'remisiones'} por revisar</span>›</button>`);
  $('#avisos').innerHTML = a.join('');
}
$('#avisos').onclick = e => { const b = e.target.closest('[data-ir]'); if (b) ver(b.dataset.ir); };
$('#btnInicio').onclick = () => limpiar();

/* ---------------- foto ---------------- */
$('#foto').onchange = e => nuevaFoto(e.target.files[0]);
$('#fotoGaleria').onchange = e => nuevaFoto(e.target.files[0]);

async function nuevaFoto(file) {
  if (!file) return;
  actual = null;
  ver('capturar');
  modoCaptura(true);
  $('#form').hidden = true; $('#pDup').hidden = true;
  $('#drop').innerHTML = '';
  estado($('#stCap'), 'Preparando la foto…');
  try {
    const [imagen, hash] = await Promise.all([comprimir(file), huella(file)]);
    const it = { id: uuid(), creado: new Date().toISOString(), imagen, hash, estado: 'sin_leer' };
    await colaPut(it);
    abrir(it);
    contarPendientes();
    if (navigator.onLine) leerItem(it);
    else estado($('#stCap'), 'Sin señal: la foto quedó guardada en Pendientes. Léela cuando vuelva la señal, o llena los datos a mano.');
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
    pintarBotonesSinLeer();
  } else if (it.estado === 'requiere_decision') {
    mostrarDuplicado(it);
  } else {
    mostrarFormulario(it);
  }
}

function pintarBotonesSinLeer() {
  const st = $('#stCap');
  st.innerHTML = '';
  const fila = document.createElement('div');
  fila.className = 'grid';
  fila.innerHTML = `<button class="btn primary grande" type="button" id="btnLeer">Leer recibo</button>
    <button class="btn" type="button" id="btnManual">Llenar a mano</button>`;
  st.appendChild(fila);
  $('#btnLeer').onclick = () => leerItem(actual);
  $('#btnManual').onclick = () => { actual.datos = {}; actual.dudosos = []; actual.estado = 'por_revisar'; colaPut(actual); mostrarFormulario(actual); };
}

async function leerItem(it) {
  estado($('#stCap'), 'Leyendo el recibo… puede tardar entre 10 y 40 segundos.');
  try {
    const j = await api('leer', { imagen: it.imagen, hash: it.hash });
    if (j.fotoDuplicada) {
      it.estado = 'requiere_decision';
      it.duplicado = j.fotoDuplicada;
      it.fotoRepetida = true;
      await colaPut(it);
      return mostrarDuplicado(it);
    }
    if (!j.ok) throw j;
    Object.assign(it, { datos: j.datos, original: j.datos, dudosos: j.dudosos || [], alertasLectura: j.alertasLectura || [],
      controles: j.controles, leidoIA: true, estado: 'por_revisar' });
    await colaPut(it);
    estado($('#stCap'), 'Listo. Revisa los datos.');
    if (actual && actual.id === it.id) mostrarFormulario(it);
  } catch (err) {
    estado($('#stCap'), (err.mensaje || 'No se pudo leer.') + (err.error === 'red' ? ' La foto quedó en Pendientes.' : ''), true);
    if (actual && actual.id === it.id) pintarBotonesSinLeer();
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
  const f = e.target.closest('.f');
  if (f) f.classList.remove('dudoso');
  pintarAlertas();
});

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
  actual.datos = d;
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
async function enviarItem(it, enPantalla) {
  const st = enPantalla ? $('#stForm') : null;
  if (st) estado(st, 'Guardando…');
  try {
    const j = await api('guardar', {
      id: it.id, datos: it.datos, imagen: it.imagen, hash: it.hash, leidoIA: !!it.leidoIA,
      corregidos: it.corregidos || [], alertasLectura: it.alertasLectura || [],
      decision: it.decision || null, explicacion: it.explicacion || ''
    });
    if (j.ok) {
      await colaDel(it.id);
      const msg = j.estado === 'En revisión'
        ? `Remisión ${it.datos.numero} guardada EN REVISIÓN: ${j.motivo}. No suma hasta que el residente decida.`
        : `Remisión ${it.datos.numero} guardada.`;
      if (actual && actual.id === it.id) limpiar();
      toast(msg);
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
    const items = (await colaTodas()).filter(it => it.estado === 'por_enviar' && (!actual || actual.id !== it.id));
    for (const it of items) {
      const ok = await enviarItem(it, false);
      if (!ok && !navigator.onLine) break;
    }
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
  const txt = { sin_leer: 'Sin leer', por_revisar: 'Por revisar', por_enviar: 'Por enviar', requiere_decision: 'Repetida: decidir' };
  const cls = { sin_leer: 'warn', por_revisar: 'warn', por_enviar: '', requiere_decision: 'bad' };
  box.innerHTML = items.map(it => {
    const d = it.datos || {};
    return `<article class="card">
      <img class="thumb" src="${it.imagen}" alt="">
      <div class="main"><span class="num">${d.numero ? 'N.º ' + esc(d.numero) : 'Sin datos'} · tomada ${new Date(it.creado).toLocaleString('es-CO')}</span>
        <div class="meta">${esc(d.material || '')} ${d.proveedor ? '· ' + esc(d.proveedor) : ''}</div></div>
      <span class="chip ${cls[it.estado] || ''}">${txt[it.estado] || it.estado}</span>
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

function pintarCatalogos(c) {
  if (!c) return;
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
  $('#tabRev').hidden = S.rol !== 'residente';
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
        S.rol = c.rol; S.nombre = c.nombre; guardarLS('cv_sesion', S);
        pintarQuien();
        $('#tabRev').hidden = S.rol !== 'residente';
      }
    } catch (e) { /* se usan los catálogos guardados */ }
    enviarCola();
    actualizarHoy();
    if (S && S.rol === 'residente') api('revision', {}).then(j => {
      if (j.ok) { nRevision = j.pendientes.length; marcador($('#nRev'), nRevision); pintarAvisos(); }
    }).catch(() => {});
  }
}
function pintarQuien() {
  const nombre = String(S.nombre || '').trim();
  const primer = /^residente\b/i.test(nombre) ? '' : nombre.split(/\s+/)[0];
  $('#hola').textContent = primer ? `Hola, ${primer}` : 'Hola';
  const rol = S.rol ? S.rol.charAt(0).toUpperCase() + S.rol.slice(1) : '';
  $('#quien').textContent = [rol, CONFIG.OBRA && CONFIG.OBRA !== 'Nombre de la obra' ? CONFIG.OBRA : ''].filter(Boolean).join(' · ');
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (S && S.token) iniciar(); else { $('#v-login').hidden = false; }
