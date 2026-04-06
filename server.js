require('dotenv').config();
const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const fs         = require('fs');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const META_API_VERSION = 'v19.0';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPERS ───────────────────────────────────────────────────
function loadClient(slug) {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;
  const fp = path.join(__dirname, 'clients', slug + '.json');
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function listClients() {
  const dir = path.join(__dirname, 'clients');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

function saveData(slug, data) {
  const dir = path.join(__dirname, 'data', slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, date + '.json'), JSON.stringify(data, null, 2));
}

function loadHistory(slug, days = 7) {
  const dir = path.join(__dirname, 'data', slug);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort().reverse().slice(0, days);
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
}

function loadLatest(slug) {
  const history = loadHistory(slug, 1);
  return history[0] || null;
}

// ── META ADS API ──────────────────────────────────────────────
async function fetchMeta(endpoint, token) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${endpoint}&access_token=${token}`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error('Meta API: ' + d.error.message);
  return d;
}

async function getAccountMetrics(client) {
  const { ad_account_id, access_token } = client;
  const fields = 'spend,impressions,clicks,ctr,cpm,cpp,actions,action_values,frequency,reach';
  const dateRange = JSON.stringify({ since: getDateDaysAgo(7), until: getDateDaysAgo(0) });

  const [account, campaigns, adsets, ads] = await Promise.all([
    fetchMeta(`${ad_account_id}?fields=name,currency,account_status,amount_spent,balance&`, access_token),
    fetchMeta(`${ad_account_id}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,insights.date_preset(last_7d){${fields}}&limit=50&`, access_token),
    fetchMeta(`${ad_account_id}/adsets?fields=id,name,status,campaign_id,daily_budget,learning_stage_info,insights.date_preset(last_7d){${fields}}&limit=100&`, access_token),
    fetchMeta(`${ad_account_id}/ads?fields=id,name,status,adset_id,campaign_id,creative{id,name,thumbnail_url,body,title},insights.date_preset(last_7d){${fields},unique_clicks,unique_ctr}&limit=100&`, access_token),
  ]);

  return { account, campaigns: campaigns.data || [], adsets: adsets.data || [], ads: ads.data || [], fetchedAt: new Date().toISOString() };
}

function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ── CALCULAR MÉTRICAS ─────────────────────────────────────────
function calcMetrics(insights) {
  if (!insights || !insights.data || !insights.data[0]) return null;
  const d = insights.data[0];
  const spend    = parseFloat(d.spend || 0);
  const clicks   = parseInt(d.clicks || 0);
  const impr     = parseInt(d.impressions || 0);
  const reach    = parseInt(d.reach || 0);
  const freq     = parseFloat(d.frequency || 0);
  const ctr      = parseFloat(d.ctr || 0);
  const cpm      = parseFloat(d.cpm || 0);

  // Extraer conversiones y valor
  const actions      = d.actions || [];
  const actionValues = d.action_values || [];
  const purchases    = actions.find(a => a.action_type === 'purchase');
  const purchaseVal  = actionValues.find(a => a.action_type === 'purchase');
  const conversions  = purchases ? parseInt(purchases.value) : 0;
  const revenue      = purchaseVal ? parseFloat(purchaseVal.value) : 0;
  const roas         = spend > 0 && revenue > 0 ? revenue / spend : 0;
  const cpa          = conversions > 0 ? spend / conversions : 0;

  return { spend, clicks, impressions: impr, reach, frequency: freq, ctr, cpm, conversions, revenue, roas, cpa };
}

// ── DETECTAR FASE DEL ALGORITMO ───────────────────────────────
function detectAlgorithmPhase(adset, metrics) {
  const learningInfo = adset.learning_stage_info;
  if (learningInfo && learningInfo.status === 'LEARNING') {
    return { phase: 'learning', label: 'Aprendizaje', detail: learningInfo.attribution_window_size_secs ? 'En curso' : 'Limitado' };
  }
  if (!metrics) return { phase: 'unknown', label: 'Sin datos', detail: '' };
  if (metrics.frequency >= 4.5) return { phase: 'fatigue', label: 'Fatiga creativa', detail: `Frecuencia ${metrics.frequency.toFixed(1)}` };
  if (metrics.frequency >= 3.5) return { phase: 'warning', label: 'Advertencia', detail: `Frecuencia ${metrics.frequency.toFixed(1)}` };
  return { phase: 'stable', label: 'Estable', detail: 'Algoritmo optimizando' };
}

// ── EVALUAR KPIs vs OBJETIVOS ─────────────────────────────────
function evaluateKPIs(metrics, objectives) {
  if (!metrics) return [];
  const alerts = [];
  if (objectives.roas_min && metrics.roas > 0 && metrics.roas < objectives.roas_min)
    alerts.push({ kpi: 'ROAS', status: 'danger', value: metrics.roas.toFixed(2), target: objectives.roas_min, msg: `ROAS ${metrics.roas.toFixed(2)} por debajo del mínimo ${objectives.roas_min}` });
  if (objectives.cpa_max && metrics.cpa > 0 && metrics.cpa > objectives.cpa_max)
    alerts.push({ kpi: 'CPA', status: 'danger', value: metrics.cpa.toFixed(0), target: objectives.cpa_max, msg: `CPA $${metrics.cpa.toFixed(0)} supera el máximo $${objectives.cpa_max}` });
  if (objectives.ctr_min && metrics.ctr < objectives.ctr_min)
    alerts.push({ kpi: 'CTR', status: 'warning', value: metrics.ctr.toFixed(2) + '%', target: objectives.ctr_min + '%', msg: `CTR ${metrics.ctr.toFixed(2)}% por debajo del mínimo ${objectives.ctr_min}%` });
  if (objectives.frecuencia_max && metrics.frequency > objectives.frecuencia_max)
    alerts.push({ kpi: 'Frecuencia', status: 'danger', value: metrics.frequency.toFixed(1), target: objectives.frecuencia_max, msg: `Frecuencia ${metrics.frequency.toFixed(1)} supera el máximo ${objectives.frecuencia_max}` });
  if (objectives.cpm_max && metrics.cpm > objectives.cpm_max)
    alerts.push({ kpi: 'CPM', status: 'warning', value: '$' + metrics.cpm.toFixed(0), target: '$' + objectives.cpm_max, msg: `CPM $${metrics.cpm.toFixed(0)} supera el máximo $${objectives.cpm_max}` });
  return alerts;
}

// ── AGENTE CLAUDE — EXPERTO META ANDROMEDA ────────────────────
async function runAnalysisAgent(client, data) {
  const { campaigns, adsets, ads } = data;

  // Preparar resumen de datos para Claude
  const summary = {
    cuenta: client.name,
    periodo: 'Últimos 7 días',
    objetivos: client.objectives,
    campanas: campaigns.slice(0, 10).map(c => ({
      nombre: c.name,
      estado: c.status,
      objetivo: c.objective,
      metricas: calcMetrics(c.insights),
    })),
    conjuntos: adsets.slice(0, 15).map(a => ({
      nombre: a.name,
      estado: a.status,
      fase: detectAlgorithmPhase(a, calcMetrics(a.insights)),
      metricas: calcMetrics(a.insights),
    })),
    anuncios_top: ads
      .map(a => ({ nombre: a.name, estado: a.status, metricas: calcMetrics(a.insights) }))
      .filter(a => a.metricas)
      .sort((a, b) => (b.metricas.ctr || 0) - (a.metricas.ctr || 0))
      .slice(0, 10),
  };

  const system = `Sos un experto en Meta Ads con especialización en el algoritmo Advantage+ (Andromeda).
Tu rol es analizar métricas de campañas y dar diagnósticos precisos y recomendaciones accionables.

CONOCIMIENTO DEL ALGORITMO ANDROMEDA:
- Fase de aprendizaje: menos de 50 eventos de optimización por semana. El algoritmo explora audiencias. NO pausar ni editar.
- Fase estable: algoritmo optimizando eficientemente. Cambios solo si hay problemas claros.
- Fatiga creativa: frecuencia >3.5 empieza a degradar performance. Frecuencia >4.5 requiere acción inmediata.
- Advantage+ gestiona presupuesto y audiencias automáticamente. Las restricciones de audiencia limitan la optimización.
- Para Andromeda: creatividades variadas son clave. El sistema rota los mejores anuncios automáticamente.
- Un bajo CTR con alta frecuencia indica fatiga. Un CTR bajo con baja frecuencia indica problema creativo.
- ROAS descendente en fase estable puede indicar saturación de audiencia o cambio en el mercado.

OBJETIVOS DEL ANÁLISIS:
1. Diagnóstico preciso del estado de cada campaña
2. Identificar oportunidades de mejora concretas
3. Proponer acciones específicas con prioridad (alta/media/baja)
4. Alertar sobre riesgos antes de que impacten el presupuesto

Respondé en español. Sé directo y práctico. El cliente es un profesional de marketing.`;

  const prompt = `Analizá las siguientes métricas de Meta Ads y generá un informe ejecutivo:

${JSON.stringify(summary, null, 2)}

Respondé con este JSON exacto (sin markdown):
{
  "diagnostico_general": "párrafo con el estado general de la cuenta",
  "score_salud": 85,
  "hallazgos": [
    {"tipo": "alerta|oportunidad|positivo", "titulo": "...", "detalle": "...", "impacto": "alto|medio|bajo"}
  ],
  "acciones": [
    {"prioridad": "alta|media|baja", "accion": "...", "razon": "...", "campana": "nombre o 'todas'"}
  ],
  "analisis_creatividades": "párrafo sobre el estado de los anuncios y creatividades",
  "fase_algoritmo_resumen": "párrafo sobre el estado del algoritmo Andromeda en esta cuenta",
  "proximos_pasos": ["paso 1", "paso 2", "paso 3"]
}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 2000, system, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'Error agente Claude');
  const text = d.content.map(b => b.text || '').join('');
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch { return { diagnostico_general: text, score_salud: 0, hallazgos: [], acciones: [], analisis_creatividades: '', fase_algoritmo_resumen: '', proximos_pasos: [] }; }
}

