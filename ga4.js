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

// ── Traer usuarios/sesiones desglosados por canal de adquisición, para UN RANGO de fechas ──
// En vivo — pensado para los filtros de período de la solapa Analytics
// (Ayer/7d/14d/Mes/Semana N). Mismo reporte que fetchGA4AcquisitionForDate,
// solo que agrega sobre todo el rango en vez de un único día.
async function fetchGA4AcquisitionForRange(propertyId, since, until) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const property = `properties/${propertyId}`;

  const [trafficRes, purchaseRes, keyEventsRes] = await Promise.all([
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: since, endDate: until }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'userEngagementDuration' },
          { name: 'bounceRate' },
        ],
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: since, endDate: until }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }, { name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
      },
    }),
    // Eventos clave (keyEvents) por canal — fallback cuando el sitio no tiene "purchase" configurado.
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: since, endDate: until }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'keyEvents' }],
      },
    }).catch(() => ({ data: { rows: [] } })),
  ]);

  const purchasesByChannel = {};
  (purchaseRes.data.rows || []).forEach(row => {
    if (row.dimensionValues?.[1]?.value === 'purchase') {
      purchasesByChannel[row.dimensionValues[0].value] = Number(row.metricValues?.[0]?.value || 0);
    }
  });
  const keyEventsByChannel = {};
  (keyEventsRes.data.rows || []).forEach(row => {
    keyEventsByChannel[row.dimensionValues?.[0]?.value] = Number(row.metricValues?.[0]?.value || 0);
  });

  return (trafficRes.data.rows || []).map(row => {
    const channel = row.dimensionValues?.[0]?.value || '(sin canal)';
    const sessions = Number(row.metricValues?.[0]?.value || 0);
    const purchases = purchasesByChannel[channel] || 0;
    const keyEvents = keyEventsByChannel[channel] || 0;
    const hasPurchase = purchases > 0;
    return {
      channel,
      sessions,
      users: Number(row.metricValues?.[1]?.value || 0),
      avg_engagement_seconds: sessions ? +(Number(row.metricValues?.[2]?.value || 0) / sessions).toFixed(1) : 0,
      bounce_rate: +(Number(row.metricValues?.[3]?.value || 0) * 100).toFixed(1),
      purchases,
      purchase_conversion_rate: sessions ? +(purchases / sessions * 100).toFixed(2) : 0,
      key_events: keyEvents,
      key_events_conversion_rate: sessions ? +(keyEvents / sessions * 100).toFixed(2) : 0,
      // Tasa a mostrar: purchase si el sitio la tiene configurada, si no eventos clave en general.
      conversion_rate: hasPurchase ? (sessions ? +(purchases / sessions * 100).toFixed(2) : 0) : (sessions ? +(keyEvents / sessions * 100).toFixed(2) : 0),
      conversion_rate_type: hasPurchase ? 'purchase' : 'key_events',
    };
  }).sort((a, b) => b.sessions - a.sessions);
}

// ── Métricas de usuarios a nivel SITIO, para UN RANGO de fechas ──
// En vivo — misma lógica que fetchGA4SiteMetricsForDate (cron), agregada
// sobre todo el rango en vez de un único día.
async function fetchGA4SiteMetricsForRange(propertyId, since, until) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const res = await analyticsData.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: since, endDate: until }],
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
    has_data: totalUsers > 0 || newUsers > 0,
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
      metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    },
  });
  const getEvt = (name) => {
    const row = (res.data.rows || []).find(r => r.dimensionValues?.[0]?.value === name);
    return row ? { count: Number(row.metricValues[0].value), users: Number(row.metricValues[1].value) } : { count: 0, users: 0 };
  };
  const counts = {};
  GA4_FUNNEL_EVENTS.forEach(e => { counts[e] = getEvt(e); });
  return counts;
}

// ── Productos con detalle de funnel (vistos/agregados al carrito/comprados/ingresos) ──
async function fetchGA4TopItemsDetailed(propertyId, since, until, limit = 8) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const res = await analyticsData.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: since, endDate: until }],
      dimensions: [{ name: 'itemName' }],
      metrics: [{ name: 'itemsViewed' }, { name: 'itemsAddedToCart' }, { name: 'itemsPurchased' }, { name: 'itemRevenue' }],
      orderBys: [{ metric: { metricName: 'itemsPurchased' }, desc: true }],
      limit,
    },
  });
  return (res.data.rows || []).map(r => ({
    item: r.dimensionValues?.[0]?.value || '(sin datos)',
    viewed: Number(r.metricValues?.[0]?.value || 0),
    added_to_cart: Number(r.metricValues?.[1]?.value || 0),
    purchased: Number(r.metricValues?.[2]?.value || 0),
    revenue: Number(r.metricValues?.[3]?.value || 0),
  }));
}

