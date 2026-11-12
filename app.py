import os
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from functools import wraps
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.errors
import psycopg2.extras
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()

# Carpeta donde están index.html, style.css y app.js:
# "public" si existe; si no, la misma carpeta de app.py.
BASE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(BASE, "public")
if not os.path.isdir(WEB):
    WEB = BASE

app = Flask(__name__, static_folder=None)
app.secret_key = os.environ.get("SECRET_KEY", "cambiar-esto")

PASO_MIN = 30
ZONA = ZoneInfo("America/Argentina/Buenos_Aires")
ESTADOS = ("reservado", "cancelado", "completado", "ausente")


# ---------- Base de datos ----------
def conectar_db():
    return psycopg2.connect(
        os.environ["DATABASE_URL"],
        cursor_factory=psycopg2.extras.RealDictCursor,
    )


def consultar(sql, params=(), uno=False):
    conn = conectar_db()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(sql, params)
            if cur.description is None:
                return None
            return cur.fetchone() if uno else cur.fetchall()
    finally:
        conn.close()


def limpiar(obj):
    """Convierte horas, fechas y decimales a algo que JSON entienda."""
    if isinstance(obj, list):
        return [limpiar(o) for o in obj]
    if isinstance(obj, dict):
        return {k: limpiar(v) for k, v in obj.items()}
    if isinstance(obj, time):
        return obj.strftime("%H:%M")
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, date):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    return obj


def ahora_local():
    return datetime.now(ZONA).replace(tzinfo=None)


# ---------- Permisos ----------
def requiere_login(f):
    @wraps(f)
    def envoltura(*args, **kwargs):
        if "usuario_id" not in session:
            return jsonify(error="Iniciá sesión"), 401
        return f(*args, **kwargs)
    return envoltura


def requiere_admin(f):
    @wraps(f)
    def envoltura(*args, **kwargs):
        if session.get("rol") != "admin":
            return jsonify(error="Solo para administradores"), 403
        return f(*args, **kwargs)
    return envoltura


# ---------- Funciones del programa ----------
def registrar_usuario(datos):
    nombre = (datos.get("nombre") or "").strip()
    email = (datos.get("email") or "").strip().lower()
    telefono = (datos.get("telefono") or "").strip()
    password = datos.get("password") or ""
    if not nombre or "@" not in email or len(password) < 6:
        return "Completá nombre, un correo válido y una contraseña de 6 o más caracteres"
    if consultar("select id from usuarios where email = %s", (email,), uno=True):
        return "Ese correo ya está registrado"
    consultar(
        "insert into usuarios (nombre, email, telefono, password_hash) values (%s, %s, %s, %s)",
        (nombre, email, telefono, generate_password_hash(password)),
    )
    return None


def iniciar_sesion(email, password):
    usuario = consultar(
        "select * from usuarios where email = %s", ((email or "").strip().lower(),), uno=True
    )
    if usuario and check_password_hash(usuario["password_hash"], password or ""):
        return usuario
    return None


def listar_servicios():
    return consultar("select id, nombre, duracion_min, precio from servicios where activo order by id")


def listar_profesionales():
    return consultar("select id, nombre from profesionales where activo order by id")


def calcular_horarios_libres(servicio_id, profesional_id, fecha):
    servicio = consultar(
        "select duracion_min from servicios where id = %s and activo", (servicio_id,), uno=True
    )
    if not servicio:
        return []
    duracion = timedelta(minutes=servicio["duracion_min"])
    franjas = consultar(
        "select hora_inicio, hora_fin from horarios_atencion "
        "where profesional_id = %s and dia_semana = %s",
        (profesional_id, fecha.weekday()),
    )
    ocupados = consultar(
        "select hora_inicio, hora_fin from turnos "
        "where profesional_id = %s and fecha = %s and estado = 'reservado'",
        (profesional_id, fecha),
    )
    ahora = ahora_local()
    libres = []
    for franja in franjas:
        actual = datetime.combine(fecha, franja["hora_inicio"])
        limite = datetime.combine(fecha, franja["hora_fin"])
        while actual + duracion <= limite:
            fin = actual + duracion
            choca = any(
                actual.time() < o["hora_fin"] and fin.time() > o["hora_inicio"]
                for o in ocupados
            )
            if not choca and actual > ahora:
                libres.append(actual.strftime("%H:%M"))
            actual += timedelta(minutes=PASO_MIN)
    return sorted(set(libres))


