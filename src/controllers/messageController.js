// src/controllers/messageController.js
const axios = require('axios');
const { sql, poolPromise } = require('../config/db');
const { sendSuccess, sendError, sendPaginated } = require('../utils/response');
const logger = require('../config/logger');

const sch = process.env.DB_SCHEMA || 'whatsapp';

// ── SEND MESSAGE ──────────────────────────────────────────────
const sendMessage = async (req, res, next) => {
  try {
    const { instance_id, to, type = 'text', content, media_url, caption, template_id, template_vars } = req.body;
    const pool = await poolPromise;

    // Verify instance belongs to client
    const instanceRes = await pool.request()
      .input('instId', sql.Int, instance_id)
      .input('clientId', sql.Int, req.clientId)
      .query(`SELECT id, phone_id, access_token, status, api_type FROM ${sch}.whatsapp_instances WHERE id = @instId AND client_id = @clientId`);

    if (!instanceRes.recordset.length) return sendError(res, 404, 'Instance not found');
    const instance = instanceRes.recordset[0];
    if (instance.status !== 'connected') return sendError(res, 400, 'Instance not connected');

    // Check monthly usage (Azure SQL uses YEAR() and MONTH() with GETDATE())
    const usageRes = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT u.messages_sent, p.max_messages_pm
        FROM ${sch}.usage_stats u
        JOIN ${sch}.clients c ON c.id = u.client_id
        JOIN ${sch}.plans p ON p.id = c.plan_id
        WHERE u.client_id = @clientId AND u.period_year = YEAR(GETDATE()) AND u.period_month = MONTH(GETDATE())
      `);

    if (usageRes.recordset.length && usageRes.recordset[0].messages_sent >= usageRes.recordset[0].max_messages_pm)
      return sendError(res, 429, 'Monthly message limit reached. Please upgrade your plan.');

    // Insert message record
    const msgResult = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .input('instId', sql.Int, instance_id)
      .input('to', sql.VarChar, to)
      .input('type', sql.VarChar, type)
      .input('content', sql.NVarChar, content || null)
      .input('media', sql.VarChar, media_url || null)
      .input('caption', sql.NVarChar, caption || null)
      .input('tmplId', sql.Int, template_id || null)
      .query(`
        INSERT INTO ${sch}.messages (client_id, instance_id, direction, to_number, type, content, media_url, caption, template_id, status)
        OUTPUT inserted.id
        VALUES (@clientId, @instId, 'outbound', @to, @type, @content, @media, @caption, @tmplId, 'queued')
      `);

    const messageId = msgResult.recordset[0].id;

    // Build WA API payload
    let waPayload;
    if (type === 'text') {
      waPayload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: content } };
    } else if (type === 'template') {
      const tmplRes = await pool.request().input('tid', sql.Int, template_id).query(`SELECT name, language, components FROM ${sch}.templates WHERE id = @tid`);
      if (!tmplRes.recordset.length) return sendError(res, 404, 'Template not found');
      const tmpl = tmplRes.recordset[0];
      waPayload = {
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name: tmpl.name, language: { code: tmpl.language }, components: template_vars || [] }
      };
    } else {
      waPayload = { messaging_product: 'whatsapp', to, type, [type]: { link: media_url, caption: caption || undefined } };
    }

    // Send to WA Cloud API
    try {
      const waRes = await axios.post(
        `https://graph.facebook.com/${process.env.WA_API_VERSION || 'v18.0'}/${instance.phone_id}/messages`,
        waPayload,
        { headers: { Authorization: `Bearer ${instance.access_token}`, 'Content-Type': 'application/json' } }
      );

      const waMessageId = waRes.data?.messages?.[0]?.id;
      
      await pool.request()
        .input('waId', sql.VarChar, waMessageId)
        .input('mId', sql.BigInt, messageId)
        .query(`UPDATE ${sch}.messages SET wa_message_id = @waId, status = 'sent', sent_at = GETDATE() WHERE id = @mId`);

      // Update usage stats (Azure SQL UPSERT logic using MERGE)
      await pool.request()
        .input('clientId', sql.Int, req.clientId)
        .input('instId', sql.Int, instance_id)
        .query(`
          MERGE ${sch}.usage_stats AS target
          USING (SELECT @clientId as c, @instId as i, YEAR(GETDATE()) as y, MONTH(GETDATE()) as m) AS source
          ON (target.client_id = source.c AND target.instance_id = source.i AND target.period_year = source.y AND target.period_month = source.m)
          WHEN MATCHED THEN UPDATE SET messages_sent = messages_sent + 1
          WHEN NOT MATCHED THEN INSERT (client_id, instance_id, period_year, period_month, messages_sent) VALUES (@clientId, @instId, YEAR(GETDATE()), MONTH(GETDATE()), 1);
        `);

      await logApiRequest(req, res, 200);
      return sendSuccess(res, { message_id: messageId, wa_message_id: waMessageId }, 'Message sent');

    } catch (waErr) {
      const errMsg = waErr.response?.data?.error?.message || waErr.message;
      await pool.request().input('err', sql.NVarChar, errMsg).input('mId', sql.BigInt, messageId)
        .query(`UPDATE ${sch}.messages SET status = 'failed', error_message = @err, failed_at = GETDATE() WHERE id = @mId`);
      return sendError(res, 502, `WhatsApp API error: ${errMsg}`);
    }
  } catch (err) { next(err); }
};