// ── Sesiones/usuarios por tipo de dispositivo ──
async function fetchGA4DeviceBreakdown(propertyId, since, until) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const [res, eventsRes] = await Promise.all([
    analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: since, endDate: until }],
        dimensions: [{ name: 'deviceCategory' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      },
    }),
    analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: since, endDate: until }],
        dimensions: [{ name: 'deviceCategory' }, { name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
      },
    }).catch(() => ({ data: { rows: [] } })),
  ]);
  const purchasesByDevice = {};
  (eventsRes.data.rows || []).forEach(r => { if (r.dimensionValues?.[1]?.value === 'purchase') purchasesByDevice[r.dimensionValues[0].value] = Number(r.metricValues?.[0]?.value || 0); });
  return (res.data.rows || []).map(r => {
    const device = r.dimensionValues?.[0]?.value || '(sin datos)';
    const sessions = Number(r.metricValues?.[0]?.value || 0);
    const purchases = purchasesByDevice[device] || 0;
    return {
      device, sessions, users: Number(r.metricValues?.[1]?.value || 0),
      conversion_rate: sessions ? +(purchases / sessions * 100).toFixed(2) : 0,
      conversion_rate_type: purchases > 0 ? 'purchase' : 'sin_datos',
    };
  });
}

// ── Demografía (edad/sexo) — requiere "Google Signals" habilitado en la
// propiedad; si no está, GA4 devuelve todo como "unknown" y acá se filtra,
// devolviendo null en vez de mostrar un gráfico vacío o inventado. ──
async function fetchGA4Demographics(propertyId, since, until) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const [ageRes, genderRes, ageEventsRes, genderEventsRes] = await Promise.all([
    analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: { dateRanges: [{ startDate: since, endDate: until }], dimensions: [{ name: 'userAgeBracket' }], metrics: [{ name: 'totalUsers' }, { name: 'sessions' }] },
    }),
    analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: { dateRanges: [{ startDate: since, endDate: until }], dimensions: [{ name: 'userGender' }], metrics: [{ name: 'totalUsers' }, { name: 'sessions' }] },
    }),
    analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: { dateRanges: [{ startDate: since, endDate: until }], dimensions: [{ name: 'userAgeBracket' }, { name: 'eventName' }], metrics: [{ name: 'eventCount' }] },
    }).catch(() => ({ data: { rows: [] } })),
    analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: { dateRanges: [{ startDate: since, endDate: until }], dimensions: [{ name: 'userGender' }, { name: 'eventName' }], metrics: [{ name: 'eventCount' }] },
    }).catch(() => ({ data: { rows: [] } })),
  ]);
  const purchasesByAge = {};
  (ageEventsRes.data.rows || []).forEach(r => { if (r.dimensionValues?.[1]?.value === 'purchase') purchasesByAge[r.dimensionValues[0].value] = Number(r.metricValues?.[0]?.value || 0); });
  const purchasesByGender = {};
  (genderEventsRes.data.rows || []).forEach(r => { if (r.dimensionValues?.[1]?.value === 'purchase') purchasesByGender[r.dimensionValues[0].value] = Number(r.metricValues?.[0]?.value || 0); });
  const age = (ageRes.data.rows || []).map(r => {
    const bracket = r.dimensionValues?.[0]?.value; const sessions = Number(r.metricValues?.[1]?.value || 0); const purchases = purchasesByAge[bracket] || 0;
    return { bracket, users: Number(r.metricValues?.[0]?.value || 0), conversion_rate: sessions ? +(purchases/sessions*100).toFixed(2) : 0 };
  }).filter(r => r.bracket && r.bracket !== 'unknown');
  const gender = (genderRes.data.rows || []).map(r => {
    const g = r.dimensionValues?.[0]?.value; const sessions = Number(r.metricValues?.[1]?.value || 0); const purchases = purchasesByGender[g] || 0;
    return { gender: g, users: Number(r.metricValues?.[0]?.value || 0), conversion_rate: sessions ? +(purchases/sessions*100).toFixed(2) : 0 };
  }).filter(r => r.gender && r.gender !== 'unknown');
  if (!age.length && !gender.length) return null;
  return { age, gender };
}

// ── Resumen de eventos clave (uno por uno, no agregado por canal) — para el
// Informe Frío. Trae eventName + eventCount + keyEvents en la misma fila:
// keyEvents > 0 en una fila es la señal de que ESE evento está marcado como
// "evento clave" en la configuración de GA4 (los eventos que no son clave
// devuelven 0 ahí aunque tengan actividad). La tasa de conversión de cada
// evento se calcula contra las sesiones totales del período.
async function fetchGA4KeyEventsSummary(propertyId, since, until) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const [eventsRes, sessionsRes] = await Promise.all([
    analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: since, endDate: until }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }, { name: 'keyEvents' }],
        orderBys: [{ metric: { metricName: 'keyEvents' }, desc: true }],
        limit: 50,
      },
    }),
    analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: { dateRanges: [{ startDate: since, endDate: until }], metrics: [{ name: 'sessions' }] },
    }),
  ]);
  const totalSessions = Number(sessionsRes.data.rows?.[0]?.metricValues?.[0]?.value || 0);
  return (eventsRes.data.rows || [])
    .map(r => {
      const eventName = r.dimensionValues?.[0]?.value || '(sin nombre)';
      const eventCount = Number(r.metricValues?.[0]?.value || 0);
      const keyEvents = Number(r.metricValues?.[1]?.value || 0);
      return {
        event_name: eventName, count: eventCount, key_events: keyEvents,
        is_key_event: keyEvents > 0,
        conversion_rate: totalSessions > 0 ? +(keyEvents / totalSessions * 100).toFixed(2) : null,
      };
    })
    .filter(e => e.is_key_event)
    .sort((a, b) => b.key_events - a.key_events);
}

