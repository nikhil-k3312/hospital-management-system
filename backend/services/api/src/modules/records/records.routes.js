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
const ipfsService = require('../../services/ipfsService');
const blockchainService = require('../../services/blockchainService');
const { hashObject } = require('../../utils/hash');

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

/** Anchors the record's current version on the blockchain: its content hash only, never its content. */
async function anchorRecord(record) {
  const result = await blockchainService.anchor({
    entityType: 'record', entityId: record._id.toString(), version: record.version,
    dataHash: hashObject(record.ledgerPayload()), patientId: record.patientId.toString(),
  });
  record.chain = { status: result.status, key: result.key, txHash: result.txHash || null, blockNumber: result.blockNumber || null, version: record.version };
}

const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

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
    await anchorRecord(record);
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
    await anchorRecord(record);
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
 *   2. the same hash must be anchored on the blockchain for the current version
 *   3. every attached file must still hash to its recorded SHA-256 (IPFS files are
 *      downloaded and decrypted first), and that SHA-256 must be on the blockchain
 */
router.get('/:id/verify', readPolicy, validate({ params: Joi.object({ id: objectId().required() }) }), asyncHandler(async (req, res) => {
  const record = await loadRecordWithAccess(req);
  const content = await ledgerService.verifyEntity('record', record);
  const chain = await blockchainService.verify({
    entityType: 'record', entityId: record._id.toString(), version: record.version, dataHash: hashObject(record.ledgerPayload()),
  });

  const files = [];
  for (const attachment of record.attachments) {
    const base = { fileId: attachment.fileId, filename: attachment.filename, storage: attachment.storage, expected: attachment.sha256 };
    let actual;
    try {
      if (attachment.storage === 'ipfs') {
        actual = sha256Of(await ipfsService.fetchFile(attachment.cid));
      } else {
        const hash = crypto.createHash('sha256');
        await new Promise((resolve, reject) => {
          getBucket().openDownloadStream(new mongoose.Types.ObjectId(attachment.fileId))
            .on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
        });
        actual = hash.digest('hex');
      }
    } catch (error) {
      files.push({ ...base, matches: false, error: error.message === 'IPFS_UNAVAILABLE' ? 'storage_unreachable' : 'file_missing_or_altered' });
      continue;
    }
    const fileChain = await blockchainService.verify({ entityType: 'file', entityId: attachment.fileId, version: 1, dataHash: attachment.sha256 });
    files.push({ ...base, actual, matches: actual === attachment.sha256 && (!fileChain.checked || fileChain.matches), chain: fileChain });
  }
  const intact = content.matches && (!chain.checked || chain.matches) && files.every((f) => f.matches);
  res.json({ success: true, data: { recordId: record._id, intact, content, chain, files } });
}));

/**
 * POST /api/records/:id/files: upload an attachment (multipart field "file").
 * With IPFS configured the bytes are encrypted and stored on IPFS (only the CID is
 * kept in MongoDB); otherwise they go to GridFS. Either way the plaintext SHA-256
 * goes into the record, the ledger and the blockchain.
 */
router.post('/:id/files', writePolicy, validate({ params: Joi.object({ id: objectId().required() }) }),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Attach a file in the "file" field');
    const record = await loadRecordWithAccess(req);
    if (req.user.role === 'patient' && record.recordType !== 'patient_upload') {
      throw forbidden('Patients can attach files only to their own uploads');
    }

    const sha256 = sha256Of(req.file.buffer);
    let fileId;
    let cid = null;
    let storage = 'gridfs';
    if (ipfsService.enabled) {
      const stored = await ipfsService.storeFile(req.file.buffer);
      fileId = new mongoose.Types.ObjectId().toString();
      cid = stored.cid;
      storage = 'ipfs';
    } else {
      fileId = await new Promise((resolve, reject) => {
        const stream = getBucket().openUploadStream(req.file.originalname, {
          metadata: { recordId: record._id.toString(), patientId: record.patientId.toString(), sha256, contentType: req.file.mimetype, uploadedBy: req.user.userId },
        });
        Readable.from(req.file.buffer).pipe(stream).on('error', reject).on('finish', () => resolve(stream.id.toString()));
      });
    }

    const fileAnchor = await blockchainService.anchor({
      entityType: 'file', entityId: fileId, version: 1, dataHash: sha256, patientId: record.patientId.toString(),
    });
    record.attachments.push({
      fileId, storage, cid, filename: req.file.originalname, contentType: req.file.mimetype, size: req.file.size, sha256, uploadedBy: req.user.userId,
      chain: { status: fileAnchor.status, key: fileAnchor.key, txHash: fileAnchor.txHash || null, blockNumber: fileAnchor.blockNumber || null, version: 1 },
    });
    await ledgerService.append({
      chain: 'records', entityType: 'file', entityId: fileId, action: 'FILE_ATTACHED',
      actorId: req.user.userId, actorRole: req.user.role, payloadHash: sha256,
      meta: { recordId: record._id.toString(), filename: req.file.originalname, size: req.file.size, storage },
    });
    // The record's own content (its attachment list) changed too, so chain and anchor a new version.
    record.version += 1;
    const entry = await ledgerService.recordEvent({ entityType: 'record', entity: record, action: 'UPDATE', actor: req.user, meta: { attached: fileId } });
    record.ledgerEntryId = entry._id.toString();
    await anchorRecord(record);
    await record.save();

    res.status(201).json({
      success: true,
      message: storage === 'ipfs' ? 'File encrypted, stored on IPFS and its hash anchored on the blockchain' : 'File stored and its SHA-256 recorded in the ledger',
      data: { fileId, sha256, cid, storage, chain: fileAnchor.status, record },
    });
  }));

module.exports = router;
