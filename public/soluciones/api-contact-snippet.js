// ─────────────────────────────────────────────────────────────
// Endpoint de contacto para la Home de Growth Intelligence
// Pegar dentro de server.js (requiere que ya tengas Resend configurado,
// como en el resto de tus proyectos de Docta Nexus)
// ─────────────────────────────────────────────────────────────

// Variables de entorno necesarias en Render:
//   RECAPTCHA_SECRET_KEY   -> secret key de reCAPTCHA v3 (NUNCA hardcodeada)
//   RESEND_API_KEY         -> la que ya usás en el resto de los proyectos
//   CONTACT_TO_EMAIL       -> contact@doctanexus.com (o hardcodealo si preferís)

const { Resend } = require('resend'); // ya debería estar instalado si lo usás en otros proyectos
const resend = new Resend(process.env.RESEND_API_KEY);

async function verifyRecaptcha(token) {
  if (!token) return { success: false, score: 0 };
  const params = new URLSearchParams({
    secret: process.env.RECAPTCHA_SECRET_KEY,
    response: token,
  });
  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  return res.json(); // { success, score, action, ... }
}

app.post('/api/contact', async (req, res) => {
  try {
    const { nombre, empresa, email, mensaje, recaptchaToken } = req.body;

    if (!nombre || !email) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    // 1) Verificar reCAPTCHA v3
    const captcha = await verifyRecaptcha(recaptchaToken);
    // v3 devuelve un score de 0 a 1 (1 = muy probablemente humano).
    // 0.5 es el umbral recomendado por Google como punto de partida;
    // podés subirlo a 0.7 si empezás a ver spam pasar el filtro.
    if (!captcha.success || captcha.score < 0.5) {
      console.warn('[contacto] reCAPTCHA rechazado', captcha);
      return res.status(400).json({ error: 'Verificación de seguridad fallida' });
    }

    // 2) Mandar el mail por Resend
    await resend.emails.send({
      from: 'Growth Intelligence <no-reply@doctanexus.com>', // ajustar al remitente verificado en tu cuenta de Resend
      to: process.env.CONTACT_TO_EMAIL || 'contact@doctanexus.com',
      reply_to: email,
      subject: `Nuevo contacto desde la web — ${nombre}`,
      html: `
        <p><strong>Nombre:</strong> ${nombre}</p>
        <p><strong>Empresa:</strong> ${empresa || '-'}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Mensaje:</strong><br>${(mensaje || '').replace(/\n/g, '<br>')}</p>
        <p style="color:#888;font-size:12px;">Score reCAPTCHA: ${captcha.score}</p>
      `,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[contacto] Error enviando mail:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});
