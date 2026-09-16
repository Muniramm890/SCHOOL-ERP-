
// src/controllers/commHubController.js
// 🔴 COMMUNICATION HUB — targeted notices/notifications across app/whatsapp/email
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { sendHtmlEmail } = require('../services/emailService');
const { sendTemplate } = require('../services/whatsappService');
const { logAudit } = require('../utils/auditLogger');

// ────────────────────────────────────────────────────────────────
// Internal: resolve comm_message_targets (criteria) → concrete list
// of { recipient_type, student_id|null, user_id|null }
// ────────────────────────────────────────────────────────────────
async function resolveRecipients(schoolId, academicYearId, targets) {
  const map = new Map(); // key = `${type}:${id}` → { recipient_type, student_id, user_id }

  for (const t of targets) {
    if (t.target_type === 'all_school') {
      const students = await query(
        `SELECT DISTINCT e.student_id FROM enrolments e
         WHERE e.school_id=@sid AND e.academic_year_id=@ay AND e.is_active=1 AND e.deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId }, ay: { type: sql.UniqueIdentifier, value: academicYearId } }
      );
      students.recordset.forEach((r) => map.set(`student:${r.student_id}`, { recipient_type: 'student', student_id: r.student_id, user_id: null }));

      const staff = await query(
        `SELECT DISTINCT sm.user_id FROM school_members sm WHERE sm.school_id=@sid AND sm.is_active=1 AND sm.deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId } }
      );
      staff.recordset.forEach((r) => map.set(`staff:${r.user_id}`, { recipient_type: 'staff', student_id: null, user_id: r.user_id }));
    }

    else if (t.target_type === 'grade') {
      const rows = await query(
        `SELECT DISTINCT e.student_id FROM enrolments e
         JOIN sections sc ON sc.id = e.section_id
         WHERE e.school_id=@sid AND e.academic_year_id=@ay AND sc.grade_id=@gid AND e.is_active=1 AND e.deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId }, ay: { type: sql.UniqueIdentifier, value: academicYearId }, gid: { type: sql.UniqueIdentifier, value: t.grade_id } }
      );
      rows.recordset.forEach((r) => map.set(`student:${r.student_id}`, { recipient_type: 'student', student_id: r.student_id, user_id: null }));
    }

    else if (t.target_type === 'section') {
      const rows = await query(
        `SELECT DISTINCT e.student_id FROM enrolments e
         WHERE e.school_id=@sid AND e.academic_year_id=@ay AND e.section_id=@secId AND e.is_active=1 AND e.deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId }, ay: { type: sql.UniqueIdentifier, value: academicYearId }, secId: { type: sql.UniqueIdentifier, value: t.section_id } }
      );
      rows.recordset.forEach((r) => map.set(`student:${r.student_id}`, { recipient_type: 'student', student_id: r.student_id, user_id: null }));
    }

    else if (t.target_type === 'gender_in_section') {
      const rows = await query(
        `SELECT DISTINCT e.student_id FROM enrolments e
         JOIN students s ON s.id = e.student_id
         WHERE e.school_id=@sid AND e.academic_year_id=@ay AND e.section_id=@secId
           AND s.gender=@gender AND e.is_active=1 AND e.deleted_at IS NULL`,
        {
          sid: { type: sql.UniqueIdentifier, value: schoolId }, ay: { type: sql.UniqueIdentifier, value: academicYearId },
          secId: { type: sql.UniqueIdentifier, value: t.section_id }, gender: { type: sql.VarChar(20), value: t.gender },
        }
      );
      rows.recordset.forEach((r) => map.set(`student:${r.student_id}`, { recipient_type: 'student', student_id: r.student_id, user_id: null }));
    }

    else if (t.target_type === 'student') {
      if (t.student_id) map.set(`student:${t.student_id}`, { recipient_type: 'student', student_id: t.student_id, user_id: null });
    }

    else if (t.target_type === 'subject_teachers') {
      const rows = await query(
        `SELECT DISTINCT ts.teacher_user_id AS user_id FROM teacher_subjects ts
         WHERE ts.school_id=@sid AND ts.academic_year_id=@ay AND ts.subject_id=@subId`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId }, ay: { type: sql.UniqueIdentifier, value: academicYearId }, subId: { type: sql.UniqueIdentifier, value: t.subject_id } }
      );
      rows.recordset.forEach((r) => map.set(`staff:${r.user_id}`, { recipient_type: 'staff', student_id: null, user_id: r.user_id }));
    }

    else if (t.target_type === 'class_teachers') {
      let where = `sc.school_id=@sid AND sc.academic_year_id=@ay AND sc.class_teacher_id IS NOT NULL`;
      const params = { sid: { type: sql.UniqueIdentifier, value: schoolId }, ay: { type: sql.UniqueIdentifier, value: academicYearId } };
      if (t.section_id) { where += ` AND sc.id=@secId`; params.secId = { type: sql.UniqueIdentifier, value: t.section_id }; }
      else if (t.grade_id) { where += ` AND sc.grade_id=@gid`; params.gid = { type: sql.UniqueIdentifier, value: t.grade_id }; }
      const rows = await query(`SELECT DISTINCT sc.class_teacher_id AS user_id FROM sections sc WHERE ${where}`, params);
      rows.recordset.forEach((r) => map.set(`staff:${r.user_id}`, { recipient_type: 'staff', student_id: null, user_id: r.user_id }));
    }

    else if (t.target_type === 'role') {
      const rows = await query(
        `SELECT DISTINCT sm.user_id FROM school_members sm
         WHERE sm.school_id=@sid AND sm.role=@role AND sm.is_active=1 AND sm.deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId }, role: { type: sql.VarChar(30), value: t.role } }
      );
      rows.recordset.forEach((r) => map.set(`staff:${r.user_id}`, { recipient_type: 'staff', student_id: null, user_id: r.user_id }));
    }
  }

  return Array.from(map.values());
}

// ────────────────────────────────────────────────────────────────
// Internal: fetch contact info (email/phone) for dispatch
// Students → primary guardian's contact. Staff → their own contact.
// ────────────────────────────────────────────────────────────────
async function getContactInfo(schoolId, recipients) {
  const studentIds = recipients.filter((r) => r.recipient_type === 'student').map((r) => r.student_id);
  const userIds = recipients.filter((r) => r.recipient_type === 'staff').map((r) => r.user_id);

  const contacts = new Map(); // key = `${type}:${id}` → { name, email, phone }

  if (studentIds.length) {
    const rows = await query(
      `SELECT g.student_id, g.full_name, g.email, g.phone
       FROM student_guardians g
       WHERE g.school_id=@sid AND g.student_id IN (${studentIds.map((_, i) => `@s${i}`).join(',')}) AND g.deleted_at IS NULL
       ORDER BY g.is_primary DESC`,
      Object.assign(
        { sid: { type: sql.UniqueIdentifier, value: schoolId } },
        Object.fromEntries(studentIds.map((id, i) => [`s${i}`, { type: sql.UniqueIdentifier, value: id }]))
      )
    );
    rows.recordset.forEach((r) => {
      const key = `student:${r.student_id}`;
      if (!contacts.has(key)) contacts.set(key, { name: r.full_name, email: r.email, phone: r.phone }); // first = primary (ORDER BY is_primary DESC)
    });
  }

  if (userIds.length) {
    const rows = await query(
      `SELECT id, full_name, email, phone FROM users
       WHERE id IN (${userIds.map((_, i) => `@u${i}`).join(',')})`,
      Object.fromEntries(userIds.map((id, i) => [`u${i}`, { type: sql.UniqueIdentifier, value: id }]))
    );
    rows.recordset.forEach((r) => contacts.set(`staff:${r.id}`, { name: r.full_name, email: r.email, phone: r.phone }));
  }

  return contacts;
}

// ── POST /api/comm/preview ── (count recipients before sending, no DB writes)
exports.previewTargets = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { academic_year_id, targets } = req.body;
    if (!academic_year_id || !Array.isArray(targets) || targets.length === 0) {
      return badRequest(res, 'academic_year_id and targets[] are required');
    }
    const recipients = await resolveRecipients(schoolId, academic_year_id, targets);
    return success(res, {
      total: recipients.length,
      students: recipients.filter((r) => r.recipient_type === 'student').length,
      staff: recipients.filter((r) => r.recipient_type === 'staff').length,
    });
  } catch (err) { next(err); }
};

// ── GET /api/comm/whatsapp-templates ──
exports.listWhatsappTemplates = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const rows = await query(
      `SELECT * FROM whatsapp_templates WHERE (school_id=@sid OR school_id IS NULL) AND is_active=1 ORDER BY name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, rows.recordset);
  } catch (err) { next(err); }
};