// ── EMAIL ─────────────────────────────────────────────────────
function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
  });
}

async function sendAlertEmail(client, alerts, analysis) {
  if (!client.email_alerts?.length) return;
  const transporter = createTransporter();
  const alertsHtml = alerts.map(a =>
    `<tr><td style="padding:8px;border-bottom:1px solid #2c2c32;color:${a.status==='danger'?'#f26d6d':'#f5a623'}">${a.kpi}</td><td style="padding:8px;border-bottom:1px solid #2c2c32">${a.value}</td><td style="padding:8px;border-bottom:1px solid #2c2c32;color:#7a7a88">Objetivo: ${a.target}</td></tr>`
  ).join('');

  const accionesHtml = (analysis?.acciones || []).slice(0, 3).map(a =>
    `<li style="margin-bottom:8px"><strong style="color:${a.prioridad==='alta'?'#f26d6d':a.prioridad==='media'?'#f5a623':'#5de8a0'}">[${a.prioridad.toUpperCase()}]</strong> ${a.accion}</li>`
  ).join('');

  await transporter.sendMail({
    from: `"Meta Intelligence · Docta Nexus" <${process.env.EMAIL_USER}>`,
    to: client.email_alerts.join(', '),
    subject: `⚠️ Alerta Meta Ads — ${client.name} — ${new Date().toLocaleDateString('es-AR')}`,
    html: `
    <div style="font-family:DM Sans,sans-serif;background:#0b0b0d;color:#edeef0;padding:32px;max-width:600px;margin:0 auto;border-radius:16px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #2c2c32">
        <div style="width:36px;height:36px;background:#c8f135;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#0b0b0d;font-size:18px">D</div>
        <div>
          <div style="font-size:18px;font-weight:600">Meta Intelligence</div>
          <div style="font-size:12px;color:#7a7a88">by Docta Nexus · ${client.name}</div>
        </div>
      </div>
      <h2 style="color:#f26d6d;margin-bottom:16px">⚠️ ${alerts.length} alerta${alerts.length>1?'s':''} detectada${alerts.length>1?'s':''}</h2>
      <table style="width:100%;border-collapse:collapse;background:#151518;border-radius:8px;overflow:hidden;margin-bottom:24px">
        <thead><tr style="background:#1e1e22"><th style="padding:10px;text-align:left;font-size:11px;text-transform:uppercase;color:#7a7a88">KPI</th><th style="padding:10px;text-align:left;font-size:11px;text-transform:uppercase;color:#7a7a88">Valor actual</th><th style="padding:10px;text-align:left;font-size:11px;text-transform:uppercase;color:#7a7a88">Objetivo</th></tr></thead>
        <tbody>${alertsHtml}</tbody>
      </table>
      ${analysis ? `
      <div style="background:#151518;border-radius:8px;padding:16px;margin-bottom:24px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;color:#a78cf4;margin-bottom:8px">✦ Diagnóstico del agente</div>
        <p style="color:#edeef0;line-height:1.6;margin:0 0 12px">${analysis.diagnostico_general}</p>
        ${accionesHtml ? `<ul style="margin:0;padding-left:20px;color:#edeef0">${accionesHtml}</ul>` : ''}
      </div>` : ''}
      <div style="text-align:center;padding-top:16px;border-top:1px solid #2c2c32;font-size:11px;color:#52525c">
        Meta Intelligence es propiedad intelectual de <a href="https://doctanexus.com" style="color:#c8f135;text-decoration:none">Docta Nexus</a><br>
        © ${new Date().getFullYear()} Docta Nexus — Todos los derechos reservados
      </div>
    </div>`
  });
}

