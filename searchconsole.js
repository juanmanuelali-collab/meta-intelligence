/**
 * searchconsole.js — Docta Nexus / Growth Intelligence Platform
 *
 * Conector de Google Search Console. Reusa la MISMA Service Account que
 * ya usa GA4 (GA4_SERVICE_ACCOUNT) — no hace falta credencial nueva, solo
 * hay que agregar ese email como usuario en Search Console de cada
 * propiedad (Configuración → Usuarios y permisos), igual que ya se hace
 * hoy en GA4.
 *
 * Dos APIs distintas de Google conviven acá:
 * - Search Analytics (dentro de "webmasters" v3): clics/impresiones/CTR/
 *   posición, con dimensiones (consulta, página, país, dispositivo).
 * - URL Inspection (dentro de "searchconsole" v1): estado de indexación
 *   por URL puntual — no existe un reporte masivo, es 1 URL por llamada.
 *
 * La propiedad se identifica con el mismo string que figura en Search
 * Console — puede ser un prefijo de URL ("https://www.cliente.com/") o
 * un dominio verificado por DNS ("sc-domain:cliente.com"). Se guarda tal
 * cual el usuario lo pegue, sin normalizar ni asumir un formato.
 */

const { google } = require('googleapis');

function getSearchConsoleAuth() {
  const raw = process.env.GA4_SERVICE_ACCOUNT || '{}';
  const creds = JSON.parse(raw);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  if (!creds.client_email) {
    console.error('[search-console] GA4_SERVICE_ACCOUNT sin client_email — verificar variable de entorno');
  }
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
}

// Search Console pisa datos de los últimos 2-3 días — nunca hay "hoy" ni
// "ayer" confiables. Todo rango que le llegue a este módulo se corre 3
// días hacia atrás antes de consultar la API.
function shiftRangeForDelay(since, until) {
  const shift = (d) => { const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 3); return dt.toISOString().slice(0, 10); };
  return { since: shift(since), until: shift(until) };
}

async function runSearchAnalyticsQuery(propertyUrl, body) {
  const auth = getSearchConsoleAuth();
  const searchconsole = google.webmasters({ version: 'v3', auth });
  const res = await searchconsole.searchanalytics.query({ siteUrl: propertyUrl, requestBody: body });
  return res.data.rows || [];
}

// ── Resumen (clics/impresiones/CTR/posición) + serie diaria ──
async function fetchSearchConsoleSummary(propertyUrl, since, until) {
  const { since: s, until: u } = shiftRangeForDelay(since, until);
  const rows = await runSearchAnalyticsQuery(propertyUrl, {
    startDate: s, endDate: u, dimensions: ['date'], rowLimit: 1000,
  });
  const daily = rows.map(r => ({
    date: r.keys[0], clicks: r.clicks || 0, impressions: r.impressions || 0,
    ctr: +((r.ctr || 0) * 100).toFixed(2), position: +((r.position || 0)).toFixed(1),
  })).sort((a, b) => a.date.localeCompare(b.date));

  const totalClicks = daily.reduce((s2, d) => s2 + d.clicks, 0);
  const totalImpressions = daily.reduce((s2, d) => s2 + d.impressions, 0);
  const avgPosition = daily.length ? +(daily.reduce((s2, d) => s2 + d.position * d.impressions, 0) / (totalImpressions || 1)).toFixed(1) : null;
  const ctr = totalImpressions > 0 ? +(totalClicks / totalImpressions * 100).toFixed(2) : null;

  return { clicks: totalClicks, impressions: totalImpressions, ctr, position: avgPosition, daily, range_used: { since: s, until: u } };
}

// ── Top consultas de búsqueda ──
async function fetchTopQueries(propertyUrl, since, until, limit = 20) {
  const { since: s, until: u } = shiftRangeForDelay(since, until);
  const rows = await runSearchAnalyticsQuery(propertyUrl, {
    startDate: s, endDate: u, dimensions: ['query'], rowLimit: limit,
  });
  return rows.map(r => ({
    query: r.keys[0], clicks: r.clicks || 0, impressions: r.impressions || 0,
    ctr: +((r.ctr || 0) * 100).toFixed(2), position: +((r.position || 0)).toFixed(1),
  }));
}

