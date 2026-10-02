// ---------------------------------------------------------------------------
// Resolver del reporte de solicitudes para el portal de clientes (JSM).
//
// Flujo:
//   1. El modal (Custom UI) llama a "generarReporte" con { desde, hasta }.
//   2. Aqui se identifica al usuario con req.context.accountId (dato que pone
//      Forge, NO el navegador) y se buscan sus organizaciones.
//   3. Se consultan en Jira las solicitudes de esas organizaciones en el rango.
//   4. Se devuelven filas ya formateadas; el Excel se arma en el navegador.
//
// Las llamadas marcadas con "VALIDAR" no se pudieron confirmar contra la
// documentacion; revisar su resultado en `forge logs` durante la primera prueba.
// ---------------------------------------------------------------------------
import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

// Proyecto (espacio) de servicio al cliente. Ajustar si cambia la clave.
const PROJECT_KEY = 'SL';
// Tope de filas por reporte y de tiempo, por los limites de Forge (25 s).
const MAX_FILAS = 5000;
const MAX_MS = 20000;
const TAM_PAGINA = 100;
// Rango maximo del reporte, en dias (inclusive). Cambiar a 60 si se prefiere.
const MAX_DIAS = 90;

const resolver = new Resolver();

// ---------------------------- utilidades -----------------------------------

// Normaliza texto para comparar nombres de campos (sin tildes, minusculas).
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Escapa un valor para usarlo entre comillas dentro de un JQL.
function escaparJql(texto) {
  return String(texto).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Llama a Jira como app y falla con un mensaje claro si la respuesta no es OK.
// "etiqueta" identifica la llamada para saber cual fallo (se ve en el mensaje y en forge logs).
async function llamarJira(solicitud, opciones, etiqueta) {
  const respuesta = await api.asApp().requestJira(solicitud, opciones);
  if (!respuesta.ok) {
    const cuerpo = await respuesta.text();
    console.error('Error Jira', etiqueta, respuesta.status, cuerpo.slice(0, 500));
    throw new Error(`Jira respondio ${respuesta.status} en: ${etiqueta}`);
  }
  return respuesta.json();
}

// Convierte un documento ADF (texto enriquecido) en texto plano.
function adfATexto(nodo) {
  if (!nodo) return '';
  if (nodo.type === 'text') return nodo.text || '';
  const hijos = (nodo.content || []).map(adfATexto).join('');
  return nodo.type === 'paragraph' ? `${hijos}\n` : hijos;
}

// Texto "amigable" de un ciclo de SLA (formato por validar).
function formatearSla(valor) {
  const completados = valor.completedCycles || [];
  const ciclo = completados.length
    ? completados[completados.length - 1]
    : valor.ongoingCycle;
  if (!ciclo) return '';
  const tiempo = completados.length ? ciclo.elapsedTime : ciclo.remainingTime;
  return (tiempo && (tiempo.friendly || tiempo.millis)) ? String(tiempo.friendly || tiempo.millis) : '';
}

// Convierte cualquier valor de campo de Jira en texto para una celda.
function formatear(valor, avisos, titulo) {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'string' || typeof valor === 'number' || typeof valor === 'boolean') {
    return valor;
  }
  if (Array.isArray(valor)) return valor.map((v) => formatear(v, avisos, titulo)).join(', ');
  if (valor.type === 'doc') return adfATexto(valor).trim();
  if (valor.requestType && valor.requestType.name) return valor.requestType.name;
  if (valor.completedCycles || valor.ongoingCycle) return formatearSla(valor);
  if (valor.value !== undefined) return valor.value;
  if (valor.displayName !== undefined) return valor.displayName;
  if (valor.name !== undefined) return valor.name;
  avisos.add(`Formato no reconocido en la columna "${titulo}".`);
  return '';
}

// Informador: muestra el correo; si Jira no lo expone, usa el nombre visible.
function correoInformador(reporter, avisos) {
  if (!reporter) return '';
  if (reporter.emailAddress) return reporter.emailAddress;
  avisos.add('Algunos informadores no tienen correo visible; se muestra su nombre.');
  return reporter.displayName || '';
}

// ------------------------ campos y organizaciones --------------------------

// Busca el id de un campo por su nombre (acepta varios nombres posibles).
function buscarCampo(campos, nombresPosibles) {
  const buscados = nombresPosibles.map(normalizar);
  const campo = campos.find((c) => buscados.includes(normalizar(c.name)));
  return campo ? campo.id : null;
}

// Busca el id del service desk (JSM) del proyecto configurado en PROJECT_KEY.
async function idServiceDesk() {
  let inicio = 0;
  let ultima = false;
  while (!ultima) {
    const pagina = await llamarJira(
      route`/rest/servicedeskapi/servicedesk?start=${inicio}&limit=50`,
      { headers: { Accept: 'application/json' } },
      'listar service desks'
    );
    const encontrado = (pagina.values || []).find((d) => d.projectKey === PROJECT_KEY);
    if (encontrado) return encontrado.id;
    ultima = pagina.isLastPage !== false;
    inicio += 50;
  }
  throw new Error(`No se encontro el service desk del proyecto ${PROJECT_KEY}.`);
}

