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

// ── Traer usuarios/sesiones desglosados por canal de adquisición, para UNA fecha puntual ──
// (pensado para el cron diario — igual que ad_metrics_daily para Meta/Google Ads,
// esto le da a Analytics un histórico diario real por canal)
async function fetchGA4AcquisitionForDate(propertyId, dateStr) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const property = `properties/${propertyId}`;

  const [trafficRes, purchaseRes] = await Promise.all([
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: dateStr, endDate: dateStr }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'userEngagementDuration' },
          { name: 'bounceRate' },
        ],
      },
    }),
    // Evento "purchase" desglosado por canal — reporte aparte porque mezclar
    // eventName con las métricas de tráfico de arriba da filas por evento,
    // no por sesión.
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: dateStr, endDate: dateStr }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }, { name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
      },
    }),
  ]);

  const purchasesByChannel = {};
  (purchaseRes.data.rows || []).forEach(row => {
    if (row.dimensionValues?.[1]?.value === 'purchase') {
      purchasesByChannel[row.dimensionValues[0].value] = Number(row.metricValues?.[0]?.value || 0);
    }
  });

  return (trafficRes.data.rows || []).map(row => {
    const channel = row.dimensionValues?.[0]?.value || '(sin canal)';
    const sessions = Number(row.metricValues?.[0]?.value || 0);
    return {
      channel,
      sessions,
      users: Number(row.metricValues?.[1]?.value || 0),
      avg_engagement_seconds: sessions ? +(Number(row.metricValues?.[2]?.value || 0) / sessions).toFixed(1) : 0,
      bounce_rate: +(Number(row.metricValues?.[3]?.value || 0) * 100).toFixed(1),
      purchases: purchasesByChannel[channel] || 0,
    };
  });
}

// ── Métricas de usuarios a nivel SITIO (sin desglose por canal), para UNA fecha ──
// Total de usuarios, usuarios nuevos, tiempo de interacción medio por
// usuario activo, y porcentaje de rebote. Pensado para el cron diario.
async function fetchGA4SiteMetricsForDate(propertyId, dateStr) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const res = await analyticsData.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: dateStr, endDate: dateStr }],
      metrics: [
        { name: 'totalUsers' },
        { name: 'newUsers' },
        { name: 'userEngagementDuration' },
        { name: 'activeUsers' },
        { name: 'bounceRate' },
      ],
    },
  });
  const v = res.data.rows?.[0]?.metricValues || [];
  const totalUsers = Number(v[0]?.value || 0);
  const newUsers = Number(v[1]?.value || 0);
  const engagementDuration = Number(v[2]?.value || 0);
  const activeUsers = Number(v[3]?.value || 0);
  const bounceRate = Number(v[4]?.value || 0);
  return {
    total_users: totalUsers,
    new_users: newUsers,
    avg_engagement_seconds: activeUsers ? +(engagementDuration / activeUsers).toFixed(1) : 0,
    bounce_rate: +(bounceRate * 100).toFixed(1),
  };
}

// ── Top URLs más visitadas, para un rango de fechas (en vivo, sin guardar histórico) ──
async function fetchGA4TopPages(propertyId, since, until, limit = 10) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const res = await analyticsData.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: since, endDate: until }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit,
    },
  });
  return (res.data.rows || []).map(r => ({
    path: r.dimensionValues?.[0]?.value || '(sin datos)',
    views: Number(r.metricValues?.[0]?.value || 0),
  }));
}

// ── Top artículos/productos más vistos, para un rango de fechas (en vivo) ──
async function fetchGA4TopItems(propertyId, since, until, limit = 10) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const res = await analyticsData.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: since, endDate: until }],
      dimensions: [{ name: 'itemName' }],
      metrics: [{ name: 'itemsViewed' }],
      orderBys: [{ metric: { metricName: 'itemsViewed' }, desc: true }],
      limit,
    },
  });
  return (res.data.rows || []).map(r => ({
    item: r.dimensionValues?.[0]?.value || '(sin datos)',
    views: Number(r.metricValues?.[0]?.value || 0),
  }));
}

// ── Funnel de eCommerce: conteo de los 6 eventos clave para un rango de fechas ──
const GA4_FUNNEL_EVENTS = ['view_item', 'add_to_cart', 'begin_checkout', 'add_shipping_info', 'add_payment_info', 'purchase'];
async function fetchGA4FunnelCounts(propertyId, since, until) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const res = await analyticsData.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: since, endDate: until }],
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
    },
  });
  const getEvt = (name) => {
    const row = (res.data.rows || []).find(r => r.dimensionValues?.[0]?.value === name);
    return row ? Number(row.metricValues[0].value) : 0;
  };
  const counts = {};
  GA4_FUNNEL_EVENTS.forEach(e => { counts[e] = getEvt(e); });
  return counts;
}

module.exports = {
  getGA4Auth, fetchGA4WeeklyMetrics, fetchGA4AcquisitionForDate,
  fetchGA4SiteMetricsForDate, fetchGA4TopPages, fetchGA4TopItems,
  fetchGA4FunnelCounts, GA4_FUNNEL_EVENTS,
};
