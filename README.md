# JiraReport (PGX_Force)

Aplicacion Forge para Jira Service Management que agrega al portal de clientes una opcion de menu llamada **Descargar reporte**. Con ella, cada cliente descarga en Excel las solicitudes de su(s) organizacion(es), incluyendo campos que no ve en la lista del portal.

## Que es

Una app de Atlassian Forge (Custom UI) con dos partes:

- **Modal del portal** (`static/JiraReportIssues`, React): se abre desde el menu de usuario del portal. El cliente elige el periodo, genera el reporte y descarga el archivo `.xlsx`. El Excel se arma en el navegador con ExcelJS.
- **Resolver** (`src/index.js`, Node.js en Forge): consulta Jira con permisos de app y devuelve las filas ya listas.

Modulo Forge usado: `jiraServiceManagement:portalUserMenuAction`, con acceso para clientes sin licencia (`unlicensedAccess: customer`).

## Para que sirve

Permite que el cliente obtenga por su cuenta un reporte con mas campos de los que muestra el portal, sin pedirlo al equipo de soporte y sin tener cuenta Atlassian.

Columnas del reporte: Tipo de solicitud, Clave, Resumen, Informador (correo), Persona asignada, Estado, Creada, Modulo, Prioridad, Tiempo hasta resolucion y Pantalla.

Reglas del reporte:

- Incluye las solicitudes del proyecto `SL` de todas las organizaciones a las que pertenece el cliente.
- Periodos rapidos: mes actual, mes anterior, 1a y 2a quincena, o rango libre de fechas.
- Maximo **90 dias** por reporte y 5.000 filas (limite de tiempo de Forge: 25 s).
- La organizacion se determina en el servidor con la identidad que entrega Forge (`accountId`), nunca con datos enviados por el navegador.

## Estructura

```
manifest.yml                 Modulo, permisos (scopes) y datos de la app Forge
src/index.js                 Resolver: organizaciones, campos, busqueda JQL
static/JiraReportIssues/          Modal (React, Custom UI)
  src/App.js                 Logica del modal y generacion del Excel
  src/App.css                Estilos del modal
```

## Requisitos

