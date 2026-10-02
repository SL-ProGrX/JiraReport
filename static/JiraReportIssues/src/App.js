import React, { useState } from 'react';
import { invoke, view } from '@forge/bridge';
// Version "bundle" de ExcelJS pensada para navegador (documentada en su README).
import ExcelJS from 'exceljs/dist/exceljs.min.js';
import './App.css';

// ---- Utilidades de fechas (formato AAAA-MM-DD) ----
const dos = (n) => String(n).padStart(2, '0');
const aTexto = (f) => `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`;
const ultimoDia = (anio, mes) => new Date(anio, mes + 1, 0).getDate();

// Rango maximo permitido, en dias (debe coincidir con MAX_DIAS del resolver).
const MAX_DIAS = 90;
const MS_DIA = 86400000;
const aFecha = (texto) => new Date(`${texto}T00:00:00`);
const sumarDias = (texto, dias) => aTexto(new Date(aFecha(texto).getTime() + dias * MS_DIA));
// Dias del rango, contando ambos extremos.
const diasRango = (d, h) => Math.round((aFecha(h) - aFecha(d)) / MS_DIA) + 1;

// Rangos predefinidos: mes actual, mes anterior y quincenas del mes actual.
function rangos() {
  const hoy = new Date();
  const a = hoy.getFullYear();
  const m = hoy.getMonth();
  const mesAnt = new Date(a, m - 1, 1);
  return [
    { id: 'mes', texto: 'Mes actual', desde: aTexto(new Date(a, m, 1)), hasta: aTexto(new Date(a, m, ultimoDia(a, m))) },
    {
      id: 'mesAnt',
      texto: 'Mes anterior',
      desde: aTexto(mesAnt),
      hasta: aTexto(new Date(mesAnt.getFullYear(), mesAnt.getMonth(), ultimoDia(mesAnt.getFullYear(), mesAnt.getMonth()))),
    },
    { id: 'q1', texto: '1a quincena', desde: aTexto(new Date(a, m, 1)), hasta: aTexto(new Date(a, m, 15)) },
    { id: 'q2', texto: '2a quincena', desde: aTexto(new Date(a, m, 16)), hasta: aTexto(new Date(a, m, ultimoDia(a, m))) },
  ];
}

// Construye el archivo .xlsx en memoria a partir de columnas y filas.
async function construirExcel({ columnas, filas }) {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Solicitudes');
  hoja.columns = columnas.map((c) => ({ header: c.titulo, key: c.titulo, width: c.ancho }));
  filas.forEach((fila) => {
    hoja.addRow(
      fila.map((valor, i) => (columnas[i].tipo === 'fecha' && valor ? new Date(valor) : valor))
    );
  });
  // Formato de fecha y encabezado en negrita con filtro.
  columnas.forEach((c, i) => {
    if (c.tipo === 'fecha') hoja.getColumn(i + 1).numFmt = 'yyyy-mm-dd hh:mm';
  });
  hoja.getRow(1).font = { bold: true };
  hoja.views = [{ state: 'frozen', ySplit: 1 }];
  hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnas.length } };
  return libro.xlsx.writeBuffer();
}

