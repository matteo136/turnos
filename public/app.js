const NOMBRE_NEGOCIO = "Barbería 67"; // nombre que se muestra en la página

const $ = (id) => document.getElementById(id);
const ESTADOS = ["reservado", "cancelado", "completado", "ausente"];
let modoRegistro = false;
let horaElegida = null;
let pedidoHorarios = 0;
let temporizador = null;

// ---------- Utilidades ----------
async function api(url, opciones = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opciones,
  });
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== "/login") mostrarVista(null);
    throw new Error(datos.error || "Error del servidor");
  }
  return datos;
}

function aviso(texto, error = false) {
  const caja = $("toast");
  clearTimeout(temporizador);
  if (!texto) {
    caja.hidden = true;
    return;
  }
  caja.textContent = texto;
  caja.className = "toast " + (error ? "error" : "ok");
  caja.hidden = false;
  temporizador = setTimeout(() => { caja.hidden = true; }, 4500);
}

function crear(etiqueta, texto = "", clase = "") {
  const e = document.createElement(etiqueta);
  e.textContent = texto;
  if (clase) e.className = clase;
  return e;
}

function llenarSelect(select, items, textoDe) {
  select.innerHTML = "";
  items.forEach((item) => {
    const op = crear("option", textoDe(item));
    op.value = item.id;
    select.appendChild(op);
  });
}

