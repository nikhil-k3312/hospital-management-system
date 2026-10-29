const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const multer = require('multer');
const { Readable } = require('stream');
const MedicalRecord = require('../../models/MedicalRecord');
const User = require('../../models/User');
const config = require('../../config/config');
const { getBucket } = require('../../db/mongo');
const { authenticate, requireRole } = require('../../middleware/auth');
const { validate, objectId, Joi } = require('../../middleware/validate');
const { asyncHandler, notFound, forbidden, badRequest } = require('../../utils/errors');
const ledgerService = require('../../services/ledgerService');
const consentService = require('../../services/consentService');
const notificationService = require('../../services/notificationService');

const router = express.Router();
router.use(authenticate);

// Medical data is high-sensitivity: it needs the higher trust bar, and doctors
// or admins may override consent in an emergency (break-glass, audited).
const readPolicy = requireRole('patient', 'doctor', {
  minTrustScore: config.security.highSensitivityTrustScore, allowBreakGlass: true,
});
const writePolicy = requireRole('patient', 'doctor', { minTrustScore: config.security.highSensitivityTrustScore });

const ALLOWED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.files.maxBytes, files: 1 },
  fileFilter: (req, file, cb) => (ALLOWED_TYPES.includes(file.mimetype)
    ? cb(null, true)
    : cb(badRequest('Only PDF, PNG, JPEG and plain-text files are accepted'))),
});

const populate = (q) => q.populate('doctorId', 'fullName doctorProfile.specialization').populate('patientId', 'fullName email');

async function loadRecordWithAccess(req) {
  const record = await MedicalRecord.findById(req.params.id);
  if (!record) throw notFound('Record not found');
  await consentService.assertCanAccessPatient(req, record.patientId);
  return record;
}

/**
 * POST /api/records
 *   doctor:  creates a clinical record for a patient who granted them access
 *   patient: uploads their own document entry (type "patient_upload")
 * The content hash goes into the ledger as a CREATE entry.
 */
router.post('/', writePolicy,
  validate({ body: Joi.object({
    patientId: objectId(),
    recordType: Joi.string().valid(...MedicalRecord.RECORD_TYPES).required(),
    title: Joi.string().trim().min(3).max(200).required(),
    description: Joi.string().trim().max(5000).allow('').default(''),
    diagnosis: Joi.string().trim().max(1000).allow('').default(''),
    findings: Joi.string().trim().max(5000).allow('').default(''),
    appointmentId: objectId(),
  }) }),
  asyncHandler(async (req, res) => {
    const { role, userId } = req.user;
    let patientId = req.body.patientId;

    if (role === 'patient') {
      patientId = userId;
      if (req.body.recordType !== 'patient_upload') throw forbidden('Patients can only add their own uploaded documents');
    } else {
      if (!patientId) throw badRequest('patientId is required');
      if (req.body.recordType === 'patient_upload') throw badRequest('Choose a clinical record type');
      await consentService.assertCanAccessPatient(req, patientId, { purpose: 'create record' });
    }

    const record = await MedicalRecord.create({
      ...req.body,
      patientId,
      doctorId: role === 'doctor' ? userId : null,
    });
    const entry = await ledgerService.recordEvent({ entityType: 'record', entity: record, action: 'CREATE', actor: req.user });
    record.ledgerEntryId = entry._id.toString();
    await record.save();

    if (role === 'doctor') {
      await notificationService.notify(patientId, {
        type: 'info', title: 'New medical record', message: `A new ${record.recordType.replace('_', ' ')} was added: "${record.title}"`, page: 'records',
      });
    }
    res.status(201).json({ success: true, message: 'Record created and anchored in the ledger', data: await populate(MedicalRecord.findById(record._id)) });
  }));

/** GET /api/records?patientId=: a patient sees their own; a doctor needs consent (or break-glass). */
router.get('/', readPolicy,
  validate({ query: Joi.object({ patientId: objectId(), recordType: Joi.string().valid(...MedicalRecord.RECORD_TYPES) }) }),
  asyncHandler(async (req, res) => {
    const patientId = req.user.role === 'patient' ? req.user.userId : req.query.patientId;
    if (!patientId) throw badRequest('patientId is required');
    const access = await consentService.assertCanAccessPatient(req, patientId);

    const filter = { patientId };
    if (req.query.recordType) filter.recordType = req.query.recordType;
    const records = await populate(MedicalRecord.find(filter).sort({ createdAt: -1 }));
    res.json({ success: true, data: records, meta: { accessVia: access.via } });
  }));

router.get('/:id', readPolicy, validate({ params: Joi.object({ id: objectId().required() }) }), asyncHandler(async (req, res) => {
  const record = await loadRecordWithAccess(req);
  res.json({ success: true, data: await populate(MedicalRecord.findById(record._id)) });
}));

