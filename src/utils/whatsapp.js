// src/utils/whatsapp.js
const logger = require('./logger');

const sendWhatsAppOtp = async (phone, otp) => {
  const url = process.env.WHATSAPP_API_URL; // e.g., https://graph.facebook.com/v17.0/YOUR_PHONE_ID/messages
  const token = process.env.WHATSAPP_TOKEN;
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME;

  // Agar env variables nahi hain, toh development mode me log karein
  if (!url || !token) {
    logger.warn(`⚠️ WhatsApp credentials missing. OTP for ${phone} is: ${otp}`);
    return true; 
  }

  const payload = {
    messaging_product: "whatsapp",
    to: `91${phone}`, // India country code prefixed
    type: "template",
    template: {
      name: templateName,
      language: { code: "en_US" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: otp } // Aapke template ka {{1}} variable
          ]
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [
            { type: "text", text: otp } // Agar button me copy code ka option h
          ]
        }
      ]
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'WhatsApp API Error');
    
    logger.info(`💬 WhatsApp OTP sent successfully to ${phone}`);
    return true;
  } catch (error) {
    logger.error(`❌ Failed to send WhatsApp message: ${error.message}`);
    throw new Error('Failed to send verification code');
  }
};

module.exports = { sendWhatsAppOtp };
