const crypto = require('crypto');
const { setupDatabase, resetDatabase, teardownDatabase, createUser, login, as } = require('../helpers');
const MedicalRecord = require('../../src/models/MedicalRecord');
const AccessGrant = require('../../src/models/AccessGrant');
const LedgerEntry = require('../../src/models/LedgerEntry');

beforeAll(setupDatabase);
beforeEach(resetDatabase);
afterAll(teardownDatabase);

async function world() {
  const doctorUser = await createUser('doctor');
  const patientUser = await createUser('patient');
  return {
    doctorUser, patientUser,
    doctor: await login(doctorUser),
    patient: await login(patientUser),
    admin: await login(await createUser('admin')),
  };
}

const newRecord = (session, patientId) => as(session).post('/api/records').send({
  patientId: String(patientId), recordType: 'diagnosis', title: 'Stage 1 hypertension', diagnosis: 'I10 Essential hypertension', description: 'BP 148/94 on two visits',
});

async function grantAccess({ doctor, patient, patientUser }) {
  const req = await as(doctor).post('/api/consents/request').send({ patientId: String(patientUser._id), purpose: 'Follow-up of blood pressure' });
  expect(req.status).toBe(201);
  const approve = await as(patient).post(`/api/consents/${req.body.data._id}/approve`).send({ durationDays: 7 });
  expect(approve.status).toBe(200);
  return req.body.data._id;
}

