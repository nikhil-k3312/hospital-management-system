const express = require('express');
const mongoose = require('mongoose');
const MedicalRecord = require('../../models/MedicalRecord');
const config = require('../../config/config');
const { getBucket } = require('../../db/mongo');
const { authenticate, requireRole } = require('../../middleware/auth');
const { validate, objectId, Joi } = require('../../middleware/validate');
const { asyncHandler, notFound } = require('../../utils/errors');
const consentService = require('../../services/consentService');
const ipfsService = require('../../services/ipfsService');

const router = express.Router();

/**
 * GET /api/files/:fileId: sends an attachment (from IPFS, decrypted, or from GridFS). Gated by exactly the same
 * consent check as the record it belongs to. The expected SHA-256 is sent in
 * a header so a client can verify the download itself.
 */
router.get('/:fileId', authenticate,
  requireRole('patient', 'doctor', { minTrustScore: config.security.highSensitivityTrustScore, allowBreakGlass: true }),
  validate({ params: Joi.object({ fileId: objectId().required() }) }),
  asyncHandler(async (req, res) => {
    const record = await MedicalRecord.findOne({ 'attachments.fileId': req.params.fileId });
    if (!record) throw notFound('File not found');
    await consentService.assertCanAccessPatient(req, record.patientId, { purpose: 'download file' });

    const attachment = record.attachments.find((a) => a.fileId === req.params.fileId);
    res.set({
      'Content-Type': attachment.contentType,
      'Content-Length': attachment.size,
      'Content-Disposition': `inline; filename="${attachment.filename.replace(/"/g, '')}"`,
      'X-Content-SHA256': attachment.sha256,
      'Cache-Control': 'private, no-store',
    });
    if (attachment.storage === 'ipfs') {
      // fetchFile decrypts and refuses bytes whose hash differs from the one recorded at upload.
      let bytes;
      try {
        bytes = await ipfsService.fetchFile(attachment.cid, attachment.sha256);
      } catch (error) {
        const altered = error.message === 'IPFS_HASH_MISMATCH' || /auth/i.test(error.message);
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Disposition');
        res.removeHeader('X-Content-SHA256');
        return res.status(altered ? 409 : 503).type('application/json').send(JSON.stringify({
          success: false,
          message: altered ? 'Stored file does not match its recorded hash' : 'File storage is unreachable',
          code: altered ? 'FILE_ALTERED' : 'STORAGE_UNAVAILABLE',
        }));
      }
      return res.end(bytes);
    }
    getBucket().openDownloadStream(new mongoose.Types.ObjectId(req.params.fileId))
      .on('error', () => { if (!res.headersSent) res.status(404).end(); else res.end(); })
      .pipe(res);
  }));

module.exports = router;