function App() {
  const predef = rangos();
  const [desde, setDesde] = useState(predef[0].desde);
  const [hasta, setHasta] = useState(predef[0].hasta);
  const [activo, setActivo] = useState(predef[0].id);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [resultado, setResultado] = useState(null);

  // Validacion del rango en pantalla (el servidor tambien la aplica).
  let errorRango = '';
  let dias = 0;
  if (desde && hasta) {
    dias = diasRango(desde, hasta);
    if (dias < 1) errorRango = 'La fecha inicial es mayor que la final.';
    else if (dias > MAX_DIAS) errorRango = `El rango maximo es de ${MAX_DIAS} dias (seleccionado: ${dias}).`;
  }

  // Cualquier cambio de fechas invalida el reporte ya generado.
  const elegirPredef = (r) => { setDesde(r.desde); setHasta(r.hasta); setActivo(r.id); setResultado(null); setError(''); };
  const cambiarDesde = (v) => { setDesde(v); setActivo(null); setResultado(null); setError(''); };
  const cambiarHasta = (v) => { setHasta(v); setActivo(null); setResultado(null); setError(''); };

  // Paso 1: pedir los datos al resolver y preparar el archivo.
  const generar = async () => {
    setCargando(true);
    setError('');
    setResultado(null);
    try {
      const datos = await invoke('generarReporte', { desde, hasta });
      const buffer = await construirExcel(datos);
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      setResultado({ blob, total: datos.filas.length, truncado: datos.truncado, avisos: datos.avisos });
    } catch (e) {
      setError(e && e.message ? e.message : 'No se pudo generar el reporte.');
    } finally {
      setCargando(false);
    }
  };

  // Paso 2: la descarga ocurre en un clic directo del usuario (requisito del navegador).
  const descargar = () => {
    const url = URL.createObjectURL(resultado.blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = `reporte_solicitudes_${desde}_a_${hasta}.xlsx`;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rp">
      <h2 className="rp__titulo">Descargar reporte de solicitudes</h2>
      <p className="rp__sub">Obtenga en Excel las solicitudes de su organizacion para el periodo que elija.</p>

      <div className="rp__seccion">
        <span className="rp__etiqueta">Periodo rapido</span>
        <div className="rp__chips">
          {predef.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`rp__chip${activo === r.id ? ' rp__chip--activo' : ''}`}
              onClick={() => elegirPredef(r)}
            >
              {r.texto}
            </button>
          ))}
        </div>
      </div>

      <div className="rp__seccion">
        <span className="rp__etiqueta">O elija las fechas</span>
        <div className="rp__fechas">
          <div className="rp__campo">
            <label htmlFor="rp-desde">Desde</label>
            <input id="rp-desde" type="date" value={desde} onChange={(e) => cambiarDesde(e.target.value)} />
          </div>
          <div className="rp__campo">
            <label htmlFor="rp-hasta">Hasta</label>
            <input
              id="rp-hasta"
              type="date"
              value={hasta}
              min={desde || undefined}
              max={desde ? sumarDias(desde, MAX_DIAS - 1) : undefined}
              onChange={(e) => cambiarHasta(e.target.value)}
            />
          </div>
        </div>
        <p className="rp__ayuda">
          {dias > 0 && !errorRango ? `${dias} ${dias === 1 ? 'dia seleccionado' : 'dias seleccionados'}. ` : ''}
          Maximo {MAX_DIAS} dias por reporte.
        </p>
      </div>

      {errorRango && <div className="rp__aviso rp__aviso--error" role="alert">{errorRango}</div>}

      <div className="rp__acciones">
        <button
          type="button"
          className="rp__btn rp__btn--primario"
          onClick={generar}
          disabled={cargando || !desde || !hasta || Boolean(errorRango)}
        >
          {cargando && <span className="rp__spinner" aria-hidden="true" />}
          {cargando ? 'Generando reporte...' : 'Generar reporte'}
        </button>
        <button type="button" className="rp__btn rp__btn--secundario" onClick={() => view.close()}>
          Cerrar
        </button>
      </div>

      {error && <div className="rp__aviso rp__aviso--error" role="alert">{error}</div>}

      {resultado && (
        <div className={`rp__resultado${resultado.total > 0 ? ' rp__resultado--ok' : ''}`} aria-live="polite">
          <p className="rp__resultado-titulo">
            {resultado.total === 0 ? 'Sin resultados' : 'Su reporte esta listo'}
          </p>
          <p className="rp__resultado-texto">
            {resultado.total === 0
              ? 'No hay solicitudes en ese periodo. Pruebe con otras fechas.'
              : `${resultado.total} ${resultado.total === 1 ? 'solicitud encontrada' : 'solicitudes encontradas'} entre ${desde} y ${hasta}.`}
          </p>
          {resultado.total > 0 && (
            <button type="button" className="rp__btn rp__btn--exito" onClick={descargar}>
              Descargar Excel
            </button>
          )}
          {resultado.truncado && (
            <div className="rp__aviso rp__aviso--ambar">Se alcanzo el limite de filas. Use un rango menor para ver todo.</div>
          )}
          {resultado.avisos.map((a) => (
            <div key={a} className="rp__aviso rp__aviso--ambar">{a}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
