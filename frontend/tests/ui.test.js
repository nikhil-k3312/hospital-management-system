/**
 * UI helpers: escaping, formatting, and the real loading / empty / error
 * states that every dashboard screen relies on.
 */
const { screen, fireEvent, waitFor } = require('@testing-library/dom');
const UI = require('../js/ui');

beforeEach(() => {
  document.body.innerHTML = '<div id="toast-notification"><i id="toast-icon"></i><span id="toast-message"></span></div><div id="root"></div>';
});

describe('esc', () => {
  test('neutralises HTML so data can never inject markup or scripts', () => {
    expect(UI.esc('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(UI.esc(null)).toBe('');
  });
});

describe('formatters', () => {
  test('money, titles, hashes and age', () => {
    expect(UI.fmtMoney(1250)).toBe('₹1,250');
    expect(UI.titleCase('under_review')).toBe('Under Review');
    expect(UI.shortHash('abcdef1234567890', 6)).toBe('abcdef…');
    const tenYearsAgo = new Date();
    tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);
    tenYearsAgo.setDate(tenYearsAgo.getDate() - 1);
    expect(UI.age(tenYearsAgo)).toBe(10);
    expect(UI.initials('Ananya Iyer')).toBe('AI');
  });

  test('status tags are colour-coded', () => {
    expect(UI.tag('settled')).toContain('tag-green');
    expect(UI.tag('under_review')).toContain('tag-yellow');
    expect(UI.tag('denied')).toContain('tag-red');
    expect(UI.tag('something')).toContain('tag-gray');
  });
});

describe('states', () => {
  test('loading state', () => {
    const root = document.getElementById('root');
    UI.loading(root, 'Fetching appointments…');
    expect(screen.getByRole('status').textContent).toContain('Fetching appointments…');
  });

  test('an empty table shows a real empty state, not placeholder rows', () => {
    document.getElementById('root').innerHTML = UI.table([{ label: 'Name', render: (r) => r.name }], [], 'No appointments');
    expect(screen.getByText('No appointments')).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
  });

  test('rows are rendered through the column renderers', () => {
    document.getElementById('root').innerHTML = UI.table([{ label: 'Name', render: (r) => UI.esc(r.name) }], [{ name: '<b>Arjun</b>' }]);
    expect(document.querySelector('td').textContent).toBe('<b>Arjun</b>');
  });

  test('the error state shows the server message and retries on click', () => {
    const retry = jest.fn();
    UI.errorState(document.getElementById('root'), { status: 503, message: 'Security service temporarily unavailable' }, retry);
    expect(screen.getByRole('alert').textContent).toContain('Security service temporarily unavailable');
    fireEvent.click(screen.getByText('Try again'));
    expect(retry).toHaveBeenCalled();
  });

  test('an unreachable server gets its own message', () => {
    UI.errorState(document.getElementById('root'), { status: 0, message: 'Cannot reach the MediChain server' });
    expect(screen.getByRole('alert').textContent).toContain('Server unreachable');
  });
});

describe('modal forms', () => {
  test('submits the form values and closes on success', async () => {
    const onSubmit = jest.fn().mockResolvedValue();
    UI.modal({ title: 'Book', body: '<input name="reason" value="Chest pain"><input type="number" name="days" value="7">', submitLabel: 'Save', onSubmit });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ reason: 'Chest pain', days: 7 }, expect.anything()));
    await waitFor(() => expect(document.getElementById('app-modal')).toBeNull());
  });

  test('keeps the dialog open and shows the API error when submission fails', async () => {
    UI.modal({ title: 'Book', body: '<input name="x" value="1">', submitLabel: 'Save', onSubmit: () => Promise.reject(new Error('This slot has just been booked')) });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.getByText('This slot has just been booked')).toBeTruthy());
    expect(document.getElementById('app-modal')).not.toBeNull();
  });

  test('formValues collects checkbox arrays and skips empty number fields', () => {
    document.getElementById('root').innerHTML = `<form id="f">
      <input type="checkbox" name="days" value="1" data-array checked><input type="checkbox" name="days" value="2" data-array>
      <input type="number" name="fee" value=""><input name="name" value="  Dr X  "></form>`;
    expect(UI.formValues(document.getElementById('f'))).toEqual({ days: ['1'], name: 'Dr X' });
  });
});

test('toast shows the message', () => {
  UI.toast('Appointment requested', 'success');
  expect(document.getElementById('toast-message').textContent).toBe('Appointment requested');
});