function hoy() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fechaCorta(iso) {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

function fechaLarga(iso) {
  const f = new Date(iso + "T00:00:00");
  const texto = f.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function textoSeleccionado(select) {
  const op = select.options[select.selectedIndex];
  return op ? op.textContent : "";
}

// ---------- Vistas ----------
function mostrarVista(usuario) {
  const esAdmin = !!usuario && usuario.rol === "admin";
  $("vista-auth").hidden = !!usuario;
  $("sesion").hidden = !usuario;
  $("vista-cliente").hidden = !usuario || esAdmin;
  $("vista-admin").hidden = !esAdmin;
  if (!usuario) return;
  $("saludo").textContent = "Hola, " + usuario.nombre;
  if (esAdmin) {
    cargarAgenda();
    cargarServiciosAdmin();
    cargarProfesionalesAdmin();
  } else {
    cargarCliente();
  }
}

function cambiarModo(registro) {
  modoRegistro = registro;
  $("campos-registro").hidden = !registro;
  $("nombre").required = registro;
  $("password").autocomplete = registro ? "new-password" : "current-password";
  $("tab-login").classList.toggle("activa", !registro);
  $("tab-registro").classList.toggle("activa", registro);
  $("btn-auth").textContent = registro ? "Crear cuenta" : "Ingresar";
}

// ---------- Ingreso / registro ----------
$("tab-login").addEventListener("click", () => cambiarModo(false));
$("tab-registro").addEventListener("click", () => cambiarModo(true));

$("btn-ver-pass").addEventListener("click", () => {
  const campo = $("password");
  campo.type = campo.type === "password" ? "text" : "password";
});

$("form-auth").addEventListener("submit", async (e) => {
  e.preventDefault();
  const boton = $("btn-auth");
  const datos = {
    nombre: $("nombre").value,
    telefono: $("telefono").value,
    email: $("email").value,
    password: $("password").value,
  };
  boton.disabled = true;
  try {
    if (modoRegistro) {
      await api("/registro", { method: "POST", body: JSON.stringify(datos) });
      cambiarModo(false);
      aviso("Cuenta creada. Ya podés ingresar.");
    } else {
      const usuario = await api("/login", { method: "POST", body: JSON.stringify(datos) });
      aviso("");
      $("password").value = "";
      mostrarVista(usuario);
    }
  } catch (err) {
    aviso(err.message, true);
  } finally {
    boton.disabled = false;
  }
});

$("btn-salir").addEventListener("click", async () => {
  try {
    await api("/logout", { method: "POST" });
  } catch (err) {
    /* igual cerramos la vista */
  }
  aviso("");
  mostrarVista(null);
});

// ---------- Cliente ----------
async function cargarCliente() {
  try {
    const [servicios, profesionales] = await Promise.all([api("/servicios"), api("/profesionales")]);
    llenarSelect($("servicio"), servicios, (s) => `${s.nombre} · ${s.duracion_min} min · $${s.precio}`);
    llenarSelect($("profesional"), profesionales, (p) => p.nombre);
    $("fecha").min = hoy();
    $("fecha").value = hoy();
    await Promise.all([cargarHorarios(), cargarMisTurnos()]);
  } catch (err) {
    aviso(err.message, true);
  }
}

function actualizarResumen() {
  const caja = $("confirmar-caja");
  if (!horaElegida) {
    caja.hidden = true;
    return;
  }
  $("resumen").textContent =
    `${textoSeleccionado($("servicio")).split(" · ")[0]} con ${textoSeleccionado($("profesional"))}, ` +
    `${fechaLarga($("fecha").value)} a las ${horaElegida}`;
  caja.hidden = false;
}

async function cargarHorarios() {
  horaElegida = null;
  actualizarResumen();
  const caja = $("horarios");
  if (!$("servicio").value || !$("profesional").value) {
    caja.innerHTML = "";
    caja.appendChild(crear("p", "Por ahora no hay servicios o profesionales disponibles.", "vacio"));
    return;
  }
  if (!$("fecha").value) {
    caja.innerHTML = "";
    return;
  }
  const pedido = ++pedidoHorarios;
  caja.innerHTML = "";
  caja.appendChild(crear("p", "Buscando horarios…", "vacio"));
  try {
    const params = new URLSearchParams({
      servicio_id: $("servicio").value,
      profesional_id: $("profesional").value,
      fecha: $("fecha").value,
    });
    const { horarios } = await api("/disponibilidad?" + params);
    if (pedido !== pedidoHorarios) return;
    caja.innerHTML = "";
    if (!horarios.length) {
      caja.appendChild(crear("p", "No hay horarios libres ese día. Probá con otra fecha.", "vacio"));
      return;
    }
    horarios.forEach((h) => {
      const boton = crear("button", h, "chip");
      boton.type = "button";
      boton.addEventListener("click", () => elegirHora(h, boton));
      caja.appendChild(boton);
    });
  } catch (err) {
    if (pedido !== pedidoHorarios) return;
    caja.innerHTML = "";
    aviso(err.message, true);
  }
}

function elegirHora(hora, boton) {
  horaElegida = hora;
  document.querySelectorAll(".chip").forEach((b) => b.classList.remove("activa"));
  boton.classList.add("activa");
  actualizarResumen();
}

async function confirmarTurno() {
  const boton = $("btn-confirmar");
  boton.disabled = true;
  try {
    await api("/turnos", {
      method: "POST",
      body: JSON.stringify({
        servicio_id: $("servicio").value,
        profesional_id: $("profesional").value,
        fecha: $("fecha").value,
        hora: horaElegida,
      }),
    });
    aviso("¡Turno reservado!");
  } catch (err) {
    aviso(err.message, true);
  }
  boton.disabled = false;
  await cargarHorarios();
  try {
    await cargarMisTurnos();
  } catch (err) {
    aviso(err.message, true);
  }
}

function dibujarTurnos(contenedor, turnos, vacio, conCancelar) {
  contenedor.innerHTML = "";
  if (!turnos.length) {
    contenedor.appendChild(crear("p", vacio, "vacio"));
    return;
  }
  turnos.forEach((t) => {
    const fila = crear("div", "", "turno");
    const info = crear("div", "", "turno-info");
    info.appendChild(crear("strong", `${fechaCorta(t.fecha)} · ${t.hora_inicio}`));
    info.appendChild(crear("span", `${t.servicio} con ${t.profesional}`));
    fila.appendChild(info);
    const der = crear("div", "", "turno-der");
    der.appendChild(crear("span", t.estado, "badge " + t.estado));
    if (conCancelar && t.estado === "reservado") {
      const boton = crear("button", "Cancelar", "btn btn-chico");
      boton.type = "button";
      boton.addEventListener("click", () => cancelarTurno(t.id));
      der.appendChild(boton);
    }
    fila.appendChild(der);
    contenedor.appendChild(fila);
  });
}

async function cargarMisTurnos() {
  const turnos = await api("/mis-turnos");
  const hoyIso = hoy();
  const proximos = turnos
    .filter((t) => t.estado === "reservado" && t.fecha >= hoyIso)
    .sort((a, b) => (a.fecha + a.hora_inicio).localeCompare(b.fecha + b.hora_inicio));
  const anteriores = turnos.filter((t) => !(t.estado === "reservado" && t.fecha >= hoyIso));
  dibujarTurnos($("proximos"), proximos, "No tenés turnos próximos.", true);
  dibujarTurnos($("anteriores"), anteriores, "Todavía no tenés turnos anteriores.", false);
}

async function cancelarTurno(id) {
  if (!confirm("¿Cancelar este turno?")) return;
  try {
    await api("/turnos/" + id, { method: "DELETE" });
    aviso("Turno cancelado.");
    await cargarMisTurnos();
    await cargarHorarios();
  } catch (err) {
    aviso(err.message, true);
  }
}

["servicio", "profesional", "fecha"].forEach((id) => $(id).addEventListener("change", cargarHorarios));
$("btn-confirmar").addEventListener("click", confirmarTurno);

// ---------- Administrador ----------
async function cargarAgenda() {
  if (!$("fecha-admin").value) $("fecha-admin").value = hoy();
  try {
    const filas = await api("/admin/agenda?fecha=" + $("fecha-admin").value);
    $("stat-total").textContent = filas.length;
    $("stat-reservados").textContent = filas.filter((t) => t.estado === "reservado").length;
    $("stat-completados").textContent = filas.filter((t) => t.estado === "completado").length;

    const cuerpo = $("agenda");
    cuerpo.innerHTML = "";
    if (!filas.length) {
      const tr = document.createElement("tr");
      const td = crear("td", "No hay turnos para ese día.");
      td.colSpan = 5;
      tr.appendChild(td);
      cuerpo.appendChild(tr);
      return;
    }
    filas.forEach((t) => {
      const tr = document.createElement("tr");
      [t.hora_inicio, t.cliente, t.servicio, t.profesional].forEach((txt) =>
        tr.appendChild(crear("td", txt))
      );
      const td = document.createElement("td");
      const sel = document.createElement("select");
      ESTADOS.forEach((e) => {
        const op = crear("option", e);
        op.value = e;
        op.selected = e === t.estado;
        sel.appendChild(op);
      });
      sel.addEventListener("change", () => cambiarEstado(t.id, sel.value));
      td.appendChild(sel);
      tr.appendChild(td);
      cuerpo.appendChild(tr);
    });
  } catch (err) {
    aviso(err.message, true);
  }
}

async function cambiarEstado(id, estado) {
  try {
    await api("/admin/turnos/" + id, { method: "PATCH", body: JSON.stringify({ estado }) });
    aviso("Estado actualizado.");
  } catch (err) {
    aviso(err.message, true);
  }
  cargarAgenda();
}

$("btn-agenda").addEventListener("click", cargarAgenda);

// ---------- Administrador: servicios y profesionales ----------
function campo(etiqueta, tipo, valor, extra = {}) {
  const label = document.createElement("label");
  label.appendChild(document.createTextNode(etiqueta));
  const input = document.createElement("input");
  input.type = tipo;
  input.value = valor;
  Object.assign(input, extra);
  label.appendChild(input);
  return { label, input };
}

function botonesEdicion(alCancelar) {
  const botones = crear("div", "", "edicion-botones");
  const guardar = crear("button", "Guardar", "btn btn-mini btn-principal");
  guardar.type = "submit";
  const cancelar = crear("button", "Cancelar", "btn btn-mini btn-gris");
  cancelar.type = "button";
  cancelar.addEventListener("click", alCancelar);
  botones.appendChild(guardar);
  botones.appendChild(cancelar);
  return botones;
}

function dibujarItem(titulo, detalle, activo, alEditar, alAlternar) {
  const fila = crear("div", "", "item" + (activo ? "" : " apagado"));
  const info = crear("div", "", "item-info");
  info.appendChild(crear("strong", titulo));
  info.appendChild(crear("span", detalle + (activo ? "" : " · Quitado")));
  fila.appendChild(info);

  const acciones = crear("div", "", "item-acciones");
  const editar = crear("button", "Editar", "btn btn-mini btn-azul");
  editar.type = "button";
  editar.addEventListener("click", () => alEditar(fila));
  const alternar = crear("button", activo ? "Quitar" : "Activar", "btn btn-mini " + (activo ? "btn-rojo" : "btn-verde"));
  alternar.type = "button";
  alternar.addEventListener("click", alAlternar);
  acciones.appendChild(editar);
  acciones.appendChild(alternar);
  fila.appendChild(acciones);
  return fila;
}

// --- Servicios ---
function dibujarServicio(s) {
  return dibujarItem(
    s.nombre,
    `${s.duracion_min} min · $${s.precio}`,
    s.activo,
    (fila) => fila.replaceWith(formEditarServicio(s)),
    () => {
      if (s.activo && !confirm("¿Quitar este servicio? Los clientes dejarán de verlo, pero los turnos ya reservados se conservan.")) return;
      cambiarServicio(s.id, { activo: !s.activo }, s.activo ? "Servicio quitado." : "Servicio activado.");
    }
  );
}

function formEditarServicio(s) {
  const form = crear("form", "", "item item-edicion");
  const campos = crear("div", "", "edicion-campos");
  const nombre = campo("Nombre", "text", s.nombre, { required: true });
  const duracion = campo("Duración (min)", "number", s.duracion_min, { required: true, min: 5, step: 5 });
  const precio = campo("Precio ($)", "number", s.precio, { min: 0, step: 100 });
  [nombre, duracion, precio].forEach((c) => campos.appendChild(c.label));
  form.appendChild(campos);
  form.appendChild(botonesEdicion(() => form.replaceWith(dibujarServicio(s))));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    cambiarServicio(
      s.id,
      { nombre: nombre.input.value, duracion_min: duracion.input.value, precio: precio.input.value },
      "Servicio actualizado."
    );
  });
  return form;
}