async function sendDailyReport(client, data, analysis) {
  if (!client.email_alerts?.length) return;
  const transporter = createTransporter();

  const hallazgosHtml = (analysis?.hallazgos || []).map(h =>
    `<li style="margin-bottom:10px;padding:10px;background:#1e1e22;border-radius:8px;border-left:3px solid ${h.tipo==='alerta'?'#f26d6d':h.tipo==='oportunidad'?'#c8f135':'#5de8a0'}">
      <strong>${h.titulo}</strong><br><span style="color:#7a7a88;font-size:13px">${h.detalle}</span>
    </li>`
  ).join('');

  const accionesHtml = (analysis?.acciones || []).map((a, i) =>
    `<li style="margin-bottom:8px"><strong style="color:${a.prioridad==='alta'?'#f26d6d':a.prioridad==='media'?'#f5a623':'#5de8a0'}">${i+1}.</strong> ${a.accion} <span style="color:#7a7a88;font-size:12px">— ${a.razon}</span></li>`
  ).join('');

  await transporter.sendMail({
    from: `"Meta Intelligence · Docta Nexus" <${process.env.EMAIL_USER}>`,
    to: client.email_alerts.join(', '),
    subject: `📊 Reporte diario Meta Ads — ${client.name} — ${new Date().toLocaleDateString('es-AR')}`,
    html: `
    <div style="font-family:DM Sans,sans-serif;background:#0b0b0d;color:#edeef0;padding:32px;max-width:600px;margin:0 auto;border-radius:16px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #2c2c32">
        <div style="width:36px;height:36px;background:#c8f135;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#0b0b0d;font-size:18px">D</div>
        <div>
          <div style="font-size:18px;font-weight:600">Meta Intelligence</div>
          <div style="font-size:12px;color:#7a7a88">by Docta Nexus · Reporte diario · ${client.name}</div>
        </div>
      </div>
      <div style="background:#151518;border-radius:8px;padding:16px;margin-bottom:20px;border-left:3px solid #a78cf4">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;color:#a78cf4;margin-bottom:8px">✦ Diagnóstico del agente</div>
        <p style="margin:0;line-height:1.6">${analysis?.diagnostico_general || 'Sin análisis disponible'}</p>
        <div style="margin-top:8px;font-size:13px;color:#7a7a88">Fase del algoritmo: ${analysis?.fase_algoritmo_resumen || '—'}</div>
      </div>
      ${hallazgosHtml ? `<div style="margin-bottom:20px"><div style="font-size:11px;font-weight:600;text-transform:uppercase;color:#7a7a88;margin-bottom:10px">Hallazgos</div><ul style="list-style:none;margin:0;padding:0">${hallazgosHtml}</ul></div>` : ''}
      ${accionesHtml ? `<div style="background:#151518;border-radius:8px;padding:16px;margin-bottom:20px"><div style="font-size:11px;font-weight:600;text-transform:uppercase;color:#3ecfaa;margin-bottom:10px">Acciones recomendadas</div><ol style="margin:0;padding-left:20px;color:#edeef0">${accionesHtml}</ol></div>` : ''}
      <div style="text-align:center;padding-top:16px;border-top:1px solid #2c2c32;font-size:11px;color:#52525c">
        Meta Intelligence es propiedad intelectual de <a href="https://doctanexus.com" style="color:#c8f135;text-decoration:none">Docta Nexus</a><br>
        © ${new Date().getFullYear()} Docta Nexus — Todos los derechos reservados
      </div>
    </div>`
  });
}

