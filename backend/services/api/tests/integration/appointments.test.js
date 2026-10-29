const { setupDatabase, resetDatabase, teardownDatabase, createUser, login, as, futureSlot } = require('../helpers');
const Appointment = require('../../src/models/Appointment');
const Bill = require('../../src/models/Bill');

beforeAll(setupDatabase);
beforeEach(resetDatabase);
afterAll(teardownDatabase);

async function world() {
  const doctorUser = await createUser('doctor');
  const patientUser = await createUser('patient');
  return {
    doctorUser,
    patientUser,
    doctor: await login(doctorUser),
    patient: await login(patientUser),
    other: await login(await createUser('patient')),
  };
}

const book = (session, doctorId, startTime) => as(session).post('/api/appointments')
  .send({ doctorId: String(doctorId), startTime: startTime.toISOString(), reason: 'Chest pain on exertion' });

describe('appointments', () => {
  test('a patient books an offered slot; the doctor is notified', async () => {
    const { doctor, patient, doctorUser } = await world();
    const res = await book(patient, doctorUser._id, futureSlot());
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');

    const notes = await as(doctor).get('/api/notifications');
    expect(notes.body.data[0].title).toBe('New appointment request');
  });

  test('available-slots marks a booked slot as unavailable', async () => {
    const { patient, doctorUser } = await world();
    const slot = futureSlot();
    await book(patient, doctorUser._id, slot);
    const date = `${slot.getFullYear()}-${String(slot.getMonth() + 1).padStart(2, '0')}-${String(slot.getDate()).padStart(2, '0')}`;
    const res = await as(patient).get(`/api/doctors/${doctorUser._id}/available-slots?date=${date}`);
    expect(res.status).toBe(200);
    const match = res.body.data.slots.find((s) => new Date(s.start).getTime() === slot.getTime());
    expect(match.available).toBe(false);
  });

  test('the backend rejects double-booking, even when two requests race', async () => {
    const { patient, other, doctorUser } = await world();
    const slot = futureSlot();
    const results = await Promise.all([book(patient, doctorUser._id, slot), book(other, doctorUser._id, slot)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409).body.code).toBe('SLOT_TAKEN');
    expect(await Appointment.countDocuments({ holdsSlot: true })).toBe(1);
  });

  test('cancelling frees the slot for someone else', async () => {
    const { patient, other, doctorUser } = await world();
    const slot = futureSlot();
    const first = await book(patient, doctorUser._id, slot);
    expect((await as(patient).delete(`/api/appointments/${first.body.data._id}`).send({ reason: 'Travelling' })).status).toBe(200);
    expect((await book(other, doctorUser._id, slot)).status).toBe(201);
  });

  test('a time that is not one of the doctor\'s slots is rejected', async () => {
    const { patient, doctorUser } = await world();
    const odd = futureSlot();
    odd.setMinutes(odd.getMinutes() + 7);
    expect((await book(patient, doctorUser._id, odd)).status).toBe(400);
  });

  test('only the doctor confirms; status moves only along allowed transitions', async () => {
    const { doctor, patient, doctorUser } = await world();
    const created = await book(patient, doctorUser._id, futureSlot());
    const id = created.body.data._id;

    expect((await as(patient).patch(`/api/appointments/${id}`).send({ status: 'confirmed' })).status).toBe(403);
    expect((await as(doctor).patch(`/api/appointments/${id}`).send({ status: 'completed' })).status).toBe(409);
    expect((await as(doctor).patch(`/api/appointments/${id}`).send({ status: 'confirmed' })).status).toBe(200);
  });

  test('completing a past appointment raises a bill for the consultation fee', async () => {
    const { doctor, patient, doctorUser, patientUser } = await world();
    const past = await Appointment.create({
      patientId: patientUser._id, doctorId: doctorUser._id, startTime: new Date(Date.now() - 3600000),
      endTime: new Date(Date.now() - 1800000), status: 'confirmed', reason: 'Review',
    });
    const res = await as(doctor).patch(`/api/appointments/${past._id}`).send({ status: 'completed', notes: 'BP controlled' });
    expect(res.status).toBe(200);

    const bill = await Bill.findOne({ appointmentId: past._id });
    expect(bill).toMatchObject({ amount: 800, status: 'unpaid' });
    const bills = await as(patient).get('/api/bills');
    expect(bills.body.data).toHaveLength(1);
  });

  test('patients only see their own appointments; strangers get 404', async () => {
    const { patient, other, doctorUser } = await world();
    const created = await book(patient, doctorUser._id, futureSlot());
    expect((await as(other).get('/api/appointments')).body.data).toHaveLength(0);
    expect((await as(other).get(`/api/appointments/${created.body.data._id}`)).status).toBe(404);
  });

  test('a pending (unverified) doctor cannot be booked', async () => {
    const { patient } = await world();
    const pendingDoc = await createUser('doctor', { approvalStatus: 'pending' });
    expect((await book(patient, pendingDoc._id, futureSlot())).status).toBe(404);
  });
});