def validar_turno(datos):
    try:
        servicio_id = int(datos["servicio_id"])
        profesional_id = int(datos["profesional_id"])
        fecha = date.fromisoformat(datos["fecha"])
        hora = datetime.strptime(datos["hora"], "%H:%M").time()
    except (KeyError, ValueError, TypeError):
        return "Datos incompletos o inválidos", None
    if hora.strftime("%H:%M") not in calcular_horarios_libres(servicio_id, profesional_id, fecha):
        return "Ese horario no está disponible", None
    return None, (servicio_id, profesional_id, fecha, hora)


def reservar_turno(usuario_id, servicio_id, profesional_id, fecha, hora):
    """Guarda el turno de forma segura. Devuelve el id o None si el horario se ocupó."""
    conn = conectar_db()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("select duracion_min from servicios where id = %s", (servicio_id,))
            duracion = cur.fetchone()["duracion_min"]
            fin = (datetime.combine(fecha, hora) + timedelta(minutes=duracion)).time()

            # bloquea a este profesional hasta terminar la transacción
            cur.execute("select pg_advisory_xact_lock(%s)", (profesional_id,))
            cur.execute(
                "select 1 from turnos where profesional_id = %s and fecha = %s "
                "and estado = 'reservado' and hora_inicio < %s and hora_fin > %s",
                (profesional_id, fecha, fin, hora),
            )
            if cur.fetchone():
                return None
            cur.execute(
                "insert into turnos (usuario_id, servicio_id, profesional_id, fecha, hora_inicio, hora_fin) "
                "values (%s, %s, %s, %s, %s, %s) returning id",
                (usuario_id, servicio_id, profesional_id, fecha, hora, fin),
            )
            return cur.fetchone()["id"]
    except psycopg2.errors.UniqueViolation:
        return None
    finally:
        conn.close()


def cancelar_turno(turno_id, usuario_id):
    fila = consultar(
        "update turnos set estado = 'cancelado' "
        "where id = %s and usuario_id = %s and estado = 'reservado' returning id",
        (turno_id, usuario_id),
        uno=True,
    )
    return fila is not None


def listar_mis_turnos(usuario_id):
    return consultar(
        "select t.id, t.fecha, t.hora_inicio, t.estado, s.nombre as servicio, p.nombre as profesional "
        "from turnos t join servicios s on s.id = t.servicio_id "
        "join profesionales p on p.id = t.profesional_id "
        "where t.usuario_id = %s order by t.fecha desc, t.hora_inicio desc",
        (usuario_id,),
    )


def obtener_agenda(fecha):
    return consultar(
        "select t.id, t.hora_inicio, t.estado, u.nombre as cliente, "
        "s.nombre as servicio, p.nombre as profesional "
        "from turnos t join usuarios u on u.id = t.usuario_id "
        "join servicios s on s.id = t.servicio_id "
        "join profesionales p on p.id = t.profesional_id "
        "where t.fecha = %s order by t.hora_inicio, p.nombre",
        (fecha,),
    )


def actualizar_estado_turno(turno_id, estado):
    if estado not in ESTADOS:
        return False
    fila = consultar(
        "update turnos set estado = %s where id = %s returning id", (estado, turno_id), uno=True
    )
    return fila is not None


def crear_servicio(datos):
    try:
        nombre = datos["nombre"].strip()
        duracion = int(datos["duracion_min"])
        precio = float(datos.get("precio") or 0)
    except (KeyError, ValueError, AttributeError):
        return "Datos del servicio inválidos"
    if not nombre or duracion <= 0 or precio < 0:
        return "Datos del servicio inválidos"
    consultar(
        "insert into servicios (nombre, duracion_min, precio) values (%s, %s, %s)",
        (nombre, duracion, precio),
    )
    return None


# ---------- Rutas ----------
@app.get("/")
@app.get("/index.html")
def inicio():
    return send_from_directory(WEB, "index.html")


