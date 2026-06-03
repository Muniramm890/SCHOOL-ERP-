// src/controllers/noticesController.js
const { query, queryOne, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { audit } = require('../utils/audit');

// ── GET /api/notices?audience=&category=&page= ────────────────────────────
exports.list = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { audience, category, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let where = `n.school_id = @sid AND n.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (audience) { where += ` AND n.audience = @aud`;  params.aud = { type: sql.VarChar(50), value: audience }; }
    if (category) { where += ` AND n.category = @cat`;  params.cat = { type: sql.VarChar(50), value: category }; }

    const count = await queryOne(`SELECT COUNT(*) AS total FROM notices n WHERE ${where}`, params);

    const notices = await query(
      `SELECT n.*, u.full_name AS created_by_name,
              g.name AS target_grade_name, sc.name AS target_section_name
       FROM notices n
       JOIN users u         ON u.id  = n.created_by
       LEFT JOIN grades g   ON g.id  = n.target_grade_id
       LEFT JOIN sections sc ON sc.id = n.target_section_id
       WHERE ${where}
       ORDER BY n.created_at DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      { ...params, offset: { type: sql.Int, value: +offset }, limit: { type: sql.Int, value: +limit } }
    );

    return paginated(res, notices.recordset, count.total, page, limit);
  } catch (err) { next(err); }
};

// ── POST /api/notices ─────────────────────────────────────────────────────
exports.create = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { title, body, category = 'general', audience = 'all',
      target_grade_id, target_section_id, is_published = false,
      expires_at, attachment_urls } = req.body;

    const r = await query(
      `INSERT INTO notices (id,school_id,title,body,category,audience,target_grade_id,target_section_id,
         is_published,published_at,expires_at,attachment_urls,created_by)
       OUTPUT INSERTED.id
       VALUES(NEWID(),@sid,@title,@body,@cat,@aud,@gradeId,@secId,
         @pub, CASE WHEN @pub=1 THEN GETUTCDATE() ELSE NULL END,@exp,@attach,@createdBy)`,
      {
        sid:       { type: sql.UniqueIdentifier, value: schoolId },
        title:     { type: sql.NVarChar(sql.MAX), value: title },
        body:      { type: sql.NVarChar(sql.MAX), value: body },
        cat:       { type: sql.VarChar(50),       value: category },
        aud:       { type: sql.VarChar(50),       value: audience },
        gradeId:   { type: sql.UniqueIdentifier,  value: target_grade_id || null },
        secId:     { type: sql.UniqueIdentifier,  value: target_section_id || null },
        pub:       { type: sql.Bit,               value: is_published ? 1 : 0 },
        exp:       { type: sql.DateTime2,         value: expires_at || null },
        attach:    { type: sql.NVarChar(sql.MAX), value: attachment_urls ? JSON.stringify(attachment_urls) : null },
        createdBy: { type: sql.UniqueIdentifier,  value: userId },
      }
    );

    await audit({ req, action: 'CREATE', tableName: 'notices', recordId: r.recordset[0].id });
    return created(res, { id: r.recordset[0].id }, 'Notice created');
  } catch (err) { next(err); }
};

// ── PUT /api/notices/:id ──────────────────────────────────────────────────
exports.update = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    const { title, body, category, audience, is_published, expires_at } = req.body;

    await query(
      `UPDATE notices SET
         title       = ISNULL(@title, title),
         body        = ISNULL(@body,  body),
         category    = ISNULL(@cat,   category),
         audience    = ISNULL(@aud,   audience),
         is_published= ISNULL(@pub,   is_published),
         published_at= CASE WHEN @pub=1 AND is_published=0 THEN GETUTCDATE() ELSE published_at END,
         expires_at  = ISNULL(@exp,   expires_at),
         updated_at  = GETUTCDATE()
       WHERE id = @id AND school_id = @sid AND deleted_at IS NULL`,
      {
        id:    { type: sql.UniqueIdentifier, value: id },
        sid:   { type: sql.UniqueIdentifier, value: schoolId },
        title: { type: sql.NVarChar(sql.MAX), value: title ?? null },
        body:  { type: sql.NVarChar(sql.MAX), value: body  ?? null },
        cat:   { type: sql.VarChar(50),       value: category ?? null },
        aud:   { type: sql.VarChar(50),       value: audience ?? null },
        pub:   { type: sql.Bit,               value: is_published != null ? (is_published ? 1 : 0) : null },
        exp:   { type: sql.DateTime2,         value: expires_at ?? null },
      }
    );
    return success(res, null, 'Notice updated');
  } catch (err) { next(err); }
};

// ── DELETE /api/notices/:id ───────────────────────────────────────────────
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    await query(
      `UPDATE notices SET deleted_at = GETUTCDATE() WHERE id = @id AND school_id = @sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, null, 'Notice deleted');
  } catch (err) { next(err); }
};