// ── POST /api/comm/whatsapp-templates ── (register an approved template)
exports.createWhatsappTemplate = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { name, language_code = 'en', variables_meta, category, school_scoped = true } = req.body;
    if (!name) return badRequest(res, 'name is required');

    const r = await query(
      `INSERT INTO whatsapp_templates (school_id, name, language_code, variables_meta, category)
       OUTPUT INSERTED.id
       VALUES (@sid, @name, @lang, @vars, @cat)`,
      {
        sid: { type: sql.UniqueIdentifier, value: school_scoped ? schoolId : null },
        name: { type: sql.VarChar(100), value: name },
        lang: { type: sql.VarChar(10), value: language_code },
        vars: { type: sql.NVarChar(sql.MAX), value: variables_meta ? JSON.stringify(variables_meta) : null },
        cat: { type: sql.VarChar(30), value: category || null },
      }
    );
    return created(res, { id: r.recordset[0].id });
  } catch (err) { next(err); }
};

// ── GET /api/comm/messages?page=&category= ── (history)
exports.listMessages = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { page = 1, limit = 20, category } = req.query;
    const offset = (page - 1) * limit;

    let where = `m.school_id=@sid`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };
    if (category) { where += ` AND m.category=@cat`; params.cat = { type: sql.VarChar(30), value: category }; }

    const count = await queryOne(`SELECT COUNT(*) AS total FROM comm_messages m WHERE ${where}`, params);
    const rows = await query(
      `SELECT m.*, u.full_name AS created_by_name,
              (SELECT COUNT(*) FROM comm_recipients r WHERE r.message_id=m.id) AS recipient_count,
              (SELECT COUNT(*) FROM comm_deliveries d JOIN comm_recipients r ON r.id=d.recipient_id WHERE r.message_id=m.id AND d.status='sent') AS sent_count,
              (SELECT COUNT(*) FROM comm_deliveries d JOIN comm_recipients r ON r.id=d.recipient_id WHERE r.message_id=m.id AND d.status='failed') AS failed_count
       FROM comm_messages m
       JOIN users u ON u.id = m.created_by
       WHERE ${where}
       ORDER BY m.created_at DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      { ...params, offset: { type: sql.Int, value: +offset }, limit: { type: sql.Int, value: +limit } }
    );
    return paginated(res, rows.recordset, count.total, page, limit);
  } catch (err) { next(err); }
};

// ── GET /api/comm/messages/:id ── (detail + per-channel delivery stats)
exports.getMessage = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;
    const msg = await queryOne(
      `SELECT m.*, u.full_name AS created_by_name FROM comm_messages m JOIN users u ON u.id=m.created_by
       WHERE m.id=@id AND m.school_id=@sid`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!msg) return notFound(res, 'Message not found');

    const channels = await query(`SELECT channel FROM comm_message_channels WHERE message_id=@id`, { id: { type: sql.UniqueIdentifier, value: id } });
    const deliveryStats = await query(
      `SELECT d.channel, d.status, COUNT(*) AS cnt FROM comm_deliveries d
       JOIN comm_recipients r ON r.id = d.recipient_id
       WHERE r.message_id=@id GROUP BY d.channel, d.status`,
      { id: { type: sql.UniqueIdentifier, value: id } }
    );

    return success(res, { ...msg, channels: channels.recordset.map((c) => c.channel), delivery_stats: deliveryStats.recordset });
  } catch (err) { next(err); }
};

// ── POST /api/comm/messages ── (compose + resolve + dispatch, all-in-one)
// body: { title, body, category, channels: ['app','whatsapp','email'],
//         targets: [{ target_type, grade_id?, section_id?, subject_id?, student_id?, gender?, role? }],
//         whatsapp_template_id?, whatsapp_variables? (array), source_module?, source_id?, academic_year_id }
exports.createAndSend = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const {
      title, body, category = 'general', channels, targets,
      whatsapp_template_id, whatsapp_variables, source_module, source_id, academic_year_id,
    } = req.body;

    if (!title || !body) return badRequest(res, 'title and body are required');
    if (!Array.isArray(channels) || channels.length === 0) return badRequest(res, 'at least one channel is required');
    if (!Array.isArray(targets) || targets.length === 0) return badRequest(res, 'at least one target is required');

    let ayId = academic_year_id;
    if (!ayId) {
      const cur = await queryOne(`SELECT id FROM academic_years WHERE school_id=@sid AND is_current=1`, { sid: { type: sql.UniqueIdentifier, value: schoolId } });
      ayId = cur?.id;
    }
    if (!ayId) return badRequest(res, 'No academic session found for this school');

    if (channels.includes('whatsapp') && !whatsapp_template_id) {
      return badRequest(res, 'whatsapp_template_id is required when whatsapp channel is selected');
    }

    // 1. Resolve recipients BEFORE writing anything — fail fast if nobody matches
    const recipients = await resolveRecipients(schoolId, ayId, targets);
    if (recipients.length === 0) return badRequest(res, 'No recipients matched the selected targets');

    // 2. Create message + channels + targets + recipients (transactional)
    const txResult = await withTransaction(async (tx) => {
      const msgRes = await new sql.Request(tx)
        .input('sid', sql.UniqueIdentifier, schoolId)
        .input('ay', sql.UniqueIdentifier, ayId)
        .input('title', sql.NVarChar(200), title)
        .input('body', sql.NVarChar(sql.MAX), body)
        .input('cat', sql.VarChar(30), category)
        .input('waTpl', sql.UniqueIdentifier, whatsapp_template_id || null)
        .input('srcMod', sql.VarChar(30), source_module || 'manual')
        .input('srcId', sql.UniqueIdentifier, source_id || null)
        .input('by', sql.UniqueIdentifier, userId)
        .query(
          `INSERT INTO comm_messages (school_id, academic_year_id, title, body, category, whatsapp_template_id, source_module, source_id, status, created_by)
           OUTPUT INSERTED.id
           VALUES (@sid, @ay, @title, @body, @cat, @waTpl, @srcMod, @srcId, 'sending', @by)`
        );
      const msgId = msgRes.recordset[0].id;

      for (const ch of channels) {
        await new sql.Request(tx)
          .input('sid', sql.UniqueIdentifier, schoolId)
          .input('mid', sql.UniqueIdentifier, msgId)
          .input('ch', sql.VarChar(20), ch)
          .query(`INSERT INTO comm_message_channels (school_id, message_id, channel) VALUES (@sid, @mid, @ch)`);
      }

      for (const t of targets) {
        await new sql.Request(tx)
          .input('sid', sql.UniqueIdentifier, schoolId)
          .input('mid', sql.UniqueIdentifier, msgId)
          .input('ttype', sql.VarChar(30), t.target_type)
          .input('gid', sql.UniqueIdentifier, t.grade_id || null)
          .input('secId', sql.UniqueIdentifier, t.section_id || null)
          .input('subId', sql.UniqueIdentifier, t.subject_id || null)
          .input('stid', sql.UniqueIdentifier, t.student_id || null)
          .input('gender', sql.VarChar(20), t.gender || null)
          .input('role', sql.VarChar(30), t.role || null)
          .query(
            `INSERT INTO comm_message_targets (school_id, message_id, target_type, grade_id, section_id, subject_id, student_id, gender, role)
             VALUES (@sid, @mid, @ttype, @gid, @secId, @subId, @stid, @gender, @role)`
          );
      }

      const recipientRows = [];
      for (const r of recipients) {
        const rRes = await new sql.Request(tx)
          .input('sid', sql.UniqueIdentifier, schoolId)
          .input('mid', sql.UniqueIdentifier, msgId)
          .input('rtype', sql.VarChar(10), r.recipient_type)
          .input('stid', sql.UniqueIdentifier, r.student_id || null)
          .input('uid', sql.UniqueIdentifier, r.user_id || null)
          .query(
            `INSERT INTO comm_recipients (school_id, message_id, recipient_type, student_id, user_id)
             OUTPUT INSERTED.id
             VALUES (@sid, @mid, @rtype, @stid, @uid)`
          );
        recipientRows.push({ id: rRes.recordset[0].id, ...r });
      }

      return { msgId, recipientRows };
    });

    // 3. Dispatch across channels (outside the transaction — network calls shouldn't hold a DB lock)
    const contacts = await getContactInfo(schoolId, recipients);
    let anyFailed = false;
    let anySent = false;

    for (const r of txResult.recipientRows) {
      const contactKey = r.recipient_type === 'student' ? `student:${r.student_id}` : `staff:${r.user_id}`;
      const contact = contacts.get(contactKey);

      for (const ch of channels) {
        let status = 'pending', providerMsgId = null, errorMsg = null;

        try {
          if (ch === 'app') {
            if (r.recipient_type === 'student') {
              await query(
                `INSERT INTO student_notifications (school_id, student_id, type, title, message, related_id)
                 VALUES (@sid, @stid, @type, @title, @msg, @relId)`,
                {
                  sid: { type: sql.UniqueIdentifier, value: schoolId }, stid: { type: sql.UniqueIdentifier, value: r.student_id },
                  type: { type: sql.VarChar(40), value: category }, title: { type: sql.NVarChar(200), value: title },
                  msg: { type: sql.NVarChar(500), value: body.slice(0, 500) }, relId: { type: sql.UniqueIdentifier, value: txResult.msgId },
                }
              );
            } else {
              await query(
                `INSERT INTO staff_notifications (school_id, user_id, type, title, message, related_id)
                 VALUES (@sid, @uid, @type, @title, @msg, @relId)`,
                {
                  sid: { type: sql.UniqueIdentifier, value: schoolId }, uid: { type: sql.UniqueIdentifier, value: r.user_id },
                  type: { type: sql.VarChar(40), value: category }, title: { type: sql.NVarChar(200), value: title },
                  msg: { type: sql.NVarChar(500), value: body.slice(0, 500) }, relId: { type: sql.UniqueIdentifier, value: txResult.msgId },
                }
              );
            }
            status = 'sent';
          }

          else if (ch === 'email') {
            if (!contact?.email) throw new Error('No email on file for this recipient');
            await sendHtmlEmail({
              to: contact.email, from: process.env.SG_FROM_EMAIL, fromName: process.env.SG_FROM_NAME || 'School Office',
              subject: title, html: `<p>${body.replace(/\n/g, '<br/>')}</p>`,
            });
            status = 'sent';
          }

          else if (ch === 'whatsapp') {
            if (!contact?.phone) throw new Error('No phone on file for this recipient');
            const tpl = await queryOne(`SELECT * FROM whatsapp_templates WHERE id=@id`, { id: { type: sql.UniqueIdentifier, value: whatsapp_template_id } });
            if (!tpl) throw new Error('WhatsApp template not found');
            const components = whatsapp_variables?.length
              ? [{ type: 'body', parameters: whatsapp_variables.map((v) => ({ type: 'text', text: v })) }]
              : undefined;
            const waRes = await sendTemplate(contact.phone, tpl.name, tpl.language_code, components);
            providerMsgId = waRes?.messages?.[0]?.id || null;
            status = 'sent';
          }

          else if (ch === 'sms') {
            // 🔴 Ready-to-integrate: jab SMS provider add ho, isi block me call daal do — schema/flow already ready hai
            throw new Error('SMS channel not yet configured');
          }
        } catch (e) {
          status = 'failed';
          errorMsg = e.message?.slice(0, 500) || 'Unknown error';
        }

        if (status === 'sent') anySent = true; else anyFailed = true;

        await query(
          `INSERT INTO comm_deliveries (school_id, recipient_id, channel, status, provider_message_id, error_message, sent_at)
           VALUES (@sid, @rid, @ch, @status, @pmid, @err, CASE WHEN @status='sent' THEN GETUTCDATE() ELSE NULL END)`,
          {
            sid: { type: sql.UniqueIdentifier, value: schoolId }, rid: { type: sql.UniqueIdentifier, value: r.id },
            ch: { type: sql.VarChar(20), value: ch }, status: { type: sql.VarChar(20), value: status },
            pmid: { type: sql.NVarChar(200), value: providerMsgId }, err: { type: sql.NVarChar(500), value: errorMsg },
          }
        );
      }
    }

    const finalStatus = anyFailed && anySent ? 'partial' : anyFailed ? 'failed' : 'sent';
    await query(`UPDATE comm_messages SET status=@st WHERE id=@id`, {
      st: { type: sql.VarChar(20), value: finalStatus }, id: { type: sql.UniqueIdentifier, value: txResult.msgId },
    });

    logAudit({ schoolId, userId, actionType: 'COMM_MESSAGE_SENT', details: JSON.stringify({ messageId: txResult.msgId, recipients: recipients.length, channels }) });

    return created(res, { id: txResult.msgId, status: finalStatus, recipient_count: recipients.length });
  } catch (err) { next(err); }
};