async function cambiarServicio(id, datos, mensaje) {
  try {
    await api("/admin/servicios/" + id, { method: "PATCH", body: JSON.stringify(datos) });
    aviso(mensaje);
  } catch (err) {
    aviso(err.message, true);
  }
  cargarServiciosAdmin();
}

async function cargarServiciosAdmin() {
  try {
    const servicios = await api("/admin/servicios");
    const lista = $("lista-servicios");
    lista.innerHTML = "";
    if (!servicios.length) {
      lista.appendChild(crear("p", "Todavía no hay servicios cargados.", "vacio"));
      return;
    }
    servicios.forEach((s) => lista.appendChild(dibujarServicio(s)));
  } catch (err) {
    aviso(err.message, true);
  }
}

$("form-servicio").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/admin/servicios", {
      method: "POST",
      body: JSON.stringify({
        nombre: $("srv-nombre").value,
        duracion_min: $("srv-duracion").value,
        precio: $("srv-precio").value,
      }),
    });
    aviso("Servicio agregado.");
    e.target.reset();
    cargarServiciosAdmin();
  } catch (err) {
    aviso(err.message, true);
  }
});

// --- Profesionales ---
function dibujarProfesional(p) {
  const horario = p.hora_inicio && p.hora_fin
    ? `Lun a sáb · ${p.hora_inicio} a ${p.hora_fin}`
    : "Sin horario cargado";
  return dibujarItem(
    p.nombre,
    horario,
    p.activo,
    (fila) => fila.replaceWith(formEditarProfesional(p)),
    () => {
      if (p.activo && !confirm("¿Quitar a este profesional? Los clientes dejarán de verlo, pero los turnos ya reservados se conservan.")) return;
      cambiarProfesional(p.id, { activo: !p.activo }, p.activo ? "Profesional quitado." : "Profesional activado.");
    }
  );
}