- Node.js 22.x o 24.x (LTS).
- Forge CLI: `npm install -g @forge/cli`
- Sesion iniciada: `forge login` (correo de Atlassian y un token de API de https://id.atlassian.com/manage-profile/security/api-tokens). No guarde el token en el repositorio.
- Permisos de administrador del sitio de Jira y acceso a la consola de desarrolladores de Atlassian.

## Instalar dependencias

Desde la raiz del proyecto:

```
npm install
cd static\JiraReportIssues
npm install
cd ..\..
```

Los archivos `.npmrc` activan `legacy-peer-deps` para evitar un conflicto de dependencias opcionales (`typescript`) con `@forge/bridge`.

## Como se ejecuta

El modal necesita compilarse antes de desplegar. Desde la raiz:

```
cd static\JiraReportIssues
npm run build
cd ..\..
forge lint
forge deploy -e production
```

La primera vez, instale la app en el sitio:

```
forge install -e production
```

Elija el producto (Jira Service Management) y el sitio. Luego abra el portal con un cliente que pertenezca a una organizacion, y use el menu de usuario, opcion **Descargar reporte**.

Para depurar con recarga en vivo existe `forge tunnel`, pero el portal real usa la version desplegada.

## Pasos para actualizar la app en Jira

1. Hacer los cambios en `src/index.js`, `static/JiraReportIssues/src/` o `manifest.yml`.
2. Si cambio el modal, compilar de nuevo:
   ```
   cd static\JiraReportIssues
   npm run build
   cd ..\..
   ```
3. Revisar el manifest: `forge lint`
4. Desplegar a produccion: `forge deploy -e production`
5. Si el despliegue pide aprobacion por cambio de version mayor (ocurre al agregar o cambiar scopes), ejecutar el comando que indique, por ejemplo: `forge deploy -e production --approve MAJOR_VERSION_RULE`
6. Solo si cambiaron permisos (scopes) o el acceso del modulo, actualizar la instalacion: `forge install -e production --upgrade`
7. Recargar el portal con Ctrl+F5 y probar con un usuario cliente. Puede haber hasta 5 minutos de cache.
8. Si algo falla, ver los registros: `forge logs -e production -n 50`

Cambios de solo codigo (sin tocar permisos) llegan al sitio con `forge deploy`, sin reinstalar.

## Configuracion

| Que | Donde | Valor actual |
| --- | --- | --- |
| Proyecto de servicio | `PROJECT_KEY` en `src/index.js` | `SL` |
| Dias maximos por reporte | `MAX_DIAS` en `src/index.js` y en `static/JiraReportIssues/src/App.js` | 90 (cambiar en ambos archivos) |
| Maximo de filas | `MAX_FILAS` en `src/index.js` | 5000 |
| Columnas del reporte | arreglo `columnas` en `src/index.js` | ver arriba |

Los campos personalizados (Modulo, Pantalla, Tiempo hasta resolucion, Tipo de solicitud) se buscan por nombre. Si se renombra uno en Jira, ajuste los nombres en `src/index.js` o la columna saldra vacia y el modal mostrara un aviso.

## Notas importantes

- **Distribucion "Sharing":** para que los clientes (que no tienen cuenta Atlassian) no vean la pantalla "permita que la app acceda a productos Atlassian en su nombre", la app debe estar en modo **Sharing** en la consola de desarrolladores (https://developer.atlassian.com/console/myapps/, app, **Distribution**, **Distribution controls**, **Edit**). Esto requiere que la app este desplegada en produccion.
- **Una sola instalacion:** si la app esta instalada en `development` y en `production` en el mismo sitio, el menu aparece duplicado. Mantener solo produccion. Para quitar la de development: `forge uninstall -e development`.
- **Ambientes:** `forge deploy` sin `-e` actualiza development. Para el portal real use siempre `-e production`.
- **Scopes actuales:** `read:jira-work`, `read:servicedesk-request` y `manage:servicedesk-customer` (este ultimo se usa para obtener las organizaciones de un cliente). Agregar scopes obliga a aprobar un cambio de version mayor y a usar `forge install --upgrade`.
- **Privacidad:** el reporte muestra el correo del informador de cada solicitud de la organizacion. Si Jira no expone el correo de una cuenta, se muestra el nombre y el modal lo indica.
- **Limites de Forge relevantes:** 25 s de ejecucion por funcion, 100 llamadas externas por minuto de ejecucion y 5 MB de respuesta al frontend. Un rango de 90 dias con volumen alto podria acercarse a estos limites.

## Solucion de problemas

| Sintoma | Causa probable |
| --- | --- |
| Se ve el menu antiguo ("Hello world") | No se compilo el modal o no se desplego/actualizo la instalacion correcta. |
| Dos opciones "Descargar reporte" | Instalacion duplicada en development y production. |
| Cliente ve "allow the app to access Atlassian products" | La app no esta en modo Sharing (o no esta en produccion). |
| Error `Jira respondio 401 en: ...` | Falta un scope o no se hizo `forge install --upgrade` tras cambiarlos. El texto indica cual llamada fallo. |
| "Su usuario no pertenece a ninguna organizacion" | El cliente no esta en una organizacion vinculada al service desk del proyecto. |
| Columna vacia | El campo no se encontro por nombre, o el formato del valor no es reconocido (el modal avisa). |
| `npm install` falla con ERESOLVE | Usar `npm install --legacy-peer-deps` (los `.npmrc` ya lo activan). |
| `forge deploy` pide aprobacion | Cambio de scopes: usar `--approve MAJOR_VERSION_RULE`. |

## Documentacion de referencia

- Modulo del portal: https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-service-management-portal-user-menu-action/
- Acceso de clientes sin licencia: https://developer.atlassian.com/platform/forge/access-to-forge-apps-for-unlicensed-jsm-users
- Distribucion de apps: https://developer.atlassian.com/platform/forge/distribute-your-apps
- Limites de invocacion: https://developer.atlassian.com/platform/forge/limits-invocation/
