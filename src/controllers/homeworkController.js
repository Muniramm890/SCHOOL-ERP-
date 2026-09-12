// src/controllers/homeworkController.js  
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');
const { uploadBufferToAzure, deleteBlobFromAzure } = require('../services/uploadService');
const { v4: uuidv4 } = require('uuid');

// ── POST /api/homework ─────────────────────────────────────────────────
// body: title, description, given_date, due_date, targets = '[{"section_id":"..","subject_id":".."}, ...]'
// files: req.files (multer array)
exports.create = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { title, description, given_date, due_date } = req.body;
    let targets = req.body.targets;
    if (typeof targets === 'string') targets = JSON.parse(targets);

    if (!title || !targets || !Array.isArray(targets) || targets.length === 0) {
      return badRequest(res, 'Title and at least one class/subject target are required.');
    }

    const homeworkId = uuidv4();
    const now = new Date();

    await query(
      `INSERT INTO homework (id, school_id, teacher_id, title, description, given_date, due_date, is_visible, created_at)
       VALUES (@id, @sid, @teacherId, @title, @desc, @given, @due, 1, @now)`,
      {
        id:        { type: sql.UniqueIdentifier, value: homeworkId },
        sid:       { type: sql.UniqueIdentifier, value: schoolId },
        teacherId: { type: sql.UniqueIdentifier, value: userId },
        title:     { type: sql.NVarChar(255),    value: title },
        desc:      { type: sql.NVarChar(sql.MAX),value: description || null },
        given:     { type: sql.Date,             value: given_date || now },
        due:       { type: sql.Date,             value: due_date || null },
        now:       { type: sql.DateTime2,        value: now },
      }
    );

    // Insert all class/subject targets
    for (const t of targets) {
      await query(
        `INSERT INTO homework_targets (id, homework_id, school_id, section_id, subject_id, created_at)
         VALUES (@id, @hwId, @sid, @secId, @subId, @now)`,
        {
          id:    { type: sql.UniqueIdentifier, value: uuidv4() },
          hwId:  { type: sql.UniqueIdentifier, value: homeworkId },
          sid:   { type: sql.UniqueIdentifier, value: schoolId },
          secId: { type: sql.UniqueIdentifier, value: t.section_id },
          subId: { type: sql.UniqueIdentifier, value: t.subject_id || null },
          now:   { type: sql.DateTime2, value: now },
        }
      );
    }

    // Upload files to Azure Blob and register attachments
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const ext = '.' + file.originalname.split('.').pop().toLowerCase();
        const uploadResult = await uploadBufferToAzure(file.buffer, file.originalname, ext);

        await query(
          `INSERT INTO homework_attachments (id, homework_id, school_id, file_name, file_url, blob_path, file_type, file_size_bytes, uploaded_at)
           VALUES (@id, @hwId, @sid, @fname, @url, @path, @ftype, @fsize, @now)`,
          {
            id:    { type: sql.UniqueIdentifier, value: uuidv4() },
            hwId:  { type: sql.UniqueIdentifier, value: homeworkId },
            sid:   { type: sql.UniqueIdentifier, value: schoolId },
            fname: { type: sql.NVarChar(255), value: file.originalname },
            url:   { type: sql.NVarChar(1000), value: uploadResult.secure_url },
            path:  { type: sql.NVarChar(500), value: uploadResult.public_id },
            ftype: { type: sql.NVarChar(50), value: ext },
            fsize: { type: sql.BigInt, value: file.size },
            now:   { type: sql.DateTime2, value: now },
          }
        );
      }
    }

    return created(res, { homework_id: homeworkId }, 'Homework created and assigned successfully');
  } catch (err) { next(err); }
};

// ── GET /api/homework?section_id=&subject_id= ──────────────────────────
exports.list = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, subject_id } = req.query;

    let where = `h.school_id = @sid AND h.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };
    if (section_id) { where += ` AND ht.section_id = @secId`; params.secId = { type: sql.UniqueIdentifier, value: section_id }; }
    if (subject_id) { where += ` AND ht.subject_id = @subId`; params.subId = { type: sql.UniqueIdentifier, value: subject_id }; }

    const rows = await query(
      `SELECT DISTINCT h.id, h.title, h.description, h.given_date, h.due_date, h.is_visible, h.created_at,
              u.full_name AS teacher_name
       FROM homework h
       JOIN homework_targets ht ON ht.homework_id = h.id
       JOIN users u ON u.id = h.teacher_id
       WHERE ${where}
       ORDER BY h.created_at DESC`,
      params
    );

    // Attach targets + attachments for each homework
    const list = rows.recordset;
    for (const hw of list) {
      const t = await query(
        `SELECT ht.section_id, sc.name AS section_name, g.name AS class_name, ht.subject_id, sub.name AS subject_name
         FROM homework_targets ht
         JOIN sections sc ON sc.id = ht.section_id
         JOIN grades g ON g.id = sc.grade_id
         LEFT JOIN subjects sub ON sub.id = ht.subject_id
         WHERE ht.homework_id = @id`,
        { id: { type: sql.UniqueIdentifier, value: hw.id } }
      );
      hw.targets = t.recordset;

      const a = await query(
        `SELECT id, file_name, file_url, file_type FROM homework_attachments WHERE homework_id = @id`,
        { id: { type: sql.UniqueIdentifier, value: hw.id } }
      );
      hw.attachments = a.recordset;
    }

    return success(res, list);
  } catch (err) { next(err); }
};

// ── PATCH /api/homework/:id/visibility ─────────────────────────────────
exports.toggleVisibility = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    const { is_visible } = req.body; // true/false

    await query(
      `UPDATE homework SET is_visible = @vis, updated_at = @now WHERE id = @id AND school_id = @sid`,
      {
        id:  { type: sql.UniqueIdentifier, value: id },
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        vis: { type: sql.Bit, value: is_visible ? 1 : 0 },
        now: { type: sql.DateTime2, value: new Date() },
      }
    );
    return success(res, null, `Homework ${is_visible ? 'shown' : 'hidden'} successfully`);
  } catch (err) { next(err); }
};

// ── DELETE /api/homework/:id ────────────────────────────────────────────
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;

    // Best-effort blob cleanup
    const attachments = await query(
      `SELECT blob_path FROM homework_attachments WHERE homework_id = @id AND school_id = @sid`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    for (const a of attachments.recordset) {
      await deleteBlobFromAzure(a.blob_path);
    }

    await query(
      `UPDATE homework SET deleted_at = @now WHERE id = @id AND school_id = @sid`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId }, now: { type: sql.DateTime2, value: new Date() } }
    );

    return success(res, null, 'Homework deleted permanently');
  } catch (err) { next(err); }
};
