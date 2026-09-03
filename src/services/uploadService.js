//src/services/uploadService.js
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const safeName = (name) =>
  (name || 'unnamed')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();

// buffer -> upload -> returns secure_url
function uploadImageBuffer(buffer, { schoolName, subfolder, fileName }) {
  return new Promise((resolve, reject) => {
    const folderPath = `${safeName(schoolName)}/${subfolder}`;
    const publicId = safeName(fileName) + '_' + Date.now(); // timestamp avoids overwrite collisions
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'image', folder: folderPath, public_id: publicId, overwrite: true },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

function uploadRawBuffer(buffer, { schoolName, subfolder, fileName, ext }) {
  return new Promise((resolve, reject) => {
    const folderPath = `${safeName(schoolName)}/${subfolder}`;
    const publicId = `${safeName(fileName)}.${ext}`;
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', folder: folderPath, public_id: publicId, overwrite: true },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

module.exports = { uploadImageBuffer, uploadRawBuffer, safeName };
