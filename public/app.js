const NOMBRE_NEGOCIO = "Nombre del negocio"; // cambialo por el nombre del negocio

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
  if (!$("servicio").value || !$("profesional").value || !$("fecha").value) {
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

async function cargarServiciosAdmin() {
  try {
    const servicios = await api("/servicios");
    const lista = $("lista-servicios");
    lista.innerHTML = "";
    if (!servicios.length) {
      lista.appendChild(crear("p", "Todavía no hay servicios cargados.", "vacio"));
      return;
    }
    servicios.forEach((s) => {
      const fila = crear("div", "", "servicio-item");
      fila.appendChild(crear("strong", s.nombre));
      fila.appendChild(crear("span", `${s.duracion_min} min · $${s.precio}`));
      lista.appendChild(fila);
    });
  } catch (err) {
    aviso(err.message, true);
  }
}

$("btn-agenda").addEventListener("click", cargarAgenda);

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

// ---------- Inicio ----------
(async function iniciar() {
  document.title = "Turnos - " + NOMBRE_NEGOCIO;
  $("nombre-negocio").textContent = NOMBRE_NEGOCIO;

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