// ── Por navegador ──
async function fetchGA4BrowserBreakdown(propertyId, since, until) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const res = await analyticsData.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: since, endDate: until }],
      dimensions: [{ name: 'browser' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 10,
    },
  });
  return (res.data.rows || []).map(r => ({
    browser: r.dimensionValues?.[0]?.value || '(sin datos)',
    sessions: Number(r.metricValues?.[0]?.value || 0),
  }));
}

// ── Por sistema operativo ──
async function fetchGA4OSBreakdown(propertyId, since, until) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const res = await analyticsData.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: since, endDate: until }],
      dimensions: [{ name: 'operatingSystem' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 10,
    },
  });
  return (res.data.rows || []).map(r => ({
    os: r.dimensionValues?.[0]?.value || '(sin datos)',
    sessions: Number(r.metricValues?.[0]?.value || 0),
  }));
}

// ── Resumen "Top Site": vistas, usuarios totales, usuarios nuevos, tiempo
// medio en página, % de rebote — con comparación automática contra el
// período INMEDIATO ANTERIOR de la misma duración (para las flechas de
// tendencia). Ej: si since-until son 30 días, el período anterior son los
// 30 días previos a "since".
async function fetchGA4TopSiteSummary(propertyId, since, until) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const sinceDate = new Date(since + 'T00:00:00Z');
  const untilDate = new Date(until + 'T00:00:00Z');
  const daySpan = Math.round((untilDate - sinceDate) / 86400000) + 1;
  const prevUntil = new Date(sinceDate); prevUntil.setUTCDate(prevUntil.getUTCDate() - 1);
  const prevSince = new Date(prevUntil); prevSince.setUTCDate(prevSince.getUTCDate() - daySpan + 1);
  const fmt = d => d.toISOString().slice(0, 10);

  const runOne = async (s, u) => {
    const res = await analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: s, endDate: u }],
        metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }, { name: 'newUsers' }, { name: 'averageSessionDuration' }, { name: 'bounceRate' }],
      },
    });
    const row = res.data.rows?.[0];
    const m = i => Number(row?.metricValues?.[i]?.value || 0);
    return { views: m(0), total_users: m(1), new_users: m(2), avg_engagement_seconds: m(3), bounce_rate: +(m(4) * 100).toFixed(2) };
  };

  const [current, previous] = await Promise.all([
    runOne(since, until),
    runOne(fmt(prevSince), fmt(prevUntil)).catch(() => null),
  ]);
  const pctChange = (curr, prev) => (prev == null || prev === 0) ? null : +(((curr - prev) / prev) * 100).toFixed(1);
  return {
    current, previous,
    change: previous ? {
      views: pctChange(current.views, previous.views),
      total_users: pctChange(current.total_users, previous.total_users),
      new_users: pctChange(current.new_users, previous.new_users),
      avg_engagement_seconds: pctChange(current.avg_engagement_seconds, previous.avg_engagement_seconds),
      bounce_rate: pctChange(current.bounce_rate, previous.bounce_rate),
    } : null,
  };
}

// ── Canales de tráfico ordenados por usuarios (no por sesiones), con
// tiempo de interacción media por canal — variante de
// fetchGA4AcquisitionForRange pero ordenada distinto y con menos campos,
// pensada puntual para el box de "Canales de Tráfico" del Informe Frío.
async function fetchGA4ChannelsByUsers(propertyId, since, until) {
  const auth = getGA4Auth();
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const res = await analyticsData.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: since, endDate: until }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'totalUsers' }, { name: 'averageSessionDuration' }],
      orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
      limit: 15,
    },
  });
  return (res.data.rows || []).map(r => ({
    channel: r.dimensionValues?.[0]?.value || '(sin datos)',
    users: Number(r.metricValues?.[0]?.value || 0),
    avg_engagement_seconds: Number(r.metricValues?.[1]?.value || 0),
  }));
}

module.exports = {
  getGA4Auth, fetchGA4WeeklyMetrics, fetchGA4AcquisitionForDate,
  fetchGA4SiteMetricsForDate, fetchGA4AcquisitionForRange, fetchGA4SiteMetricsForRange,
  fetchGA4TopPages, fetchGA4TopItems, fetchGA4FunnelCounts, GA4_FUNNEL_EVENTS,
  fetchGA4TopItemsDetailed, fetchGA4DeviceBreakdown, fetchGA4Demographics,
  fetchGA4KeyEventsSummary, fetchGA4BrowserBreakdown, fetchGA4OSBreakdown,
  fetchGA4TopSiteSummary, fetchGA4ChannelsByUsers,
};