/** PATCH /api/records/:id: only the authoring doctor may amend; the version goes up and a new UPDATE entry is chained. */
router.patch('/:id', requireRole('doctor', { minTrustScore: config.security.highSensitivityTrustScore }),
  validate({
    params: Joi.object({ id: objectId().required() }),
    body: Joi.object({
      title: Joi.string().trim().min(3).max(200),
      description: Joi.string().trim().max(5000).allow(''),
      diagnosis: Joi.string().trim().max(1000).allow(''),
      findings: Joi.string().trim().max(5000).allow(''),
    }).min(1),
  }),
  asyncHandler(async (req, res) => {
    const record = await loadRecordWithAccess(req);
    if (!record.doctorId || record.doctorId.toString() !== req.user.userId) {
      throw forbidden('Only the doctor who wrote this record can amend it');
    }
    Object.assign(record, req.body);
    record.version += 1;
    const entry = await ledgerService.recordEvent({
      entityType: 'record', entity: record, action: 'UPDATE', actor: req.user, meta: { version: record.version },
    });
    record.ledgerEntryId = entry._id.toString();
    await record.save();
    res.json({ success: true, message: `Record amended (version ${record.version})`, data: await populate(MedicalRecord.findById(record._id)) });
  }));

/** GET /api/records/:id/ledger-history: the record's audit trail. */
router.get('/:id/ledger-history', readPolicy, validate({ params: Joi.object({ id: objectId().required() }) }), asyncHandler(async (req, res) => {
  const record = await loadRecordWithAccess(req);
  const entries = await ledgerService.history('record', record._id);
  const actorIds = [...new Set(entries.map((e) => e.actorId).filter(Boolean))];
  const actors = await User.find({ _id: { $in: actorIds } }).select('fullName role').lean();
  const names = new Map(actors.map((a) => [a._id.toString(), a.fullName]));
  res.json({ success: true, data: entries.map((e) => ({ ...e, actorName: names.get(e.actorId) || null })) });
}));

/**
 * GET /api/records/:id/verify: tamper check for one record.
 *   1. the record's current content hash must equal the ledger's last payloadHash
 *   2. every attached file's bytes must still hash to the SHA-256 in the ledger
 */
router.get('/:id/verify', readPolicy, validate({ params: Joi.object({ id: objectId().required() }) }), asyncHandler(async (req, res) => {
  const record = await loadRecordWithAccess(req);
  const content = await ledgerService.verifyEntity('record', record);

  const files = [];
  for (const attachment of record.attachments) {
    const hash = crypto.createHash('sha256');
    try {
      await new Promise((resolve, reject) => {
        getBucket().openDownloadStream(new mongoose.Types.ObjectId(attachment.fileId))
          .on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
      });
      const actual = hash.digest('hex');
      files.push({ fileId: attachment.fileId, filename: attachment.filename, matches: actual === attachment.sha256, expected: attachment.sha256, actual });
    } catch (error) {
      files.push({ fileId: attachment.fileId, filename: attachment.filename, matches: false, error: 'file_missing' });
    }
  }
  const intact = content.matches && files.every((f) => f.matches);
  res.json({ success: true, data: { recordId: record._id, intact, content, files } });
}));

/**
 * POST /api/records/:id/files: upload an attachment (multipart field "file").
 * The bytes go to GridFS; their SHA-256 goes into the record and the ledger
 * (where the original design put the IPFS hash).
 */
router.post('/:id/files', writePolicy, validate({ params: Joi.object({ id: objectId().required() }) }),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Attach a file in the "file" field');
    const record = await loadRecordWithAccess(req);
    if (req.user.role === 'patient' && record.recordType !== 'patient_upload') {
      throw forbidden('Patients can attach files only to their own uploads');
    }

    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const fileId = await new Promise((resolve, reject) => {
      const stream = getBucket().openUploadStream(req.file.originalname, {
        metadata: { recordId: record._id.toString(), patientId: record.patientId.toString(), sha256, contentType: req.file.mimetype, uploadedBy: req.user.userId },
      });
      Readable.from(req.file.buffer).pipe(stream).on('error', reject).on('finish', () => resolve(stream.id.toString()));
    });

    record.attachments.push({
      fileId, filename: req.file.originalname, contentType: req.file.mimetype, size: req.file.size, sha256, uploadedBy: req.user.userId,
    });
    await ledgerService.append({
      chain: 'records', entityType: 'file', entityId: fileId, action: 'FILE_ATTACHED',
      actorId: req.user.userId, actorRole: req.user.role, payloadHash: sha256,
      meta: { recordId: record._id.toString(), filename: req.file.originalname, size: req.file.size },
    });
    // The record's own content (its attachment list) changed too, so chain a new version.
    record.version += 1;
    const entry = await ledgerService.recordEvent({ entityType: 'record', entity: record, action: 'UPDATE', actor: req.user, meta: { attached: fileId } });
    record.ledgerEntryId = entry._id.toString();
    await record.save();

    res.status(201).json({ success: true, message: 'File stored and its SHA-256 recorded in the ledger', data: { fileId, sha256, record } });
  }));

module.exports = router;