describe('consent-gated medical records', () => {
  test('a doctor without consent gets 403, not just a hidden button', async () => {
    const w = await world();
    const res = await as(w.doctor).get(`/api/records?patientId=${w.patientUser._id}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CONSENT_REQUIRED');
    expect((await newRecord(w.doctor, w.patientUser._id)).status).toBe(403);
  });

  test('request -> patient approves -> doctor can write and read; patient sees it too', async () => {
    const w = await world();
    await grantAccess(w);
    const created = await newRecord(w.doctor, w.patientUser._id);
    expect(created.status).toBe(201);

    expect((await as(w.doctor).get(`/api/records?patientId=${w.patientUser._id}`)).body.data).toHaveLength(1);
    expect((await as(w.patient).get('/api/records')).body.data).toHaveLength(1);
  });

  test('revoking consent takes effect on the doctor\'s next request', async () => {
    const w = await world();
    const grantId = await grantAccess(w);
    expect((await as(w.doctor).get(`/api/records?patientId=${w.patientUser._id}`)).status).toBe(200);
    expect((await as(w.patient).post(`/api/consents/${grantId}/revoke`)).status).toBe(200);
    expect((await as(w.doctor).get(`/api/records?patientId=${w.patientUser._id}`)).status).toBe(403);
  });

  test('expired consent no longer grants access', async () => {
    const w = await world();
    const grantId = await grantAccess(w);
    await AccessGrant.updateOne({ _id: grantId }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await as(w.doctor).get(`/api/records?patientId=${w.patientUser._id}`)).status).toBe(403);
    const consents = await as(w.patient).get('/api/consents');
    expect(consents.body.data[0].status).toBe('expired');
  });

  test('a patient can grant access proactively and cannot read another patient', async () => {
    const w = await world();
    expect((await as(w.patient).post('/api/consents/grant').send({ doctorId: String(w.doctorUser._id), durationDays: 3 })).status).toBe(201);
    expect((await as(w.doctor).get(`/api/records?patientId=${w.patientUser._id}`)).status).toBe(200);

    const stranger = await createUser('patient');
    expect((await as(w.patient).get(`/api/records?patientId=${stranger._id}`)).body.data).toEqual([]);
  });

  test('break-glass lets a doctor in without consent, and it is audited and announced', async () => {
    const w = await world();
    const res = await as(w.doctor).get(`/api/records?patientId=${w.patientUser._id}`)
      .set('x-break-glass-reason', 'Patient unconscious in ER, need allergy history');
    expect(res.status).toBe(200);
    expect(res.body.meta.accessVia).toBe('break_glass');

    expect(await LedgerEntry.countDocuments({ chain: 'records', action: 'BREAK_GLASS_ACCESS' })).toBe(1);
    expect(await LedgerEntry.countDocuments({ chain: 'access', 'meta.reason': 'break_glass_allowed' })).toBe(1);
    const notes = await as(w.patient).get('/api/notifications');
    expect(notes.body.data.some((n) => n.title === 'Emergency access to your records')).toBe(true);
  });

  test('patients cannot use break-glass, and a too-short reason is not enough', async () => {
    const w = await world();
    const other = await createUser('patient');
    expect((await as(w.patient).get(`/api/records?patientId=${other._id}`).set('x-break-glass-reason', 'Please let me see this')).body.data).toEqual([]);
    expect((await as(w.doctor).get(`/api/records?patientId=${w.patientUser._id}`).set('x-break-glass-reason', 'urgent')).status).toBe(403);
  });
});

describe('ledger integrity', () => {
  test('records are chained; amendments add UPDATE entries to the record history', async () => {
    const w = await world();
    await grantAccess(w);
    const created = await newRecord(w.doctor, w.patientUser._id);
    const id = created.body.data._id;
    expect((await as(w.doctor).patch(`/api/records/${id}`).send({ diagnosis: 'I10 Essential hypertension, controlled' })).status).toBe(200);

    const history = await as(w.doctor).get(`/api/records/${id}/ledger-history`);
    expect(history.body.data.map((e) => e.action)).toEqual(['CREATE', 'UPDATE']);
    expect((await as(w.doctor).get(`/api/records/${id}/verify`)).body.data.intact).toBe(true);
  });

  test('editing a record directly in MongoDB (bypassing the API) is detected', async () => {
    const w = await world();
    await grantAccess(w);
    const created = await newRecord(w.doctor, w.patientUser._id);
    const id = created.body.data._id;

    await MedicalRecord.updateOne({ _id: id }, { $set: { diagnosis: 'Healthy, no hypertension' } });

    const verify = await as(w.doctor).get(`/api/records/${id}/verify`);
    expect(verify.body.data.intact).toBe(false);
    expect(verify.body.data.content.matches).toBe(false);

    const audit = await as(w.admin).get('/api/ledger/verify');
    expect(audit.body.data.valid).toBe(false);
    expect(audit.body.data.chains.every((c) => c.valid)).toBe(true); // the chain itself is intact
    const recordCheck = audit.body.data.entities.find((e) => e.entityType === 'record');
    expect(recordCheck.tampered.map((t) => t.entityId)).toEqual([id]);
  });

  test('a clean database verifies as valid', async () => {
    const w = await world();
    await grantAccess(w);
    await newRecord(w.doctor, w.patientUser._id);
    const audit = await as(w.admin).get('/api/ledger/verify');
    expect(audit.body.data.valid).toBe(true);
  });
});

describe('file attachments', () => {
  test('upload -> SHA-256 in the ledger -> consent-gated download with a matching hash', async () => {
    const w = await world();
    await grantAccess(w);
    const record = await newRecord(w.doctor, w.patientUser._id);
    const id = record.body.data._id;
    const content = Buffer.from('ECG report: sinus rhythm, rate 72 bpm');
    const expected = crypto.createHash('sha256').update(content).digest('hex');

    const up = await as(w.doctor).post(`/api/records/${id}/files`).attach('file', content, { filename: 'ecg.txt', contentType: 'text/plain' });
    expect(up.status).toBe(201);
    expect(up.body.data.sha256).toBe(expected);
    expect(await LedgerEntry.findOne({ action: 'FILE_ATTACHED' })).toMatchObject({ payloadHash: expected });

    const down = await as(w.patient).get(`/api/files/${up.body.data.fileId}`).buffer(true).parse((res, cb) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(down.status).toBe(200);
    expect(down.headers['x-content-sha256']).toBe(expected);
    expect(crypto.createHash('sha256').update(down.body).digest('hex')).toBe(expected);

    const verify = await as(w.patient).get(`/api/records/${id}/verify`);
    expect(verify.body.data.intact).toBe(true);
    expect(verify.body.data.files[0].matches).toBe(true);

    const stranger = await login(await createUser('doctor'));
    expect((await as(stranger).get(`/api/files/${up.body.data.fileId}`)).status).toBe(403);
  });

  test('rejects disallowed file types', async () => {
    const w = await world();
    const own = await as(w.patient).post('/api/records').send({ recordType: 'patient_upload', title: 'My lab PDF' });
    expect(own.status).toBe(201);
    const res = await as(w.patient).post(`/api/records/${own.body.data._id}/files`).attach('file', Buffer.from('MZ...'), { filename: 'virus.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(400);
  });
});
