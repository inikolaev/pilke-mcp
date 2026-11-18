import test from 'node:test';
import assert from 'node:assert/strict';
import { DaisyClient as RealDaisyClient, RequestRateLimiter, validDate, expandBookingRanges } from '../src/daisy.js';
import { finnishHolidayDates } from '../src/holidays.js';

// Most tests check API behavior, not elapsed time.
class DaisyClient extends RealDaisyClient {
  constructor(options) { super({ rateLimiter: { run: fn => fn() }, ...options }); }
}

const id = '00000000-0000-4000-8000-000000000001';
const fileId = '00000000-0000-4000-8000-000000000002';
function fixture() {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, ...options, body: options.body && JSON.parse(options.body) });
    const data = url.endsWith('/auth/login') ? { Token: 'secret-token' } :
      url.endsWith('/persons/getchildren/') ? { ListChildren: [] } :
      url.endsWith('/GetMessageList2/') ? { listMessage: [{ ThreadId: id }] } :
      url.endsWith('/GetMessageThread2') ? { listMessageModels: [{ ListAttachments: [{ Id: fileId, FileName: 'plan.txt', MimeType: 'text/plain' }] }] } :
      url.endsWith('/downloadFile') ? `data:text/plain;base64,${Buffer.from('Monday: trip').toString('base64')}` : { NursingTimeDays: [] };
    return { ok: true, text: async () => JSON.stringify(data) };
  };
  return { client: new DaisyClient({ username: 'name', password: 'password', fetcher }), requests };
}
test('authenticates and uses retrieval endpoints without changing read status', async () => {
  const { client, requests } = fixture();
  await client.listMessages();
  await client.getThread(id);
  await client.careTimes('2026-11-18', '2026-11-24');
  assert.deepEqual(requests.map(r => new URL(r.url).pathname), ['/api/auth/login', '/api/persons/getchildren/', '/api/Messages/GetMessageList2/', '/api/persons/getchildren/', '/api/Messages/GetMessageThread2', '/api/persons/getchildren/', '/api/nursingtimes/getnursingtimes2/11/2026-11-11/2026-11-24']);
  assert.equal(requests[1].headers.Authorization, 'Bearer secret-token');
  assert.equal(requests[4].body.ThreadId, id);
  assert.ok(requests.every(r => r.redirect === 'error'));
});
test('pads short ranges in one call, filters dates, and redacts diagnostic credentials', async () => {
  const paths = [];
  const fetcher = async (url, options) => {
    paths.push(new URL(url).pathname);
    if (url.endsWith('/auth/login')) return { ok: true, status: 200, text: async () => JSON.stringify({ Token: 'secret-token' }) };
    if (url.endsWith('/persons/getchildren/')) return { ok: true, status: 200, text: async () => JSON.stringify({ ListChildren: [] }) };
    const rejected = url.endsWith('/2026-11-16/2026-11-22');
    return { ok: !rejected, status: rejected ? 400 : 200, text: async () => rejected ? '{"title":"Bad Request"}' : JSON.stringify({ NursingTimeDays: [{ Date: '2026-11-15T00:00:00' }, { Date: '2026-11-16T00:00:00' }, { Date: '2026-11-22T00:00:00' }] }) };
  };
  const c = new DaisyClient({ username: 'private-user', password: 'private-password', fetcher });
  const trace = [];
  const result = await c.careTimes('2026-11-16', '2026-11-22', { trace });
  assert.deepEqual(result.days.map(d => d.Date.slice(0, 10)), ['2026-11-16', '2026-11-22']);
  assert.equal(paths.length, 3);
  assert.ok(paths[2].endsWith('/2026-11-09/2026-11-22'));
  assert.equal(trace[1].response.status, 200);
  for (const secret of ['private-user', 'private-password', 'secret-token']) assert.equal(JSON.stringify(trace).includes(secret), false);
});
test('does not pad a range of at least 14 days', async () => {
  const { client, requests } = fixture();
  await client.careTimes('2026-11-01', '2026-11-14');
  assert.ok(requests.at(-1).url.endsWith('/11/2026-11-01/2026-11-14'));
});
test('attachment must belong to requested thread', async () => {
  const { client, requests } = fixture();
  const attachment = await client.attachment(id, fileId);
  assert.equal(attachment.bytes.toString(), 'Monday: trip');
  await assert.rejects(client.attachment(id, '00000000-0000-4000-8000-000000000003'), /not found/);
  assert.equal(requests.filter(r => r.url.endsWith('/downloadFile')).length, 1);
});
test('validates dates and blocks mutation paths even if called directly', async () => {
  const { client, requests } = fixture();
  assert.equal(validDate('2026-02-29'), false);
  await assert.rejects(client.careTimes('2026-02-29', '2026-03-01'), /valid/);
  await assert.rejects(client.request('/messages/setthreadread/', { method: 'POST', body: {} }), /blocked/);
  assert.equal(requests.length, 0);
});