// ── LIST MESSAGES ─────────────────────────────────────────────
const listMessages = async (req, res, next) => {
  try {
    const { instance_id, status, direction, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const pool = await poolPromise;

    let where = `WHERE m.client_id = @clientId`;
    const request = pool.request().input('clientId', sql.Int, req.clientId);

    if (instance_id) { where += ' AND m.instance_id = @instId'; request.input('instId', sql.Int, instance_id); }
    if (status) { where += ' AND m.status = @status'; request.input('status', sql.VarChar, status); }
    if (direction) { where += ' AND m.direction = @direction'; request.input('direction', sql.VarChar, direction); }

    const query = `
      SELECT m.id, m.wa_message_id, m.direction, m.to_number, m.from_number,
             m.type, m.content, m.media_url, m.status, m.sent_at, m.created_at, i.instance_name
      FROM ${sch}.messages m
      JOIN ${sch}.whatsapp_instances i ON i.id = m.instance_id
      ${where}
      ORDER BY m.created_at DESC
      OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
    `;

    const result = await request.query(query);
    const countRes = await pool.request().input('clientId', sql.Int, req.clientId).query(`SELECT COUNT(*) AS total FROM ${sch}.messages m ${where}`);

    return sendPaginated(res, result.recordset, countRes.recordset[0].total, page, limit);
  } catch (err) { next(err); }
};

// ── GET MESSAGE ───────────────────────────────────────────────
const getMessage = async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('id', sql.BigInt, req.params.id)
      .input('clientId', sql.Int, req.clientId)
      .query(`SELECT m.*, i.instance_name FROM ${sch}.messages m JOIN ${sch}.whatsapp_instances i ON i.id = m.instance_id WHERE m.id = @id AND m.client_id = @clientId`);

    if (!result.recordset.length) return sendError(res, 404, 'Message not found');

    const logs = await pool.request().input('mid', sql.BigInt, req.params.id)
      .query(`SELECT status, timestamp, wa_status FROM ${sch}.message_status_logs WHERE message_id = @mid ORDER BY timestamp ASC`);

    return sendSuccess(res, { ...result.recordset[0], status_timeline: logs.recordset });
  } catch (err) { next(err); }
};