@app.get("/style.css")
def estilos():
    return send_from_directory(WEB, "style.css")


@app.get("/app.js")
def script():
    return send_from_directory(WEB, "app.js")


@app.get("/estado")
def estado():
    """Sirve para comprobar si la página está conectada a Supabase."""
    try:
        n = consultar("select count(*) as n from servicios", uno=True)["n"]
        return jsonify(ok=True, mensaje=f"Conexion con la base OK. Servicios cargados: {n}")
    except Exception as e:
        en_mi_compu = request.host.startswith(("127.0.0.1", "localhost"))
        return jsonify(
            ok=False,
            mensaje="No se pudo conectar con la base de datos.",
            detalle=str(e).strip() if en_mi_compu else None,
        ), 500


@app.post("/registro")
def ruta_registro():
    error = registrar_usuario(request.get_json(silent=True) or {})
    if error:
        return jsonify(error=error), 400
    return jsonify(ok=True), 201


@app.post("/login")
def ruta_login():
    datos = request.get_json(silent=True) or {}
    usuario = iniciar_sesion(datos.get("email", ""), datos.get("password", ""))
    if not usuario:
        return jsonify(error="Correo o contraseña incorrectos"), 401
    session["usuario_id"] = usuario["id"]
    session["rol"] = usuario["rol"]
    session["nombre"] = usuario["nombre"]
    return jsonify(nombre=usuario["nombre"], rol=usuario["rol"])


@app.post("/logout")
def ruta_logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/yo")
def ruta_yo():
    if "usuario_id" not in session:
        return jsonify(usuario=None)
    return jsonify(usuario={"nombre": session["nombre"], "rol": session["rol"]})


@app.get("/servicios")
def ruta_servicios():
    return jsonify(limpiar(listar_servicios()))


@app.get("/profesionales")
def ruta_profesionales():
    return jsonify(limpiar(listar_profesionales()))


@app.get("/disponibilidad")
@requiere_login
def ruta_disponibilidad():
    try:
        servicio_id = int(request.args["servicio_id"])
        profesional_id = int(request.args["profesional_id"])
        fecha = date.fromisoformat(request.args["fecha"])
    except (KeyError, ValueError):
        return jsonify(error="Datos inválidos"), 400
    return jsonify(horarios=calcular_horarios_libres(servicio_id, profesional_id, fecha))


@app.post("/turnos")
@requiere_login
def ruta_reservar():
    error, valores = validar_turno(request.get_json(silent=True) or {})
    if error:
        return jsonify(error=error), 400
    turno_id = reservar_turno(session["usuario_id"], *valores)
    if not turno_id:
        return jsonify(error="Ese horario se acaba de ocupar. Elegí otro."), 409
    return jsonify(id=turno_id), 201


@app.get("/mis-turnos")
@requiere_login
def ruta_mis_turnos():
    return jsonify(limpiar(listar_mis_turnos(session["usuario_id"])))


@app.delete("/turnos/<int:turno_id>")
@requiere_login
def ruta_cancelar(turno_id):
    if not cancelar_turno(turno_id, session["usuario_id"]):
        return jsonify(error="No se pudo cancelar el turno"), 400
    return jsonify(ok=True)


@app.get("/admin/agenda")
@requiere_admin
def ruta_agenda():
    try:
        fecha = date.fromisoformat(request.args["fecha"])
    except (KeyError, ValueError):
        return jsonify(error="Fecha inválida"), 400
    return jsonify(limpiar(obtener_agenda(fecha)))


@app.patch("/admin/turnos/<int:turno_id>")
@requiere_admin
def ruta_estado(turno_id):
    estado = (request.get_json(silent=True) or {}).get("estado")
    if not actualizar_estado_turno(turno_id, estado):
        return jsonify(error="No se pudo actualizar"), 400
    return jsonify(ok=True)


@app.post("/admin/servicios")
@requiere_admin
def ruta_crear_servicio():
    error = crear_servicio(request.get_json(silent=True) or {})
    if error:
        return jsonify(error=error), 400
    return jsonify(ok=True), 201


if __name__ == "__main__":
    app.run(debug=True)