function bookingFixture({ existing = false, saveMode = 'success' } = {}) {
  let saved = false;
  const requests = [];
  const placementId = '00000000-0000-4000-8000-000000000010';
  const reservation = { PersonId: id, PlacementId: placementId, Start: '2099-04-13T09:00:00', End: '2099-04-13T16:00:00' };
  const fetcher = async (url, options) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    let data;
    if (url.endsWith('/auth/login')) data = { Token: 'secret-token' };
    else if (url.endsWith('/persons/getchildren/')) data = { ListChildren: [{ Id: id, FirstName: 'Example', LastName: 'Child', Placements: [{ Id: placementId, Start: '2099-01-01', End: null, OpenTimes: 'MON-FRI 07:00 - 17:00', IsOpenSaturday: false, IsOpenSunday: false }] }] };
    else if (url.includes('/getnursingtimes2/')) data = { NursingTimeDays: [{ Date: '2099-04-13T00:00:00', IsLockedDate: false, NotSelectable: false, WeekHoliday: null, OnVacation: false, NursingTimes: existing || saved ? [reservation] : [], Statuses: [], CareTimeTest: [{ ChildId: id }] }] };
    else if (url.endsWith('/savenursingtimes2/')) {
      if (saveMode === 'timeout') throw new Error('connection lost');
      saved = true;
      data = [null, { Code: 0, GroupedErrors: [], OvertimeDatas: [] }];
    } else throw new Error(`Unexpected URL ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  return { client: new DaisyClient({ username: 'name', password: 'password', fetcher }), requests };
}
const booking = { childName: 'Example', date: '2099-04-13', startTime: '09:00', endTime: '16:00' };
test('creates exactly one single-day booking and verifies it through a fresh read', async () => {
  const { client, requests } = bookingFixture();
  const result = await client.bookCareTime(booking);
  assert.equal(result.status, 'confirmed');
  const writes = requests.filter(r => r.url.endsWith('/savenursingtimes2/'));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { MultiReservations: [{ PersonId: id, PlacementId: '00000000-0000-4000-8000-000000000010', Start: '09:00', End: '16:00', Date: '13.04.2099', Type: 'I' }], DeleteOld: false, FocusDate: '13.04.2099' });
  assert.ok(requests.at(-1).url.includes('/getnursingtimes2/'));
});
test('does not send a booking when an existing one is found', async () => {
  const { client, requests } = bookingFixture({ existing: true });
  await assert.rejects(client.bookCareTime(booking), /Existing reservations/);
  assert.equal(requests.some(r => r.url.endsWith('/savenursingtimes2/')), false);
});
test('does not retry a booking when its outcome is uncertain', async () => {
  const { client, requests } = bookingFixture({ saveMode: 'timeout' });
  await assert.rejects(client.bookCareTime(booking), /outcome may be uncertain/);
  await assert.rejects(client.bookCareTime(booking), /uncertain outcome/);
  assert.equal(requests.filter(r => r.url.endsWith('/savenursingtimes2/')).length, 1);
});

const response = (status, data) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) });
const jwt = expiry => `e30.${Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url')}.signature`;
test('refreshes an expired token before a request', async () => {
  const calls = [];
  const client = new DaisyClient({ username: 'name', password: 'password', fetcher: async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    return url.endsWith('/auth/login') ? response(200, { Token: 'fresh' }) : url.endsWith('/persons/getchildren/') ? response(200, { ListChildren: [] }) : response(200, { listMessage: [] });
  } });
  client.token = jwt(Math.floor(Date.now() / 1000) - 10);
  await client.listMessages();
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.endsWith('/auth/login'));
  assert.equal(calls[1].authorization, 'Bearer fresh');
  assert.equal(calls[2].authorization, 'Bearer fresh');
});
test('reauthenticates once on 401 for read-only requests', async () => {
  const calls = [];
  const client = new DaisyClient({ username: 'name', password: 'password', fetcher: async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    if (url.endsWith('/auth/login')) return response(200, { Token: 'fresh' });
    if (options.headers.Authorization === 'Bearer stale') return response(401, {});
    return url.endsWith('/persons/getchildren/') ? response(200, { ListChildren: [] }) : response(200, { listMessage: [] });
  } });
  client.token = 'stale';
  assert.deepEqual(await client.listMessages(), []);
  assert.deepEqual(calls.map(c => c.authorization), ['Bearer stale', undefined, 'Bearer fresh', 'Bearer fresh']);
});
test('does not replay a booking on 401', async () => {
  const calls = [];
  const client = new DaisyClient({ username: 'name', password: 'password', fetcher: async (url) => { calls.push(url); return url.endsWith('/persons/getchildren/') ? response(200, { ListChildren: [] }) : response(401, {}); } });
  client.token = 'stale';
  await assert.rejects(client.request('/nursingtimes/savenursingtimes2/', { method: 'POST', body: {} }), /HTTP 401/);
  assert.equal(calls.length, 2);
  assert.equal(calls.filter(url => url.endsWith('/nursingtimes/savenursingtimes2/')).length, 1);
});
test('shares a single login across concurrent reads', async () => {
  let loginCount = 0;
  const client = new DaisyClient({ username: 'name', password: 'password', fetcher: async url => {
    if (url.endsWith('/auth/login')) { loginCount++; await new Promise(resolve => setTimeout(resolve, 5)); return response(200, { Token: 'fresh' }); }
    return url.endsWith('/persons/getchildren/') ? response(200, { ListChildren: [] }) : response(200, { listMessage: [] });
  } });
  await Promise.all([client.listMessages(), client.listMessages()]);
  assert.equal(loginCount, 1);
});
test('reauthenticates during the session check before sending a booking', async () => {
  const calls = [];
  const client = new DaisyClient({ username: 'name', password: 'password', fetcher: async (url, options) => {
    calls.push({ path: new URL(url).pathname, auth: options.headers.Authorization });
    if (url.endsWith('/auth/login')) return response(200, { Token: 'fresh' });
    if (url.endsWith('/persons/getchildren/')) return options.headers.Authorization === 'Bearer stale' ? response(401, {}) : response(200, { ListChildren: [] });
    return response(200, { ok: true });
  } });
  client.token = 'stale';
  await client.request('/nursingtimes/savenursingtimes2/', { method: 'POST', body: {} });
  assert.deepEqual(calls.map(x => x.path), ['/api/persons/getchildren/', '/api/auth/login', '/api/persons/getchildren/', '/api/nursingtimes/savenursingtimes2/']);
  assert.equal(calls.at(-1).auth, 'Bearer fresh');
});
test('does not send a booking if session validation fails', async () => {
  const calls = [];
  const client = new DaisyClient({ username: 'name', password: 'password', fetcher: async url => { calls.push(url); return response(403, {}); } });
  client.token = 'stale';
  await assert.rejects(client.request('/nursingtimes/savenursingtimes2/', { method: 'POST', body: {} }), /HTTP 403/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith('/persons/getchildren/'));
});