// ── INCOMING WEBHOOK FROM META ────────────────────────────────
const receiveWebhook = async (req, res, next) => {
  try {
    // 1. Meta Verification (GET Request)
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.sendStatus(403);
    }

    // 2. Data Processing (POST Request)
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.sendStatus(400);

    const pool = await poolPromise;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;

        // --- A. INCOMING MESSAGES HANDLER ---
        for (const msg of value.messages || []) {
          const phoneId = value.metadata?.phone_number_id;
          
          // Instance find karein phone_id ke base par
          const instRes = await pool.request()
            .input('pid', sql.VarChar, phoneId)
            .query(`SELECT id, client_id FROM ${sch}.whatsapp_instances WHERE phone_id = @pid`);
          
          if (!instRes.recordset.length) continue;

          const { id: instanceId, client_id: clientId } = instRes.recordset[0];
          const msgType = msg.type;
          let content = (msgType === 'text') ? msg.text?.body : null;

          // Message table mein insert
          await pool.request()
            .input('cid', sql.Int, clientId)
            .input('iid', sql.Int, instanceId)
            .input('waId', sql.VarChar, msg.id)
            .input('from', sql.VarChar, msg.from)
            .input('type', sql.VarChar, msgType)
            .input('content', sql.NVarChar, content)
            .query(`
              INSERT INTO ${sch}.messages (client_id, instance_id, wa_message_id, direction, from_number, type, content, status, created_at) 
              VALUES (@cid, @iid, @waId, 'inbound', @from, @type, @content, 'delivered', GETDATE())
            `);

          // Update Usage Stats for Received Message
          await pool.request()
            .input('cid', sql.Int, clientId).input('iid', sql.Int, instanceId)
            .query(`
              MERGE ${sch}.usage_stats AS target
              USING (SELECT @cid as c, @iid as i, YEAR(GETDATE()) as y, MONTH(GETDATE()) as m) AS source
              ON (target.client_id = source.c AND target.instance_id = source.i AND target.period_year = source.y AND target.period_month = source.m)
              WHEN MATCHED THEN UPDATE SET messages_recv = messages_recv + 1
              WHEN NOT MATCHED THEN INSERT (client_id, instance_id, period_year, period_month, messages_sent, messages_recv, api_calls, cost_total) 
              VALUES (@cid, @iid, YEAR(GETDATE()), MONTH(GETDATE()), 0, 1, 0, 0);
            `);
        }

        // --- B. MESSAGE STATUS UPDATER (Sent, Delivered, Read, Failed) ---
        for (const status of value.statuses || []) {
          const waId = status.id;
          const st = status.status; // 'sent', 'delivered', 'read', 'failed'
          const ts = new Date(status.timestamp * 1000);

          // Phele check karein ki ye message humare DB mein hai ya nahi
          const msgRows = await pool.request()
            .input('waId', sql.VarChar, waId)
            .query(`SELECT id FROM ${sch}.messages WHERE wa_message_id = @waId`);
          
          if (!msgRows.recordset.length) continue;
          const msgId = msgRows.recordset[0].id;

          // 1. Log the status change
          await pool.request()
            .input('mid', sql.BigInt, msgId)
            .input('st', sql.VarChar, st)
            .input('ts', sql.DateTime, ts)
            .input('raw', sql.NVarChar, JSON.stringify(status))
            .query(`
              INSERT INTO ${sch}.message_status_logs (message_id, status, wa_status, timestamp, raw_payload, created_at) 
              VALUES (@mid, @st, @st, @ts, @raw, GETDATE())
            `);

          // 2. Update the main messages table
          let errorCode = null;
          let errorMessage = null;
          if (st === 'failed' && status.errors) {
            errorCode = status.errors[0].code.toString();
            errorMessage = status.errors[0].message;
          }

          await pool.request()
            .input('mid', sql.BigInt, msgId)
            .input('st', sql.VarChar, st)
            .input('ts', sql.DateTime, ts)
            .input('ec', sql.VarChar, errorCode)
            .input('em', sql.NVarChar, errorMessage)
            .query(`
              UPDATE ${sch}.messages 
              SET status = @st,
                  error_code = COALESCE(@ec, error_code),
                  error_message = COALESCE(@em, error_message),
                  delivered_at = CASE WHEN @st = 'delivered' THEN @ts ELSE delivered_at END,
                  read_at = CASE WHEN @st = 'read' THEN @ts ELSE read_at END,
                  failed_at = CASE WHEN @st = 'failed' THEN @ts ELSE failed_at END
              WHERE id = @mid
            `);
        }
      }
    }
    return res.sendStatus(200);
  } catch (err) { 
    logger.error('Webhook error:', err); 
    return res.sendStatus(500); 
  }
};

const logApiRequest = async (req, res, code) => {
  try {
    const pool = await poolPromise;
    await pool.request()
      .input('cid', sql.Int, req.clientId || null).input('akid', sql.Int, req.apiKeyId || null)
      .input('m', sql.VarChar, req.method).input('e', sql.VarChar, req.path)
      .input('ip', sql.VarChar, req.ip).input('c', sql.SmallInt, code)
      .query(`INSERT INTO ${sch}.api_request_logs (client_id, api_key_id, method, endpoint, ip_address, response_code) VALUES (@cid, @akid, @m, @e, @ip, @c)`);
  } catch (_) {}
};


// src/controllers/messageController.js mein ye function add karein:

const listTemplates = async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .query(`SELECT * FROM ${sch}.templates WHERE client_id = @clientId OR is_public = 1`);
    
    return sendSuccess(res, result.recordset);
  } catch (err) {
    next(err);
  }
};

// Meta Embedded Signup ke data ko save karne ke liye
const metaOnboarding = async (req, res, next) => {
  try {
    const { accessToken, wabaId, phoneId, phone_number } = req.body;
    const pool = await poolPromise;
    
    // Naya instance insert karein ya existing update karein
    await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .input('token', sql.NVarChar, accessToken)
      .input('waba', sql.VarChar, wabaId)
      .input('pid', sql.VarChar, phoneId)
      .input('phone', sql.VarChar, phone_number || 'Pending')
      .query(`
        IF EXISTS (SELECT 1 FROM ${sch}.whatsapp_instances WHERE waba_id = @waba AND client_id = @clientId)
        BEGIN
          UPDATE ${sch}.whatsapp_instances 
          SET access_token = @token, phone_id = @pid, status = 'connected'
          WHERE waba_id = @waba AND client_id = @clientId
        END
        ELSE
        BEGIN
          INSERT INTO ${sch}.whatsapp_instances (client_id, instance_name, access_token, waba_id, phone_id, status, api_type, phone_number)
          VALUES (@clientId, 'Meta Connected', @token, @waba, @pid, 'connected', 'cloud', @phone)
        END
      `);
    
    return sendSuccess(res, {}, 'WhatsApp Business Account Linked Successfully');
  } catch (err) {
    next(err);
  }
};
module.exports = { sendMessage, listMessages, getMessage, receiveWebhook, listTemplates, metaOnboarding };

