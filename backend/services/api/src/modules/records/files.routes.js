const express = require('express');
const mongoose = require('mongoose');
const MedicalRecord = require('../../models/MedicalRecord');
const config = require('../../config/config');
const { getBucket } = require('../../db/mongo');
const { authenticate, requireRole } = require('../../middleware/auth');
const { validate, objectId, Joi } = require('../../middleware/validate');
const { asyncHandler, notFound } = require('../../utils/errors');
const consentService = require('../../services/consentService');

const router = express.Router();

/**
 * GET /api/files/:fileId: streams an attachment. Gated by exactly the same
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
    getBucket().openDownloadStream(new mongoose.Types.ObjectId(req.params.fileId))
      .on('error', () => { if (!res.headersSent) res.status(404).end(); else res.end(); })
      .pipe(res);
  }));

module.exports = router;
