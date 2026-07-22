/**
 * ga4.js — Docta Nexus / Growth Intelligence Platform
 *
 * Conector de Google Analytics 4 (Data API). Solo trae y normaliza
 * MÉTRICAS de tráfico y eventos de eCommerce por semana — mismo
 * principio que el resto de los conectores (google_ads.js, Meta):
 * ningún análisis se mezcla acá.
 *
 * Autenticación: Service Account DEDICADA para Analytics, separada
 * de la que usa el proyecto para Google Sheets (GOOGLE_SERVICE_ACCOUNT).
 * Se guarda en la variable de entorno GA4_SERVICE_ACCOUNT (JSON completo
 * de la clave descargada de Google Cloud). Si en algún momento se rompe
 * esta credencial (rotación de clave, etc.), no afecta el logging de
 * costos en Sheets, que sigue usando su propia variable.
 *
 * Lo único que varía por cliente es el Property ID de GA4, que se
 * guarda en client_credentials (source='ga4'), igual que el Customer
 * ID de Google Ads.
 */

const { google } = require('googleapis');

function getGA4Auth() {
  const raw = process.env.GA4_SERVICE_ACCOUNT || '{}';
  const creds = JSON.parse(raw);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  if (!creds.client_email) {
    console.error('[ga4] GA4_SERVICE_ACCOUNT sin client_email — verificar variable de entorno');
  }
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
}

// ── Traer tráfico + eventos de eCommerce para un rango de fechas puntual ──
// (pensado para una semana lunes-a-domingo, pero acepta cualquier rango)
async function fetchGA4WeeklyMetrics(propertyId, since, until) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const property = `properties/${propertyId}`;

  const [trafficRes, eventsRes] = await Promise.all([
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: since, endDate: until }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'newUsers' },
          { name: 'engagedSessions' },
          { name: 'screenPageViews' },
        ],
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: since, endDate: until }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
      },
    }),
  ]);

  const t = trafficRes.data.rows?.[0]?.metricValues || [];
  const getEvt = (name) => {
    const row = (eventsRes.data.rows || []).find(r => r.dimensionValues?.[0]?.value === name);
    return row ? Number(row.metricValues[0].value) : 0;
  };

  return {
    sesiones: Number(t[0]?.value || 0),
    usuarios: Number(t[1]?.value || 0),
    usuarios_nuevos: Number(t[2]?.value || 0),
    sesiones_comprometidas: Number(t[3]?.value || 0),
    vistas_pagina: Number(t[4]?.value || 0),
    view_item: getEvt('view_item'),
    add_to_cart: getEvt('add_to_cart'),
    begin_checkout: getEvt('begin_checkout'),
    add_payment_info: getEvt('add_payment_info'),
    purchases: getEvt('purchase'),
  };
}

module.exports = { getGA4Auth, fetchGA4WeeklyMetrics };
