# Meta Intelligence — Docta Nexus

Dashboard de análisis de Meta Ads con agente IA experto en Advantage+ / Andromeda.

## Variables de entorno (Render)

```
ANTHROPIC_API_KEY=sk-ant-...
EMAIL_USER=tu@gmail.com
EMAIL_PASSWORD=app-password-gmail
PORT=3000
```

## Agregar un cliente

Crear `clients/SLUG.json`:

```json
{
  "name": "Nombre del Cliente",
  "slug": "slug-cliente",
  "password": "contraseña123",
  "ad_account_id": "act_XXXXXXXXXX",
  "access_token": "EAAG...",
  "email_alerts": ["cliente@email.com"],
  "report_hour": 8,
  "timezone": "America/Argentina/Buenos_Aires",
  "currency": "ARS",
  "objectives": {
    "roas_min": 3.0,
    "cpa_max": 2500,
    "cpm_max": 800,
    "ctr_min": 1.5,
    "frecuencia_max": 4.0,
    "budget_daily": 5000
  },
  "alert_thresholds": {
    "cpa_increase_pct": 20,
    "roas_decrease_pct": 15,
    "ctr_decrease_pct": 25,
    "frecuencia_alert": 3.5
  },
  "colorPrimary": "#c8f135",
  "colorAccent": "#a3c72c",
  "colorBtnText": "#0b0b0d"
}
```

## Obtener el Access Token de Meta

1. Ir a https://developers.facebook.com/tools/explorer/
2. Seleccionar tu app
3. Generar token con permisos: `ads_read`, `ads_management`, `read_insights`
4. Para token de larga duración usar Graph API: `GET /oauth/access_token`

## URL de acceso

Cada cliente accede por: `https://tu-app.onrender.com/`
Login con slug y contraseña definidos en el JSON.

## Deploy en Render

1. Crear nuevo Web Service
2. Conectar repo GitHub
3. Build command: `npm install`
4. Start command: `npm start`
5. Agregar variables de entorno
