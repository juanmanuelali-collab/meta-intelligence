require('dotenv').config();
const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const fs         = require('fs');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const META_API_VER   = 'v19.0';
const REPORT_HOUR    = process.env.REPORT_HOUR || '8';
const TZ             = process.env.TIMEZONE || 'America/Argentina/Buenos_Aires';

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
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
}

function saveData(slug, data) {
  const dir = path.join(__dirname, 'data', slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, date + '.json'), JSON.stringify(data, null, 2));
}

function loadHistory(slug, days = 14) {
  const dir = path.join(__dirname, 'data', slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .sort().reverse().slice(0, days)
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

function today() { return new Date().toISOString().slice(0, 10); }

// ── META API ──────────────────────────────────────────────────
async function metaFetch(path, token) {
  const r = await fetch('https://graph.facebook.com/' + META_API_VER + path + '&access_token=' + token);
  const d = await r.json();
  if (d.error) throw new Error('Meta API: ' + d.error.message);
  return d;
}

async function fetchAccountMetrics(client) {
  const token = client.access_token;
  const accountId = client.ad_account_id;

  const fieldsBase = [
    'spend','impressions','clicks','ctr','cpm','reach','frequency',
    'actions','action_values','unique_clicks','unique_ctr'
  ].join(',');

  const fieldsAccount = fieldsBase + ',landing_page_views,outbound_clicks';

  // Cuenta, campañas (insights + status real), adsets y anuncios en paralelo
  const [accountData, campaignData, campaignStatus, adsetData, adData] = await Promise.all([
    metaFetch('/' + accountId + '/insights?fields=' + fieldsAccount + '&date_preset=last_7d&level=account&', token).catch(()=>({data:[]})),
    metaFetch('/' + accountId + '/insights?fields=' + fieldsBase + ',campaign_id,campaign_name&date_preset=last_7d&level=campaign&limit=50&', token).catch(()=>({data:[]})),
    // Estado real + objetivo de campañas
    metaFetch('/' + accountId + '/campaigns?fields=id,name,effective_status,status,objective&limit=50&', token).catch(()=>({data:[]})),
    // Adsets
    metaFetch('/' + accountId + '/insights?fields=' + fieldsBase + ',adset_id,adset_name,campaign_name&date_preset=last_7d&level=adset&sort=spend_descending&limit=30&', token).catch(()=>({data:[]})),
    metaFetch('/' + accountId + '/insights?fields=ad_id,ad_name,adset_id,adset_name,campaign_name,' + fieldsBase + '&date_preset=last_7d&level=ad&sort=spend_descending&limit=25&', token).catch(()=>({data:[]})),
  ]);

  // Mapa de estado real + objetivo por campaign_id
  const campaignStatusMap = {};
  (campaignStatus.data || []).forEach(c => {
    campaignStatusMap[c.id] = {
      status: c.effective_status || c.status || 'UNKNOWN',
      objective: c.objective || ''
    };
  });

  // Mapa de learning_stage por adset — fetchear separado
  let adsetLearningMap = {};
  try {
    const adsetStatusData = await metaFetch(
      '/' + accountId + '/adsets?fields=id,effective_status,learning_stage_info&limit=100&',
      token
    );
    (adsetStatusData.data || []).forEach(a => {
      adsetLearningMap[a.id] = {
        status: a.effective_status,
        learning: a.learning_stage_info
      };
    });
  } catch(e) { /* fallback silencioso */ }

  function getAction(actions, type) {
    const a = (actions || []).find(a => a.action_type === type);
    return a ? parseInt(a.value) : 0;
  }
  function getActionValue(actionValues, type) {
    const a = (actionValues || []).find(a => a.action_type === type);
    return a ? parseFloat(a.value) : 0;
  }

  function calcKpis(data) {
    if (!data) return {};
    const spend       = parseFloat(data.spend || 0);
    const clicks      = parseInt(data.clicks || 0);
    const impressions = parseInt(data.impressions || 0);
    const reach       = parseInt(data.reach || 0);
    const frequency   = parseFloat(data.frequency || 0);
    const ctr         = parseFloat(data.ctr || 0);
    const cpm         = parseFloat(data.cpm || 0);
    const uniqueClicks= parseInt(data.unique_clicks || 0);
    const uniqueCtr   = parseFloat(data.unique_ctr || 0);

    const actions      = data.actions || [];
    const actionValues = data.action_values || [];

    // Conversiones web
    const purchases        = getAction(actions, 'purchase') || getAction(actions, 'omni_purchase');
    const purchaseValue    = getActionValue(actionValues, 'purchase') || getActionValue(actionValues, 'omni_purchase');
    const leads            = getAction(actions, 'lead');
    const completeReg      = getAction(actions, 'complete_registration');
    const addToCart        = getAction(actions, 'add_to_cart');
    const initiateCheckout = getAction(actions, 'initiate_checkout');
    const landingPageViews = parseInt(data.landing_page_views || 0) || getAction(actions, 'landing_page_view');
    const linkClicks       = getAction(actions, 'link_click') || parseInt(data.outbound_clicks || 0);
    // Mensajería
    const messagingConn       = getAction(actions, 'onsite_conversion.total_messaging_connection');
    const messagingFirstReply = getAction(actions, 'onsite_conversion.messaging_first_reply');
    const messagingStarted7d  = getAction(actions, 'onsite_conversion.messaging_conversation_started_7d');

    // Engagement
    const postEngagement = getAction(actions, 'post_engagement');
    const videoViews     = getAction(actions, 'video_view');
    const videoViews25   = getAction(actions, 'video_p25_watched_actions');
    const videoViews75   = getAction(actions, 'video_p75_watched_actions');
    const postShares     = getAction(actions, 'post') + getAction(actions, 'share');
    const postSaves      = getAction(actions, 'onsite_conversion.post_save') || getAction(actions, 'post_save');

    // Nuevos seguidores
    const newFollowersPage = getAction(actions, 'like') + getAction(actions, 'follow');
    const newFollowersIG   = getAction(actions, 'onsite_conversion.follow');

    // Formularios nativos
    const leadgenLeads = getAction(actions, 'leadgen_grouped') || getAction(actions, 'onsite_conversion.lead_grouped');

    // KPIs calculados — SIN CPA (confuso, solo mide leads nativos Meta)
    const conversions = purchases || leads || leadgenLeads || 0;
    const roas  = spend > 0 && purchaseValue > 0 ? purchaseValue / spend : null;
    const cpl   = spend > 0 && leads > 0 ? spend / leads : null;
    const cpmsg = spend > 0 && messagingConn > 0 ? spend / messagingConn : null;

    return {
      spend, clicks, impressions, reach, frequency, ctr, cpm, uniqueClicks, uniqueCtr,
      purchases, purchaseValue, leads, completeReg, addToCart, initiateCheckout, landingPageViews, linkClicks,
      messagingConn, messagingFirstReply, messagingStarted7d,
      postEngagement, videoViews, videoViews25, videoViews75, postShares, postSaves,
      newFollowersPage, newFollowersIG,
      leadgenLeads,
      conversions, roas, cpl, cpmsg,
      revenue: purchaseValue,
    };
  }

  const accountKpis  = calcKpis(accountData.data?.[0]);
  const campaignList = (campaignData.data || []).map(cm => {
    const kpis = calcKpis(cm);
    const campInfo = campaignStatusMap[cm.campaign_id] || {};
    return {
      id: cm.campaign_id, name: cm.campaign_name,
      status: campInfo.status || 'ACTIVE',
      objective: campInfo.objective || '',
      rawActions: cm.actions || [],
      ...kpis,
      phase: detectPhase(kpis)
    };
  });
  const adsetList = (adsetData.data || []).map(a => {
    const kpis = calcKpis(a);
    const adsetInfo = adsetLearningMap[a.adset_id] || {};
    // Fase real desde learning_stage_info de Meta
    const phase = detectPhaseReal(kpis, adsetInfo.learning);
    return {
      id: a.adset_id, name: a.adset_name, campaignName: a.campaign_name,
      status: adsetInfo.status || 'ACTIVE',
      ...kpis,
      phase,
      fatigueScore: calcFatigue(kpis)
    };
  });
  const adList = (adData.data || []).map(ad => ({
    id: ad.ad_id, name: ad.ad_name,
    adsetName: ad.adset_name, campaignName: ad.campaign_name,
    ...calcKpis(ad),
    fatigueScore: calcFatigue(calcKpis(ad))
  }));

  return {
    date: today(),
    account: accountKpis,
    campaigns: campaignList,
    adsets: adsetList,
    ads: adList,
  };
}

function detectPhaseReal(kpis, learningInfo) {
  // Usar el estado real del algoritmo que devuelve Meta
  if (learningInfo) {
    const status = learningInfo.status;
    if (status === 'LEARNING') return 'learning';
    if (status === 'LEARNING_LIMITED') return 'learning_limited';
  }
  // Fallback: detectar por métricas si no hay learningInfo
  return detectPhase(kpis);
}

function detectPhase(kpis) {
  const frequency = kpis.frequency || 0;
  const ctr       = kpis.ctr       || 0;
  const spend     = kpis.spend     || 0;
  // Sin datos suficientes no podemos determinar la fase
  if (spend === 0) return 'unknown';
  if (frequency > 3.5 || ctr < 0.5) return 'fatigue';
  return 'stable';
}

function calcFatigue(kpis) {
  let score = 0;
  if (kpis.frequency > 4) score += 40;
  else if (kpis.frequency > 3) score += 20;
  if (kpis.ctr < 0.5) score += 30;
  else if (kpis.ctr < 1.0) score += 15;
  if (kpis.cpm > 200) score += 20;
  return Math.min(score, 100);
}

// ── AGENTE CLAUDE — EXPERTO META ANDROMEDA ────────────────────
async function runAnalysis(client, metricsData) {
  const history = loadHistory(client.slug || 'demo', 7);
  const targets = client.kpi_targets || {};

  // KPIs principales definidos por el cliente
  const mainKpis = targets.main_kpis || [];
  const analysisBase = targets.analysis_base || '';

  const system = `Sos un experto en Paid Media con especialización profunda en Meta Ads y el algoritmo Andromeda/Advantage+.

## Algoritmo Meta Andromeda
- Fases: Aprendizaje (<50 conv/semana), Estabilización, Fatiga
- Advantage+: Meta optimiza automáticamente audiencias, placements y creatividades
- Fatiga creativa: frecuencia >3.5 señal temprana, >4.5 crítico. Impacta CPM y ROAS
- Subasta: bid + presupuesto + calidad del anuncio determinan el delivery
- En aprendizaje: NO pausar ni editar — el algoritmo necesita explorar

## Relaciones entre métricas
- CPM alto + CTR bajo → creatividad débil o audiencia saturada
- Muchos clics + pocas conversiones → problema post-click (landing, tracking, proceso comercial)
- Frecuencia alta + CTR cayendo → fatiga creativa avanzada
- ROAS bajo en aprendizaje → normal, esperar 50 conversiones antes de juzgar
- CTR saludable: feed 1-3%, stories/reels >1.5%

## Formato de respuesta
Respondé SIEMPRE en JSON válido, sin markdown, sin texto fuera del JSON.
Cada campo de análisis debe ser un ARRAY DE ITEMS, no un texto largo.
Esto es crítico para el renderizado visual del dashboard.`;

  // Construir sección de KPIs principales
  const mainKpisSection = mainKpis.length > 0
    ? `\nKPIs PRINCIPALES PARA ESTE CLIENTE (ordenados por prioridad):\n${mainKpis.map((k, i) => `  ${i+1}. ${k}`).join('\n')}\nAnalizá y evaluá estas métricas con prioridad sobre las demás.\n`
    : '';

  // Base de análisis del cliente
  const analysisBaseSection = analysisBase
    ? `\nBASE DE ANÁLISIS — instrucciones específicas del cliente:\n${analysisBase}\nTené en cuenta este contexto en todo el análisis.\n`
    : '';

  const acc = metricsData.account || {};
  const camps = metricsData.campaigns || [];
  const adsets = metricsData.adsets || [];
  const ads = metricsData.ads || [];

  const prompt = `Analizá las campañas de Meta Ads para el cliente "${client.name}".
${mainKpisSection}${analysisBaseSection}
OBJETIVOS DEFINIDOS:
${targets.target_roas ? '- ROAS mínimo: ' + targets.target_roas + 'x' : ''}
${targets.target_ctr ? '- CTR mínimo: ' + targets.target_ctr + '%' : ''}
${targets.target_cpm ? '- CPM máximo: $' + targets.target_cpm : ''}
${targets.target_frequency ? '- Frecuencia máxima: ' + targets.target_frequency : ''}
${targets.target_cpmsg ? '- Costo por mensaje máximo: $' + targets.target_cpmsg : ''}

MÉTRICAS CUENTA (últimos 7 días):
Gasto: $${Math.round(acc.spend||0)} | Impresiones: ${acc.impressions||0} | Alcance: ${acc.reach||0}
CTR: ${(acc.ctr||0).toFixed(2)}% | CPM: $${Math.round(acc.cpm||0)} | Frecuencia: ${(acc.frequency||0).toFixed(1)}
ROAS: ${acc.roas ? acc.roas.toFixed(2)+'x' : 'N/A'}
Mensajería: ${acc.messagingConn||0} conexiones | ${acc.messagingFirstReply||0} primeras respuestas | Costo x msg: $${Math.round(acc.cpmsg||0)}
Leads: ${acc.leads||0} | Compras: ${acc.purchases||0} | Valor: $${Math.round(acc.purchaseValue||0)}
Nuevos seguidores: ${acc.newFollowersPage||0} (pág) + ${acc.newFollowersIG||0} (IG)
Compartidos: ${acc.postShares||0} | Guardados: ${acc.postSaves||0}
Engagement posts: ${acc.postEngagement||0} | Video views: ${acc.videoViews||0}

CAMPAÑAS (${camps.length}):
${JSON.stringify(camps.slice(0,12).map(c=>({
  nombre: c.name, fase: c.phase,
  gasto: '$'+Math.round(c.spend||0), ctr: (c.ctr||0).toFixed(2)+'%', cpm: '$'+Math.round(c.cpm||0),
  freq: (c.frequency||0).toFixed(1), roas: c.roas?c.roas.toFixed(2)+'x':'N/A',
  mensajes: c.messagingConn||0, leads: c.leads||0, compras: c.purchases||0
})), null, 2)}

CONJUNTOS DE ANUNCIOS / AUDIENCIAS (${adsets.length}):
${JSON.stringify(adsets.slice(0,15).map(a=>({
  nombre: a.name, campana: a.campaignName, fase: a.phase, fatiga: a.fatigueScore,
  gasto: '$'+Math.round(a.spend||0), ctr: (a.ctr||0).toFixed(2)+'%', cpm: '$'+Math.round(a.cpm||0),
  freq: (a.frequency||0).toFixed(1), mensajes: a.messagingConn||0, leads: a.leads||0
})), null, 2)}

ANUNCIOS TOP (${ads.length}):
${JSON.stringify(ads.slice(0,12).map(a=>({
  nombre: a.name, conjunto: a.adsetName, fatiga: a.fatigueScore,
  gasto: '$'+Math.round(a.spend||0), ctr: (a.ctr||0).toFixed(2)+'%', freq: (a.frequency||0).toFixed(1),
  mensajes: a.messagingConn||0, compartidos: a.postShares||0, guardados: a.postSaves||0
})), null, 2)}

${history.length > 1 ? 'TENDENCIA (' + history.length + ' días):\n' + JSON.stringify(history.map(h => ({ date: h.date, spend: h.metrics?.account?.spend, roas: h.metrics?.account?.roas, mensajes: h.metrics?.account?.messagingConn })), null, 2) : ''}

Respondé ÚNICAMENTE con este JSON (sin markdown):
{
  "summary_items": [
    {"icon": "🔴|🟡|🟢|💡|⚠️", "titulo": "título corto", "detalle": "1-2 oraciones"}
  ],
  "algorithm_phase": "learning|stable|fatigue|mixed",
  "algorithm_items": [
    {"icon": "📊|⚠️|✅|🔄", "titulo": "título", "detalle": "explicación"}
  ],
  "health_score": 0-100,
  "critical_campaigns": [
    {"name": "nombre", "issue": "problema con datos concretos", "action": "acción concreta"}
  ],
  "adset_insights": [
    {"icon": "🔴|🟡|🟢|💡", "titulo": "nombre del conjunto o audiencia", "detalle": "análisis de esa audiencia y recomendación"}
  ],
  "creative_items": [
    {"icon": "🔴|🟡|🟢|💡", "titulo": "nombre del anuncio", "detalle": "estado, fatiga y recomendación"}
  ],
  "recommendations": [
    {"priority": 1, "action": "acción concreta", "impact": "alto|medio|bajo", "detail": "por qué y cómo", "campana": "nombre o 'cuenta'"}
  ],
  "conclusion_items": [
    {"icon": "✅|🎯|📈|⚡", "titulo": "punto clave", "detalle": "detalle accionable"}
  ],
  "alerts": [
    {"type": "warning|critical", "metric": "nombre", "current": "valor", "target": "objetivo", "message": "mensaje"}
  ]
}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 6000, system, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'Error Claude');
  const text = d.content.map(b => b.text || '').join('');
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    // Intentar recuperar JSON parcial completándolo
    try {
      const partial = text.replace(/```json|```/g, '').trim();
      // Contar llaves y corchetes abiertos para cerrar el JSON
      let fixed = partial;
      const opens = (partial.match(/\{/g)||[]).length - (partial.match(/\}/g)||[]).length;
      const openArr = (partial.match(/\[/g)||[]).length - (partial.match(/\]/g)||[]).length;
      for(let i=0;i<openArr;i++) fixed += ']';
      for(let i=0;i<opens;i++) fixed += '}';
      return JSON.parse(fixed);
    } catch {
      return {
        summary_items: [{icon:'⚠️', titulo:'Análisis incompleto', detalle:'El análisis se generó pero el JSON quedó truncado. Intentá actualizar nuevamente.'}],
        health_score: 50, recommendations: [], alerts: [], critical_campaigns: [],
        algorithm_items: [], creative_items: [], adset_insights: [], conclusion_items: []
      };
    }
  }
}

// ── EMAIL ─────────────────────────────────────────────────────

// ── EMAIL ─────────────────────────────────────────────────────
function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
  });
}

async function sendReport(client, metrics, analysis) {
  if (!process.env.EMAIL_USER || !client.email_alerts?.length) return;
  const transporter = createTransporter();
  const score = analysis.health_score || 0;
  const scoreColor = score >= 70 ? '#16a34a' : score >= 40 ? '#d97706' : '#dc2626';
  const acc = metrics?.account || {};
  const phaseLabel = { learning: 'Aprendizaje', stable: 'Estable', fatigue: 'Fatiga', mixed: 'Mixto' };
  const dateStr = new Date().toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });

  const concItems = analysis.conclusion_items || [];
  const concHtml = concItems.length
    ? concItems.map(it => `<tr><td style="padding:10px 0;border-bottom:1px solid #e8e8e8;vertical-align:top"><span style="font-size:14px;margin-right:6px">${it.icon||'•'}</span><strong>${it.titulo}</strong><br><span style="color:#555;font-size:13px;line-height:1.6">${it.detalle}</span></td></tr>`).join('')
    : '<tr><td style="padding:10px 0;color:#888;font-size:13px">Ejecutá el análisis del agente para ver la conclusión.</td></tr>';

  const recs = analysis.recommendations || [];
  const recsHtml = recs.length
    ? recs.map((r,i) => {
        const color = r.impact==='alto'?'#dc2626':r.impact==='medio'?'#d97706':'#16a34a';
        const bg = r.impact==='alto'?'#fee2e2':r.impact==='medio'?'#fef3c7':'#dcfce7';
        return `<tr><td style="padding:8px;background:#f9f9f9;border-radius:6px;margin-bottom:5px;display:block"><table cellpadding="0" cellspacing="0" width="100%"><tr><td width="28" valign="top"><div style="width:22px;height:22px;background:${bg};color:${color};border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700">${i+1}</div></td><td><div style="font-weight:600;color:#1a1a1a;font-size:13px">${r.action} <span style="font-size:10px;padding:1px 6px;border-radius:8px;background:${bg};color:${color}">${r.impact}</span>${r.campana&&r.campana!=='cuenta'?` <span style="font-size:11px;color:#888">${r.campana}</span>`:''}</div><div style="color:#555;font-size:12px;margin-top:2px">${r.detail||''}</div></td></tr></table></td></tr>`;
      }).join('')
    : '<tr><td style="padding:10px 0;color:#888;font-size:13px">Ejecutá el análisis del agente para ver las acciones.</td></tr>';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0">
<tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
<tr><td style="background:#0b0b0d;padding:20px 28px"><table width="100%" cellpadding="0" cellspacing="0"><tr>
<td><table cellpadding="0" cellspacing="0"><tr>
<td style="width:34px;height:34px;background:#c8f135;border-radius:7px;text-align:center;vertical-align:middle;font-weight:700;color:#0b0b0d;font-size:17px">D</td>
<td style="padding-left:10px"><div style="color:#fff;font-weight:700;font-size:14px">DoctaNexus</div><div style="color:#7a7a88;font-size:11px">Meta Intelligence</div></td>
</tr></table></td>
<td align="right" style="color:#7a7a88;font-size:11px">${client.name}<br>${dateStr}</td>
</tr></table></td></tr>
<tr><td style="padding:20px 28px 0"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8f8;border-radius:8px"><tr>
<td style="padding:14px 18px;border-left:4px solid ${scoreColor}"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:4px">Score de salud</div><div style="font-size:28px;font-weight:700;color:${scoreColor};line-height:1">${score}<span style="font-size:14px;color:#999">/100</span></div><div style="color:#666;font-size:12px;margin-top:3px">${phaseLabel[analysis.algorithm_phase]||'—'}</div></td>
<td style="padding:14px 18px;border-left:1px solid #e8e8e8"><table cellpadding="3" cellspacing="0">
<tr><td style="font-size:10px;color:#888;text-transform:uppercase;padding-right:14px">Gasto</td><td style="font-weight:700;font-size:13px">$${Math.round(acc.spend||0).toLocaleString('es-AR')}</td><td style="font-size:10px;color:#888;text-transform:uppercase;padding-right:14px;padding-left:10px">ROAS</td><td style="font-weight:700;font-size:13px">${acc.roas?acc.roas.toFixed(2)+'x':'—'}</td></tr>
<tr><td style="font-size:10px;color:#888;text-transform:uppercase">CTR</td><td style="font-weight:700;font-size:13px">${(acc.ctr||0).toFixed(2)}%</td><td style="font-size:10px;color:#888;text-transform:uppercase;padding-left:10px">Frecuencia</td><td style="font-weight:700;font-size:13px">${(acc.frequency||0).toFixed(1)}</td></tr>
<tr><td style="font-size:10px;color:#888;text-transform:uppercase">Mensajes</td><td style="font-weight:700;font-size:13px">${acc.messagingConn||0}</td><td style="font-size:10px;color:#888;text-transform:uppercase;padding-left:10px">Leads</td><td style="font-weight:700;font-size:13px">${acc.leads||0}</td></tr>
</table></td>
</tr></table></td></tr>
<tr><td style="padding:20px 28px 0"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#7c3aed;margin-bottom:10px">✦ Conclusión ejecutiva</div><table width="100%" cellpadding="0" cellspacing="0">${concHtml}</table></td></tr>
<tr><td style="padding:20px 28px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0d9488;margin-bottom:10px">✦ Acciones recomendadas</div><table width="100%" cellpadding="0" cellspacing="4">${recsHtml}</table></td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e8e8e8;text-align:center"><table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
<td style="width:20px;height:20px;background:#0b0b0d;border-radius:4px;text-align:center;vertical-align:middle;font-weight:700;color:#c8f135;font-size:11px">D</td>
<td style="padding-left:7px;font-size:12px;font-weight:600;color:#333">Docta<span style="color:#16a34a">Nexus</span></td>
</tr></table><div style="font-size:11px;color:#aaa;margin-top:6px"><a href="https://doctanexus.com" style="color:#aaa;text-decoration:none">doctanexus.com</a> · Meta Intelligence © ${new Date().getFullYear()} · Todos los derechos reservados</div></td></tr>
</table></td></tr></table></body></html>`;

  await transporter.sendMail({
    from: `"Meta Intelligence | Docta Nexus" <${process.env.EMAIL_USER}>`,
    to: client.email_alerts.join(','),
    subject: `📊 ${client.name} — Reporte Meta Ads ${dateStr} | Score: ${score}/100`,
    html
  });
}



async function sendAlert(client, alerts, metrics) {
  if (!process.env.EMAIL_USER || !client.email_alerts?.length || !alerts?.length) return;
  const transporter = createTransporter();
  const alertsHtml = alerts.map(a => `
    <div style="background:${a.type==='critical'?'rgba(242,109,109,.1)':'rgba(245,166,35,.1)'};border:1px solid ${a.type==='critical'?'#f26d6d':'#f5a623'};border-radius:8px;padding:12px;margin-bottom:8px">
      <div style="font-weight:600;color:${a.type==='critical'?'#f26d6d':'#f5a623'}">${a.type==='critical'?'🚨':'⚠️'} ${a.metric}</div>
      <div style="font-size:13px;color:#c8c8d0;margin-top:4px">${a.message}</div>
      <div style="font-size:12px;color:#7a7a88;margin-top:4px">Actual: ${a.current} | Objetivo: ${a.target}</div>
    </div>`).join('');

  await transporter.sendMail({
    from: '"Meta Intelligence | Docta Nexus" <' + process.env.EMAIL_USER + '>',
    to: client.email_alerts.join(','),
    subject: '🚨 Alerta Meta Ads — ' + client.name + ' — ' + alerts.length + ' problema(s) detectado(s)',
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0b0b0d;color:#edeef0;border-radius:12px;padding:24px">
      <div style="margin-bottom:16px"><span style="background:#c8f135;color:#0b0b0d;font-weight:700;padding:4px 10px;border-radius:6px;font-size:12px">ALERTA</span></div>
      <h2 style="margin:0 0 16px">${client.name} — Alertas detectadas</h2>
      ${alertsHtml}
      <div style="margin-top:16px;font-size:11px;color:#52525c;text-align:center">Meta Ads Intelligence — <a href="https://doctanexus.com" style="color:#c8f135">Docta Nexus</a></div>
    </div>`
  });
}

// ── PIPELINE COMPLETO ─────────────────────────────────────────
async function runPipeline(slug) {
  const client = loadClient(slug);
  if (!client) throw new Error('Cliente no encontrado: ' + slug);
  client.slug = slug;

  console.log('[' + new Date().toISOString() + '] Procesando ' + client.name + '...');

  let metrics, analysis;
  try {
    metrics = await fetchAccountMetrics(client);
  } catch(e) {
    console.error('Error Meta API:', e.message);
    // Usar datos de demo si falla la API
    metrics = generateDemoMetrics();
  }

  analysis = await runAnalysis(client, metrics);
  const result = { date: today(), metrics, analysis };
  saveData(slug, result);

  // Alertas críticas → email inmediato
  const criticalAlerts = (analysis.alerts || []).filter(a => a.type === 'critical');
  if (criticalAlerts.length > 0) {
    await sendAlert(client, criticalAlerts, metrics).catch(e => console.error('Error email alerta:', e.message));
  }

  return result;
}

function generateDemoMetrics() {
  return {
    date: today(),
    account: { spend: 45230, impressions: 892000, clicks: 12400, ctr: 1.39, cpm: 50.70, reach: 234000, frequency: 2.8, conversions: 87, revenue: 189400, roas: 4.19, cpa: 520 },
    campaigns: [
      { id: '1', name: 'Campaña Conversiones — Temporada', spend: 28000, ctr: 1.6, cpm: 45, roas: 5.2, cpa: 420, conversions: 66, frequency: 2.1, phase: 'stable' },
      { id: '2', name: 'Remarketing — Visitantes Web', spend: 12000, ctr: 0.8, cpm: 85, roas: 2.8, cpa: 780, conversions: 15, frequency: 4.2, phase: 'fatigue' },
      { id: '3', name: 'Tráfico Frío — Lookalike', spend: 5230, ctr: 1.1, cpm: 38, roas: null, cpa: null, conversions: 6, frequency: 1.3, phase: 'learning' }
    ],
    ads: [
      { id: 'a1', name: 'Video bota lifestyle bar', campaignName: 'Conversiones', spend: 15000, ctr: 2.1, frequency: 1.8, fatigueScore: 10 },
      { id: 'a2', name: 'Carrusel 3 productos', campaignName: 'Conversiones', spend: 9000, ctr: 1.4, frequency: 2.3, fatigueScore: 25 },
      { id: 'a3', name: 'Foto producto fondo blanco', campaignName: 'Remarketing', spend: 8000, ctr: 0.6, frequency: 5.1, fatigueScore: 75 },
    ]
  };
}

// ── RENOVACIÓN AUTOMÁTICA DE TOKENS META ─────────────────────
const META_APP_ID     = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;

async function renewTokenIfNeeded(slug) {
  if (!META_APP_ID || !META_APP_SECRET) return;
  const client = loadClient(slug);
  if (!client || !client.access_token) return;

  try {
    // Verificar estado del token con Meta Debug API
    const debugUrl = `https://graph.facebook.com/debug_token?input_token=${client.access_token}&access_token=${META_APP_ID}|${META_APP_SECRET}`;
    const r = await fetch(debugUrl);
    const d = await r.json();
    const tokenData = d.data;

    if (!tokenData || !tokenData.is_valid) {
      console.log(`[TOKEN] Token de ${slug} inválido — intentando renovar...`);
    } else {
      const expiresAt = tokenData.expires_at; // timestamp Unix
      const daysLeft  = expiresAt ? Math.floor((expiresAt - Date.now()/1000) / 86400) : 999;
      console.log(`[TOKEN] ${slug}: válido, vence en ${daysLeft} días`);

      // Solo renovar si vence en menos de 15 días o ya expiró
      if (daysLeft > 15) return;
      console.log(`[TOKEN] ${slug}: renovando token (${daysLeft} días restantes)...`);
    }

    // Renovar token
    const renewUrl = `https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${client.access_token}`;
    const rr = await fetch(renewUrl);
    const rd = await rr.json();

    if (!rr.ok || !rd.access_token) {
      throw new Error(rd.error?.message || 'No se pudo renovar el token');
    }

    // Guardar token nuevo en el JSON del cliente
    const fp = path.join(__dirname, 'clients', slug + '.json');
    client.access_token = rd.access_token;
    client.token_renewed_at = new Date().toISOString();
    fs.writeFileSync(fp, JSON.stringify(client, null, 2));
    console.log(`[TOKEN] ${slug}: token renovado exitosamente ✓`);

    // Notificar por email
    if (client.email_alerts?.length && process.env.EMAIL_USER) {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: `"Meta Intelligence | Docta Nexus" <${process.env.EMAIL_USER}>`,
        to: client.email_alerts.join(','),
        subject: `✓ Token Meta renovado automáticamente — ${client.name}`,
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0b0b0d;color:#edeef0;border-radius:12px;padding:24px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
            <div style="width:32px;height:32px;background:#c8f135;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#0b0b0d">D</div>
            <div style="font-weight:600">Meta Intelligence · Docta Nexus</div>
          </div>
          <div style="background:#151518;border-radius:8px;padding:16px;border-left:3px solid #5de8a0">
            <div style="color:#5de8a0;font-weight:600;margin-bottom:8px">✓ Token renovado automáticamente</div>
            <div style="color:#9a9aaa;font-size:13px;line-height:1.6">
              El token de acceso de <strong style="color:#edeef0">${client.name}</strong> fue renovado automáticamente.<br>
              Válido por aproximadamente 60 días más.<br>
              Fecha: ${new Date().toLocaleDateString('es-AR')}
            </div>
          </div>
          <div style="text-align:center;margin-top:16px;font-size:11px;color:#52525c">
            Meta Intelligence · <a href="https://doctanexus.com" style="color:#c8f135;text-decoration:none">Docta Nexus</a>
          </div>
        </div>`
      }).catch(e => console.error('[TOKEN] Error enviando email:', e.message));
    }

  } catch(e) {
    console.error(`[TOKEN] Error renovando token de ${slug}:`, e.message);
    // Notificar el error por email
    const clientFresh = loadClient(slug);
    if (clientFresh?.email_alerts?.length && process.env.EMAIL_USER) {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: `"Meta Intelligence | Docta Nexus" <${process.env.EMAIL_USER}>`,
        to: clientFresh.email_alerts.join(','),
        subject: `⚠️ Error renovando token Meta — ${clientFresh.name} — acción requerida`,
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0b0b0d;color:#edeef0;border-radius:12px;padding:24px">
          <div style="background:#151518;border-radius:8px;padding:16px;border-left:3px solid #f26d6d">
            <div style="color:#f26d6d;font-weight:600;margin-bottom:8px">⚠️ Token de Meta requiere renovación manual</div>
            <div style="color:#9a9aaa;font-size:13px;line-height:1.6">
              No se pudo renovar automáticamente el token de <strong style="color:#edeef0">${clientFresh.name}</strong>.<br>
              Error: ${e.message}<br><br>
              Renovalo manualmente desde <a href="https://developers.facebook.com/tools/explorer/" style="color:#c8f135">Graph API Explorer</a>.
            </div>
          </div>
          <div style="text-align:center;margin-top:16px;font-size:11px;color:#52525c">
            Meta Intelligence · <a href="https://doctanexus.com" style="color:#c8f135;text-decoration:none">Docta Nexus</a>
          </div>
        </div>`
      }).catch(() => {});
    }
  }
}

// ── CRON: reporte diario/semanal según configuración ─────────
cron.schedule('0 ' + REPORT_HOUR + ' * * *', async () => {
  const isMonday = new Date().getDay() === 1;
  console.log('[CRON] Verificando reportes...');
  for (const slug of listClients()) {
    try {
      const client = loadClient(slug);
      if (!client) continue;
      const cfg = client.alert_config || {};
      if (!cfg.t_daily) continue; // Reporte desactivado
      const frequency = cfg.frequency || 'daily';
      // Si es semanal y no es lunes, saltar
      if (frequency === 'weekly' && !isMonday) continue;
      const { metrics, analysis } = await runPipeline(slug);
      await sendReport(client, metrics, analysis);
      console.log('[CRON] Reporte enviado: ' + slug + ' (' + frequency + ')');
    } catch(e) {
      console.error('[CRON] Error en ' + slug + ':', e.message);
    }
  }
}, { timezone: TZ });

// ── CRON: renovación de tokens cada 12 horas ──────────────────
cron.schedule('0 */12 * * *', async () => {
  console.log('[CRON] Verificando tokens de Meta...');
  for (const slug of listClients()) {
    await renewTokenIfNeeded(slug).catch(e =>
      console.error('[CRON] Error verificando token de ' + slug + ':', e.message)
    );
  }
}, { timezone: TZ });

// ── ENDPOINTS ─────────────────────────────────────────────────
// Auth middleware
function authMiddleware(req, res, next) {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body || req.query;
  if (password !== client.password) return res.status(401).json({ error: 'Contraseña incorrecta' });
  req.client = client;
  req.clientSlug = slug;
  next();
}

// Login
app.post('/api/:slug/login', (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'Contraseña incorrecta' });
  res.json({
    ok: true,
    name: client.name,
    colorPrimary: client.colorPrimary || '#c8f135',
    colorAccent: client.colorAccent || '#a3c72c',
    colorBtnText: client.colorBtnText || '#0b0b0d',
    objective: client.objective,
    kpi_targets: client.kpi_targets,
    alert_config: client.alert_config,
    dash_config: client.dash_config,
    currency: client.currency || 'ARS'
  });
});

