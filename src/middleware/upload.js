const multer = require('multer');

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 10 }, // 15MB per file, max 10 files (homework/payslips — unchanged)
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.jpg', '.jpeg', '.png'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('File type not allowed: ' + ext));
    cb(null, true);
  },
});

// 🔴 Communication Hub — video bhi allowed, bada size limit (max 3 files ek message pe)
const uploadCommAttachment = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 3 }, // 50MB per file, max 3 files
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.jpg', '.jpeg', '.png', '.mp4', '.mov', '.webm'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('File type not allowed: ' + ext));
    cb(null, true);
  },
});

module.exports = upload;
module.exports.uploadCommAttachment = uploadCommAttachment;
