//src/services/whatsappService.js
const WHATSAPP_API = `https://graph.facebook.com/v19.0/${process.env.PHONE_ID}/messages`;

async function sendTemplate(to, templateName, languageCode, components) {
  const res = await fetch(WHATSAPP_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to.replace(/\D/g, ''), // digits only, with country code
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode || 'en' },
        components,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'WhatsApp send failed');
  return data;
}

async function sendDocument(to, documentUrl, filename, caption) {
  const res = await fetch(WHATSAPP_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to.replace(/\D/g, ''),
      type: 'document',
      document: { link: documentUrl, filename, caption },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'WhatsApp document send failed');
  return data;
}

module.exports = { sendTemplate, sendDocument };