// ── Top páginas ──
async function fetchTopPages(propertyUrl, since, until, limit = 20) {
  const { since: s, until: u } = shiftRangeForDelay(since, until);
  const rows = await runSearchAnalyticsQuery(propertyUrl, {
    startDate: s, endDate: u, dimensions: ['page'], rowLimit: limit,
  });
  return rows.map(r => ({
    page: r.keys[0], clicks: r.clicks || 0, impressions: r.impressions || 0,
    ctr: +((r.ctr || 0) * 100).toFixed(2), position: +((r.position || 0)).toFixed(1),
  }));
}

// ── Por país ──
async function fetchByCountry(propertyUrl, since, until, limit = 10) {
  const { since: s, until: u } = shiftRangeForDelay(since, until);
  const rows = await runSearchAnalyticsQuery(propertyUrl, {
    startDate: s, endDate: u, dimensions: ['country'], rowLimit: limit,
  });
  return rows.map(r => ({ country: r.keys[0], clicks: r.clicks || 0, impressions: r.impressions || 0 }));
}

// ── Por dispositivo ──
async function fetchByDevice(propertyUrl, since, until) {
  const { since: s, until: u } = shiftRangeForDelay(since, until);
  const rows = await runSearchAnalyticsQuery(propertyUrl, {
    startDate: s, endDate: u, dimensions: ['device'], rowLimit: 10,
  });
  return rows.map(r => ({ device: (r.keys[0] || '').toLowerCase(), clicks: r.clicks || 0, impressions: r.impressions || 0 }));
}

// ── Por tipo de resultado (web/imagen/video) — la API no tiene una
// dimensión única para esto; hay que correr la consulta una vez por tipo
// y comparar los totales. Se omite silenciosamente el tipo que falle
// (algunos sitios no tienen tráfico de imagen/video, y la API a veces
// devuelve error en vez de un total en cero para esos casos). ──
async function fetchBySearchType(propertyUrl, since, until) {
  const { since: s, until: u } = shiftRangeForDelay(since, until);
  const types = [{ key: 'web', label: 'Web' }, { key: 'image', label: 'Imagen' }, { key: 'video', label: 'Video' }];
  const results = await Promise.all(types.map(async (t) => {
    try {
      const rows = await runSearchAnalyticsQuery(propertyUrl, { startDate: s, endDate: u, type: t.key, rowLimit: 1 });
      const clicks = rows.reduce((sum, r) => sum + (r.clicks || 0), 0);
      return { type: t.label, clicks };
    } catch (e) {
      return null;
    }
  }));
  return results.filter(r => r && r.clicks > 0);
}

// ── URL Inspection: estado de indexación de UNA URL puntual ──
// No existe reporte masivo en la API pública — Search Console tampoco lo
// expone para su propia interfaz web por API, así que esto es 1 llamada
// por URL, siempre. Se usa contra las URLs de "Top páginas" (las que
// traen tráfico real), más un botón suelto para chequear cualquier otra.
async function inspectUrl(propertyUrl, pageUrl) {
  const auth = getSearchConsoleAuth();
  const searchconsole = google.searchconsole({ version: 'v1', auth });
  const res = await searchconsole.urlInspection.index.inspect({
    requestBody: { inspectionUrl: pageUrl, siteUrl: propertyUrl },
  });
  const result = res.data.inspectionResult?.indexStatusResult || {};
  const verdictMap = {
    PASS: 'indexada', NEUTRAL: 'sin verificar', FAIL: 'no indexada', PARTIAL: 'parcial',
  };
  return {
    url: pageUrl,
    verdict: verdictMap[result.verdict] || (result.verdict || 'desconocido').toLowerCase(),
    coverage_state: result.coverageState || null,
    last_crawl: result.lastCrawlTime || null,
    indexed: result.verdict === 'PASS',
  };
}

module.exports = {
  fetchSearchConsoleSummary, fetchTopQueries, fetchTopPages,
  fetchByCountry, fetchByDevice, fetchBySearchType, inspectUrl,
};