// Obtener datos del dashboard (requiere auth via query param)
app.get('/api/:slug/dashboard', async (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.query;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });

  try {
    // Intentar cargar datos de hoy
    const dir = path.join(__dirname, 'data', slug);
    const todayFile = path.join(dir, today() + '.json');
    let result;
    if (fs.existsSync(todayFile)) {
      result = JSON.parse(fs.readFileSync(todayFile, 'utf8'));
    } else {
      // Generar datos nuevos
      result = await runPipeline(slug);
    }
    const history = loadHistory(slug, 14);
    res.json({ ...result, history });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Refrescar análisis manualmente
app.post('/api/:slug/refresh', async (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  try {
    const result = await runPipeline(slug);
    const history = loadHistory(slug, 14);
    res.json({ ...result, history });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Enviar reporte manual
app.post('/api/:slug/send-report', async (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  try {
    const dir = path.join(__dirname, 'data', slug);
    // Buscar el archivo más reciente (hoy o último disponible)
    let result = null;
    const todayFile = path.join(dir, today() + '.json');
    if (fs.existsSync(todayFile)) {
      result = JSON.parse(fs.readFileSync(todayFile, 'utf8'));
    } else {
      // Usar el más reciente disponible
      const history = loadHistory(slug, 1);
      if (!history.length) return res.status(400).json({ error: 'No hay datos disponibles. Primero hacé clic en Actualizar en el dashboard.' });
      result = history[0];
    }
    client.slug = slug;
    await sendReport(client, result.metrics, result.analysis);
    res.json({ ok: true, message: 'Reporte enviado a ' + client.email_alerts.join(', ') });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Guardar KPI targets
app.post('/api/:slug/save-kpis', (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, kpis } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  const fp = path.join(__dirname, 'clients', slug + '.json');
  client.kpi_targets = kpis;
  fs.writeFileSync(fp, JSON.stringify(client, null, 2));
  res.json({ ok: true });
});

// Guardar configuración del dashboard (métricas visibles)
app.post('/api/:slug/save-dashboard-config', (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, dashConfig } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  const fp = path.join(__dirname, 'clients', slug + '.json');
  client.dash_config = dashConfig;
  fs.writeFileSync(fp, JSON.stringify(client, null, 2));
  res.json({ ok: true });
});

// Guardar configuración de alertas
app.post('/api/:slug/save-alerts', (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, alertConfig } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  const fp = path.join(__dirname, 'clients', slug + '.json');
  client.alert_config = alertConfig;
  // Sincronizar email_alerts con lo configurado en el panel
  if (alertConfig.emails) {
    client.email_alerts = alertConfig.emails.split(',').map(e => e.trim()).filter(Boolean);
  }
  fs.writeFileSync(fp, JSON.stringify(client, null, 2));
  res.json({ ok: true });
});

// Métricas por período (ayer / 7d / 30d)
app.get('/api/:slug/metrics', async (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period } = req.query;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  try {
    const preset = period === 'yesterday' ? 'yesterday' : period === '30d' ? 'last_30d' : 'last_7d';
    const token = client.access_token;
    const accountId = client.ad_account_id;
    const fields = 'spend,impressions,clicks,ctr,cpm,reach,frequency,actions,action_values,unique_clicks,unique_ctr,landing_page_views,outbound_clicks';
    const data = await metaFetch(
      '/' + accountId + '/insights?fields=' + fields + '&date_preset=' + preset + '&level=account&',
      token
    );
    const campaigns = await metaFetch(
      '/' + accountId + '/insights?fields=' + fields + ',campaign_id,campaign_name&date_preset=' + preset + '&level=campaign&limit=50&',
      token
    );
    res.json({ account: data.data?.[0] || {}, campaigns: campaigns.data || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Analizar solo (sin refrescar métricas de Meta)
app.post('/api/:slug/analyze-only', async (req, res) => {
  const slug = req.params.slug;
  const client = loadClient(slug);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { password, period } = req.body;
  if (password !== client.password) return res.status(401).json({ error: 'No autorizado' });
  try {
    // Cargar métricas del snapshot más reciente
    const history = loadHistory(slug, 1);
    if (!history.length) return res.status(400).json({ error: 'No hay datos. Primero actualizá el dashboard.' });
    const metrics = history[0].metrics;
    client.slug = slug;
    const analysis = await runAnalysis(client, metrics);
    // Guardar análisis actualizado en el snapshot
    const dir = path.join(__dirname, 'data', slug);
    const todayFile = path.join(dir, today() + '.json');
    if (fs.existsSync(todayFile)) {
      const snap = JSON.parse(fs.readFileSync(todayFile, 'utf8'));
      snap.analysis = analysis;
      fs.writeFileSync(todayFile, JSON.stringify(snap, null, 2));
    }
    res.json({ analysis });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (_, res) => res.json({ status: 'ok', clients: listClients(), version: '2.0' }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('\n✦ Meta Ads Intelligence — Docta Nexus');
  console.log('  http://localhost:' + PORT);
  console.log('  Clientes: ' + (listClients().join(', ') || 'ninguno') + '\n');
});