function formEditarProfesional(p) {
  const form = crear("form", "", "item item-edicion");
  const campos = crear("div", "", "edicion-campos");
  const nombre = campo("Nombre", "text", p.nombre, { required: true });
  const desde = campo("Desde", "time", p.hora_inicio || "09:00", { required: true });
  const hasta = campo("Hasta", "time", p.hora_fin || "18:00", { required: true });
  [nombre, desde, hasta].forEach((c) => campos.appendChild(c.label));
  form.appendChild(campos);
  form.appendChild(botonesEdicion(() => form.replaceWith(dibujarProfesional(p))));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    cambiarProfesional(
      p.id,
      { nombre: nombre.input.value, hora_inicio: desde.input.value, hora_fin: hasta.input.value },
      "Profesional actualizado."
    );
  });
  return form;
}

async function cambiarProfesional(id, datos, mensaje) {
  try {
    await api("/admin/profesionales/" + id, { method: "PATCH", body: JSON.stringify(datos) });
    aviso(mensaje);
  } catch (err) {
    aviso(err.message, true);
  }
  cargarProfesionalesAdmin();
}

async function cargarProfesionalesAdmin() {
  try {
    const profesionales = await api("/admin/profesionales");
    const lista = $("lista-profesionales");
    lista.innerHTML = "";
    if (!profesionales.length) {
      lista.appendChild(crear("p", "Todavía no hay profesionales cargados.", "vacio"));
      return;
    }
    profesionales.forEach((p) => lista.appendChild(dibujarProfesional(p)));
  } catch (err) {
    aviso(err.message, true);
  }
}

$("form-profesional").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/admin/profesionales", {
      method: "POST",
      body: JSON.stringify({
        nombre: $("prof-nombre").value,
        hora_inicio: $("prof-desde").value,
        hora_fin: $("prof-hasta").value,
      }),
    });
    aviso("Profesional agregado.");
    e.target.reset();
    cargarProfesionalesAdmin();
  } catch (err) {
    aviso(err.message, true);
  }
});

// ---------- Inicio ----------
(async function iniciar() {
  document.title = "Turnos - " + NOMBRE_NEGOCIO;
  $("nombre-negocio").textContent = NOMBRE_NEGOCIO;
  $("pie-nombre").textContent = NOMBRE_NEGOCIO;

  if (location.protocol === "file:") {
    $("vista-auth").hidden = true;
    $("banner-local").hidden = false;
    return;
  }
  try {
    const { usuario } = await api("/yo");
    mostrarVista(usuario);
  } catch (err) {
    aviso(err.message, true);
  }
})();