// ── PIPELINE COMPLETO ─────────────────────────────────────────
async function runPipeline(slug) {
  const client = loadClient(slug);
  if (!client) throw new Error('Cliente no encontrado: ' + slug);
  if (!client.access_token || client.access_token.startsWith('EAAG')) throw new Error('Token de Meta no configurado');

  console.log(`[${slug}] Iniciando pipeline...`);
  const data     = await getAccountMetrics(client);
  const analysis = await runAnalysisAgent(client, data);

  // Calcular métricas globales y alertas
  const allMetrics = data.campaigns.map(c => calcMetrics(c.insights)).filter(Boolean);
  const globalMetrics = allMetrics.length ? {
    spend:       allMetrics.reduce((s, m) => s + m.spend, 0),
    clicks:      allMetrics.reduce((s, m) => s + m.clicks, 0),
    impressions: allMetrics.reduce((s, m) => s + m.impressions, 0),
    conversions: allMetrics.reduce((s, m) => s + m.conversions, 0),
    revenue:     allMetrics.reduce((s, m) => s + m.revenue, 0),
    ctr:         allMetrics.reduce((s, m) => s + m.ctr, 0) / allMetrics.length,
    cpm:         allMetrics.reduce((s, m) => s + m.cpm, 0) / allMetrics.length,
    frequency:   allMetrics.reduce((s, m) => s + m.frequency, 0) / allMetrics.length,
    roas:        0, cpa: 0
  } : null;

  if (globalMetrics && globalMetrics.spend > 0) {
    globalMetrics.roas = globalMetrics.revenue / globalMetrics.spend;
    globalMetrics.cpa  = globalMetrics.conversions > 0 ? globalMetrics.spend / globalMetrics.conversions : 0;
  }

  const alerts = globalMetrics ? evaluateKPIs(globalMetrics, client.objectives || {}) : [];

  const snapshot = { slug, fetchedAt: new Date().toISOString(), data, analysis, globalMetrics, alerts };
  saveData(slug, snapshot);

  // Enviar alertas si hay problemas
  if (alerts.some(a => a.status === 'danger')) {
    await sendAlertEmail(client, alerts, analysis).catch(e => console.error('Error email alerta:', e));
  }

  console.log(`[${slug}] Pipeline completado. Alertas: ${alerts.length}`);
  return snapshot;
}

