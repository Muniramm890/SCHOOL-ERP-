//src/services/uploadService.js
const cloudinary = require('cloudinary').v2;
const { BlobServiceClient } = require('@azure/storage-blob');

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

const { generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');

const connectionString = process.env.uploadhomework_string;
const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);

// ── Container registry — one BlobServiceClient, multiple logical containers ──
const CONTAINERS = {
  homework: 'homeworksschooloffice',
  payslips: 'payslipsschooloffice', // 🔴 create this container in Azure Portal first (Private access)
};
const getContainerClient = (containerKey) => blobServiceClient.getContainerClient(CONTAINERS[containerKey]);

// Backward-compatible: existing homework code keeps working unchanged
const containerClient = getContainerClient('homework');
const containerName = CONTAINERS.homework;

const uploadBufferToAzure = async (buffer, originalname, ext) => {
  try {
    const folderPath = `homework/${Date.now()}_${safeName(originalname)}${ext}`;
    const blockBlobClient = containerClient.getBlockBlobClient(folderPath);
    await blockBlobClient.upload(buffer, buffer.length);
    return { secure_url: blockBlobClient.url, public_id: folderPath };
  } catch (error) {
    throw new Error(`Azure Upload Failed: ${error.message}`);
  }
};

// 🔴 NEW: SaaS-organized payslip PDF upload — payslips/{schoolId}/{monthYear}/{staffId}_{timestamp}.pdf
const uploadPayslipPdf = async (buffer, { schoolId, monthYear, staffId }) => {
  try {
    const client = getContainerClient('payslips');
    const blobPath = `payslips/${schoolId}/${monthYear}/${staffId}_${Date.now()}.pdf`;
    const blockBlobClient = client.getBlockBlobClient(blobPath);
    await blockBlobClient.upload(buffer, buffer.length, {
      blobHTTPHeaders: { blobContentType: 'application/pdf', blobContentDisposition: 'inline' },
    });
    return { secure_url: blockBlobClient.url, public_id: blobPath };
  } catch (error) {
    throw new Error(`Azure Payslip Upload Failed: ${error.message}`);
  }
};

// Delete a blob from any container when a document is removed/regenerated
const deleteBlobFromAzure = async (blobPath, containerKey = 'homework') => {
  try {
    const client = getContainerClient(containerKey);
    const blockBlobClient = client.getBlockBlobClient(blobPath);
    await blockBlobClient.deleteIfExists();
  } catch (error) {
    console.error('Azure Delete Failed:', error.message);
  }
};

// Generate a short-lived signed URL — now works across containers
const getSignedDownloadUrl = (blobPath, expiryMinutes = 60, containerKey = 'homework') => {
  try {
    const targetContainerName = CONTAINERS[containerKey];
    const client = getContainerClient(containerKey);
    const accountName = blobServiceClient.accountName;
    const accountKey = process.env.AZURE_STORAGE_KEY;
    if (!accountKey) return client.getBlockBlobClient(blobPath).url;

    const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
    const sasToken = generateBlobSASQueryParameters({
      containerName: targetContainerName,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(Date.now() + expiryMinutes * 60 * 1000),
    }, sharedKeyCredential).toString();

    return `${client.getBlockBlobClient(blobPath).url}?${sasToken}`;
  } catch (error) {
    console.error('SAS Generation Failed:', error.message);
    return getContainerClient(containerKey).getBlockBlobClient(blobPath).url;
  }
};

module.exports = { uploadImageBuffer, uploadBufferToAzure, uploadRawBuffer, uploadPayslipPdf, safeName, deleteBlobFromAzure, getSignedDownloadUrl };