test('spaces concurrent request starts and does not wait for previous responses', async () => {
  let now = 0;
  const limiter = new RequestRateLimiter({ now: () => now, sleep: async ms => { now += ms; } });
  const starts = [];
  let finishFirst;
  const first = limiter.run(() => { starts.push(now); return new Promise(resolve => { finishFirst = resolve; }); });
  const second = limiter.run(() => { starts.push(now); return 'second'; });
  const third = limiter.run(() => { starts.push(now); return 'third'; });
  assert.equal(await second, 'second');
  assert.equal(await third, 'third');
  assert.deepEqual(starts, [0, 1000, 2000]);
  finishFirst('first');
  assert.equal(await first, 'first');
});
test('limits login, session checks, and actual API requests in the same queue', async () => {
  let now = 0;
  const starts = [];
  const limiter = new RequestRateLimiter({ now: () => now, sleep: async ms => { now += ms; } });
  const client = new RealDaisyClient({ username: 'name', password: 'password', rateLimiter: limiter, fetcher: async url => {
    starts.push({ path: new URL(url).pathname, time: now });
    if (url.endsWith('/auth/login')) return response(200, { Token: 'fresh' });
    if (url.endsWith('/persons/getchildren/')) return response(200, { ListChildren: [] });
    return response(200, { listMessage: [] });
  } });
  await Promise.all([client.listMessages(), client.listMessages()]);
  assert.deepEqual(starts.map(x => x.time), [0, 1000, 2000, 3000, 4000]);
  assert.equal(starts.filter(x => x.path === '/api/auth/login').length, 1);
});
test('a failed request still consumes a rate-limit slot', async () => {
  let now = 0;
  const limiter = new RequestRateLimiter({ now: () => now, sleep: async ms => { now += ms; } });
  await assert.rejects(limiter.run(() => { throw new Error('failed'); }), /failed/);
  assert.equal(await limiter.run(() => now), 1000);
});

