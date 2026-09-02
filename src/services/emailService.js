//src/services/emailService.js
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SG_API_KEY);

exports.sendHtmlEmail = async ({ to, from, fromName, subject, html, attachments }) => {
  const msg = {
    to,
    from: { email: from, name: fromName },
    subject,
    html,
    attachments,
  };
  await sgMail.send(msg);
};