// Organizaciones del cliente en ese service desk. El endpoint con el parametro
// accountId viene de un hilo de la comunidad de Atlassian (VALIDAR en la prueba).
async function organizacionesDelUsuario(accountId) {
  const idDesk = await idServiceDesk();
  const encontradas = [];
  let inicio = 0;
  let ultima = false;
  while (!ultima) {
    const pagina = await llamarJira(
      route`/rest/servicedeskapi/servicedesk/${idDesk}/organization?accountId=${accountId}&start=${inicio}&limit=50`,
      { headers: { Accept: 'application/json' } },
      'organizaciones del cliente'
    );
    (pagina.values || []).forEach((o) => encontradas.push({ id: o.id, name: o.name }));
    ultima = pagina.isLastPage !== false;
    inicio += 50;
  }
  return encontradas;
}

// --------------------------- resolver principal ----------------------------

resolver.define('generarReporte', async (req) => {
  const { desde, hasta } = req.payload || {};
  const { accountId, accountType } = req.context;

  // Seguridad: solo usuarios identificados; la identidad la pone Forge.
  if (!accountId || accountType === 'anonymous') {
    throw new Error('Debe iniciar sesion para descargar el reporte.');
  }

  // Validacion de fechas (formato AAAA-MM-DD y rango maximo en dias).
  const patron = /^\d{4}-\d{2}-\d{2}$/;
  if (!patron.test(desde) || !patron.test(hasta)) throw new Error('Fechas invalidas.');
  const fDesde = new Date(`${desde}T00:00:00Z`);
  const fHasta = new Date(`${hasta}T00:00:00Z`);
  if (fDesde > fHasta) throw new Error('La fecha inicial es mayor que la final.');
  if ((fHasta - fDesde) / 86400000 + 1 > MAX_DIAS) {
    throw new Error(`El rango maximo es de ${MAX_DIAS} dias.`);
  }
  // Fin exclusivo: dia siguiente a "hasta".
  const finExclusivo = new Date(fHasta.getTime() + 86400000).toISOString().slice(0, 10);

  const inicioMs = Date.now();
  const avisos = new Set();

  // 1. Organizaciones del usuario (se calculan en el servidor).
  const orgs = await organizacionesDelUsuario(accountId);
  console.log('Organizaciones del usuario', JSON.stringify(orgs));
  if (!orgs.length) {
    throw new Error('Su usuario no pertenece a ninguna organizacion.');
  }

  // 2. Ids de los campos personalizados por nombre.
  const campos = await llamarJira(
    route`/rest/api/3/field`,
    { headers: { Accept: 'application/json' } },
    'listar campos'
  );
  const idTipo = buscarCampo(campos, ['Request Type', 'Tipo de solicitud']);
  const idModulo = buscarCampo(campos, ['Modulo']);
  const idPantalla = buscarCampo(campos, ['Pantalla']);
  const idTiempo = buscarCampo(campos, [
    'Time to resolution',
    'Tiempo hasta resolucion',
    'Tiempo hasta la resolucion',
  ]);

  // Definicion de columnas, en el orden del reporte.
  const columnas = [
    { titulo: 'Tipo de solicitud', ancho: 22, campo: idTipo },
    { titulo: 'Clave', ancho: 12, campo: 'key' },
    { titulo: 'Resumen', ancho: 50, campo: 'summary' },
    { titulo: 'Informador', ancho: 26, campo: 'reporter' },
    { titulo: 'Persona asignada', ancho: 26, campo: 'assignee' },
    { titulo: 'Estado', ancho: 18, campo: 'status' },
    { titulo: 'Creada', ancho: 20, campo: 'created', tipo: 'fecha' },
    { titulo: 'Modulo', ancho: 18, campo: idModulo },
    { titulo: 'Prioridad', ancho: 14, campo: 'priority' },
    { titulo: 'Tiempo hasta resolucion', ancho: 24, campo: idTiempo },
    { titulo: 'Pantalla', ancho: 24, campo: idPantalla },
  ];
  columnas.forEach((c) => {
    if (!c.campo) avisos.add(`No se encontro el campo "${c.titulo}" en Jira.`);
  });
  const camposPedidos = columnas
    .map((c) => c.campo)
    .filter((c) => c && c !== 'key');

  // 3. JQL: proyecto + organizaciones + rango de fechas.
  const listaOrgs = orgs.map((o) => `"${escaparJql(o.name)}"`).join(', ');
  const jql =
    `project = "${escaparJql(PROJECT_KEY)}" AND organizations in (${listaOrgs}) ` +
    `AND created >= "${desde}" AND created < "${finExclusivo}" ORDER BY created DESC`;
  console.log('JQL', jql);

  // 4. Busqueda paginada con token (endpoint de busqueda actual de Jira Cloud).
  const filas = [];
  let token;
  let truncado = false;
  do {
    const cuerpo = { jql, fields: camposPedidos, maxResults: TAM_PAGINA };
    if (token) cuerpo.nextPageToken = token;
    const pagina = await llamarJira(
      route`/rest/api/3/search/jql`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
      },
      'buscar solicitudes (JQL)'
    );
    for (const issue of pagina.issues || []) {
      filas.push(
        columnas.map((c) => {
          if (c.campo === 'key') return issue.key;
          if (c.campo === 'reporter') return correoInformador(issue.fields.reporter, avisos);
          if (!c.campo) return '';
          return formatear(issue.fields[c.campo], avisos, c.titulo);
        })
      );
    }
    token = pagina.nextPageToken;
    if (filas.length >= MAX_FILAS || Date.now() - inicioMs > MAX_MS) {
      truncado = Boolean(token);
      break;
    }
  } while (token);

  return {
    columnas: columnas.map(({ titulo, ancho, tipo }) => ({ titulo, ancho, tipo })),
    filas,
    truncado,
    avisos: [...avisos],
  };
});

export const handler = resolver.getDefinitions();