// ── ENDPOINTS ─────────────────────────────────────────────────
// Autenticación
app.post('/api/login', (req, res) => {
  const { slug, password } = req.body;
  const client = loadClient(slug);
  if (!client || client.password !== password)
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  res.json({ ok: true, name: client.name, colorPrimary: client.colorPrimary, colorAccent: client.colorAccent, colorBtnText: client.colorBtnText });
});

// Datos del dashboard
app.get('/api/dashboard/:slug', (req, res) => {
  const { slug } = req.params;
  const { pwd }  = req.query;
  const client = loadClient(slug);
  if (!client || client.password !== pwd) return res.status(401).json({ error: 'No autorizado' });

  const latest  = loadLatest(slug);
  const history = loadHistory(slug, 7);
  res.json({ client: { name: client.name, objectives: client.objectives, colorPrimary: client.colorPrimary }, latest, history });
});

// Correr análisis manual
app.post('/api/run/:slug', async (req, res) => {
  const { slug } = req.params;
  const { pwd }  = req.body;
  const client = loadClient(slug);
  if (!client || client.password !== pwd) return res.status(401).json({ error: 'No autorizado' });
  try {
    const result = await runPipeline(slug);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (_, res) => res.json({ status: 'ok', clients: listClients() }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── CRON — REPORTE DIARIO ─────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] Iniciando reportes diarios...');
  for (const slug of listClients()) {
    try {
      const client   = loadClient(slug);
      const snapshot = await runPipeline(slug);
      await sendDailyReport(client, snapshot.data, snapshot.analysis);
      console.log(`[CRON] Reporte enviado: ${slug}`);
    } catch (e) { console.error(`[CRON] Error ${slug}:`, e.message); }
  }
}, { timezone: 'America/Argentina/Buenos_Aires' });

app.listen(PORT, () => {
  console.log('\n✦ Meta Intelligence — Docta Nexus');
  console.log('  http://localhost:' + PORT);
  console.log('  Clientes: ' + (listClients().join(', ') || 'ninguno') + '\n');
});