test('expands multiple ranges and skips Finnish holidays, weekends and custom exclusions', () => {
  const ranges = [
    { startDate: '2027-03-25', endDate: '2027-03-30', startTime: '09:00', endTime: '16:00' },
    { startDate: '2027-04-01', endDate: '2027-04-02', startTime: '08:00', endTime: '15:00' }
  ];
  const result = expandBookingRanges(ranges, ['2027-04-01']);
  assert.deepEqual(result.days, [{ date: '2027-03-25', startTime: '09:00', endTime: '16:00' }, { date: '2027-03-30', startTime: '09:00', endTime: '16:00' }, { date: '2027-04-02', startTime: '08:00', endTime: '15:00' }]);
  assert.deepEqual(result.skippedDates, ['2027-03-26', '2027-03-27', '2027-03-28', '2027-03-29', '2027-04-01']);
  for (const date of ['2027-05-06', '2027-06-25', '2027-12-24']) assert.ok(finnishHolidayDates(2027).has(date));
});
test('rejects conflicting overlapping date ranges', () => {
  assert.throws(() => expandBookingRanges([{ startDate: '2099-04-20', endDate: '2099-04-20', startTime: '09:00', endTime: '16:00' }, { startDate: '2099-04-20', endDate: '2099-04-20', startTime: '10:00', endTime: '16:00' }]), /multiple ranges/);
});
function bulkFixture({ conflict = false, partial = false, failSave = false } = {}) {
  const client = new DaisyClient({ username: 'name', password: 'password' });
  const placementId = '00000000-0000-4000-8000-000000000010';
  const calls = [];
  let saved = false;
  client.request = async (path, options) => {
    if (path === '/persons/getchildren/') return { ListChildren: [{ Id: id, FirstName: 'Example', LastName: 'Child', Placements: [{ Id: placementId, Start: '2099-01-01', End: null, OpenTimes: 'MON-FRI 07:00 - 17:00' }] }] };
    if (path === '/nursingtimes/savenursingtimes2/') { calls.push(options.body); if (failSave) throw new Error('connection lost'); saved = true; return [null, { Code: partial ? -2 : 0, GroupedErrors: partial ? [{ ErrorString: 'rejected' }] : [], OvertimeDatas: [] }]; }
    throw new Error('Unexpected request');
  };
  client.careTimes = async () => ({ days: ['2099-04-20', '2099-04-22'].map((date, index) => ({ Date: `${date}T00:00:00`, IsLockedDate: false, NotSelectable: false, WeekHoliday: null, OnVacation: false, Statuses: [], CareTimeTest: [{ ChildId: id }], NursingTimes: conflict && index === 1 ? [{ PersonId: id }] : saved && (!partial || index === 0) ? [{ PersonId: id, PlacementId: placementId, Start: `${date}T${index ? '10:00' : '09:00'}:00`, End: `${date}T16:00:00` }] : [] })) });
  return { client, calls };
}
const bulk = { childName: 'Example', ranges: [{ startDate: '2099-04-20', endDate: '2099-04-20', startTime: '09:00', endTime: '16:00' }, { startDate: '2099-04-22', endDate: '2099-04-22', startTime: '10:00', endTime: '16:00' }] };
test('submits multiple dates and distinct times in a single save request and verifies each', async () => {
  const { client, calls } = bulkFixture();
  const result = await client.bookCareTimeRanges(bulk);
  assert.equal(result.status, 'confirmed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].DeleteOld, false);
  assert.deepEqual(calls[0].MultiReservations.map(x => [x.Date, x.Start, x.End]), [['20.04.2099', '09:00', '16:00'], ['22.04.2099', '10:00', '16:00']]);
  assert.ok(result.results.every(r => r.confirmed));
});
test('bulk preflight conflict prevents any save', async () => {
  const { client, calls } = bulkFixture({ conflict: true });
  await assert.rejects(client.bookCareTimeRanges(bulk), /Existing reservations/);
  assert.equal(calls.length, 0);
});
test('bulk partial result reports confirmed and unconfirmed dates without resubmission', async () => {
  const { client, calls } = bulkFixture({ partial: true });
  const result = await client.bookCareTimeRanges(bulk);
  assert.equal(result.status, 'partial_or_unconfirmed');
  assert.deepEqual(result.results.map(r => r.confirmed), [true, false]);
  await assert.rejects(client.bookCareTimeRanges(bulk), /uncertain outcome/);
  assert.equal(calls.length, 1);
});
test('bulk save network failure is uncertain and is not retried', async () => {
  const { client, calls } = bulkFixture({ failSave: true });
  await assert.rejects(client.bookCareTimeRanges(bulk), /outcome may be uncertain/);
  await assert.rejects(client.bookCareTimeRanges(bulk), /uncertain outcome/);
  assert.equal(calls.length, 1);
});
