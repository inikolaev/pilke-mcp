import { finnishHolidayDates } from './holidays.js';

const ORIGIN = 'https://pilke.daisyfamily.fi';
const API = `${ORIGIN}/api`;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The queue spaces request starts, not completions, and is shared by all
// DaisyClient instances in this process. Use a monotonic clock for timing.
export class RequestRateLimiter {
  constructor({ intervalMs = 1000, now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.sleep = sleep;
    this.nextStart = -Infinity;
    this.tail = Promise.resolve();
  }
  run(startRequest) {
    const slot = this.tail.then(async () => {
      while (this.now() < this.nextStart) await this.sleep(this.nextStart - this.now());
      this.nextStart = this.now() + this.intervalMs;
      // Wrap the promise so the next slot doesn't wait for the response.
      return { result: startRequest() };
    });
    this.tail = slot.then(() => undefined, () => undefined);
    return slot.then(({ result }) => result);
  }
}

const sharedRateLimiter = new RequestRateLimiter();

export function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}

export function expandBookingRanges(ranges, excludedDates = []) {
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 20 || !Array.isArray(excludedDates) || excludedDates.some(d => !validDate(d))) throw new Error('Provide 1–20 valid date ranges and valid excluded dates.');
  const selected = new Map(), skipped = [], excluded = new Set(excludedDates), holidays = new Map();
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  for (const range of ranges) {
    const { startDate, endDate, startTime, endTime } = range;
    if (!validDate(startDate) || !validDate(endDate) || startDate > endDate || !time.test(startTime) || !time.test(endTime) || startTime >= endTime) throw new Error('Each range needs valid dates and same-day times in HH:MM order.');
    if ((Date.parse(endDate) - Date.parse(startDate)) / 86400000 > 93) throw new Error('Each range may span at most 94 days.');
    for (let ms = Date.parse(`${startDate}T00:00:00Z`), end = Date.parse(`${endDate}T00:00:00Z`); ms <= end; ms += 86400000) {
      const date = new Date(ms).toISOString().slice(0, 10), year = Number(date.slice(0, 4));
      if (!holidays.has(year)) holidays.set(year, finnishHolidayDates(year));
      const weekday = new Date(ms).getUTCDay();
      if (weekday === 0 || weekday === 6 || holidays.get(year).has(date) || excluded.has(date)) { skipped.push(date); continue; }
      if (selected.has(date)) throw new Error(`Date ${date} appears in multiple ranges.`);
      selected.set(date, { date, startTime, endTime });
    }
  }
  const days = [...selected.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length || days.length > 62) throw new Error('The request must contain between 1 and 62 eligible weekdays.');
  if ((Date.parse(days.at(-1).date) - Date.parse(days[0].date)) / 86400000 > 93) throw new Error('The eligible dates together may span at most 94 days.');
  return { days, skippedDates: [...new Set(skipped)].sort() };
}

export class DaisyClient {
  constructor({ username, password, fetcher = fetch, rateLimiter = sharedRateLimiter }) {
    if (!username || !password) throw new Error('Set DAISY_USERNAME and DAISY_PASSWORD in .env or the environment.');
    this.username = username;
    this.password = password;
    this.fetch = fetcher;
    this.rateLimiter = rateLimiter;
    this.token = null;
    this.loginPromise = null;
    this.pendingBookings = new Set();
  }
  async request(path, { method = 'GET', body, auth = true, trace, retried = false, skipSessionCheck = false } = {}) {
    // Explicit allowlist: no caller-provided URL, mutation endpoint or redirects.
    const allowed = (method === 'POST' && ['/auth/login', '/Messages/GetMessageList2/', '/Messages/GetMessageThread2', '/files/downloadFile', '/nursingtimes/savenursingtimes2/'].includes(path)) ||
      (method === 'GET' && (/^\/nursingtimes\/getnursingtimes2\/\d{2}\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/.test(path) || path === '/bulletinboards?type=parent' || path === '/persons/getchildren/'));
    if (!allowed) throw new Error('Request blocked by endpoint allowlist.');
    if (auth) await this.ensureAuthenticated(trace);
    // A known read-only authenticated endpoint doubles as the session probe. Avoid
    // exposing its unrelated child data through another tool's diagnostics.
    if (auth && !skipSessionCheck && !(method === 'GET' && path === '/persons/getchildren/')) {
      const session = await this.request('/persons/getchildren/', { skipSessionCheck: true });
      if (!Array.isArray(session?.ListChildren)) throw new Error('DaisyFamily session check returned an unexpected response.');
    }
    const requestToken = auth ? this.token : null;
    const headers = { Accept: 'application/json', 'Accept-Language': 'en-US' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = `Bearer ${requestToken}`;
    const entry = trace && { request: { method, url: API + path, headers: { ...headers, ...(auth ? { Authorization: '[REDACTED]' } : {}) }, body: auth ? body ?? null : '[REDACTED]' } };
    if (entry) trace.push(entry);
    let response;
    try {
      response = await this.rateLimiter.run(() => this.fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) }));
    } catch (error) {
      const code = error.cause?.code || error.code || error.name;
      if (entry) entry.networkError = { code };
      throw new Error(`DaisyFamily could not be reached (${code}). Check network access and DNS.`);
    }
    const text = await response.text();
    if (entry) {
      // Login responses may contain tokens; never expose them, even in debug mode.
      let safeText = text;
      for (const secret of [this.username, this.password, requestToken, this.token]) {
        if (secret) safeText = safeText.replaceAll(secret, '[REDACTED]');
      }
      entry.response = { status: response.status, headers: { 'content-type': response.headers?.get('content-type') || null }, body: auth ? safeText.slice(0, 100000) : '[REDACTED]', truncated: auth && safeText.length > 100000 };
    }
    if (!response.ok) {
      if (auth && (response.status === 401 || response.status === 403) && this.token === requestToken) this.token = null;
      // These POST endpoints only retrieve data. Never replay a booking request.
      const readOnly = method === 'GET' || ['/Messages/GetMessageList2/', '/Messages/GetMessageThread2', '/files/downloadFile'].includes(path);
      if (auth && response.status === 401 && readOnly && !retried) {
        await this.ensureAuthenticated(trace);
        return this.request(path, { method, body, auth, trace, retried: true, skipSessionCheck });
      }
      const error = new Error(`DaisyFamily returned HTTP ${response.status}${response.status === 401 || response.status === 403 ? '; check credentials or restart the server' : ''}.`);
      error.status = response.status;
      throw error;
    }
    try { return JSON.parse(text); } catch { return text; }
  }
  async ensureAuthenticated(trace) {
    if (this.token) {
      try {
        const payload = JSON.parse(Buffer.from(this.token.split('.')[1], 'base64url').toString('utf8'));
        if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now() + 30000) this.token = null;
      } catch { /* A token without a readable expiration can still be used. */ }
    }
    if (this.token) return;
    if (!this.loginPromise) {
      this.loginPromise = this.login(trace).finally(() => { this.loginPromise = null; });
    }
    await this.loginPromise;
  }
  async login(trace) {
    const data = await this.request('/auth/login', { method: 'POST', auth: false, body: { Username: this.username, Password: this.password }, trace });
    if (typeof data?.Token !== 'string' || !data.Token) throw new Error('DaisyFamily login did not return an access token.');
    this.token = data.Token;
  }
  async listMessages() {
    const data = await this.request('/Messages/GetMessageList2/', { method: 'POST', body: {} });
    if (!Array.isArray(data?.listMessage)) throw new Error('Unexpected message-list response from DaisyFamily.');
    return data.listMessage;
  }
  async getThread(threadId) {
    if (!GUID.test(threadId)) throw new Error('Invalid message thread ID.');
    return this.request('/Messages/GetMessageThread2', { method: 'POST', body: { ThreadId: threadId, MessageId: '', HideRecipients: true } });
  }
  async careTimes(start, end, { trace } = {}) {
    if (!validDate(start) || !validDate(end) || end < start) throw new Error('Use valid start and end dates in YYYY-MM-DD order.');
    if ((Date.parse(end) - Date.parse(start)) / 86400000 > 93) throw new Error('Request at most 94 days at a time.');
    // Request at least 14 inclusive days to avoid failures seen with single-week ranges.
    const padded = new Date(Date.parse(`${end}T00:00:00Z`) - 13 * 86400000).toISOString().slice(0, 10);
    const first = padded < start ? padded : start;
    if (!validDate(first)) throw new Error('Date range is too close to the start of the supported calendar.');
    const data = await this.request(`/nursingtimes/getnursingtimes2/${first.slice(5, 7)}/${first}/${end}`, { trace });
    if (!Array.isArray(data?.NursingTimeDays)) throw new Error('Unexpected care-time response from DaisyFamily.');
    const days = data.NursingTimeDays.filter(day => typeof day.Date === 'string' && day.Date.slice(0, 10) >= start && day.Date.slice(0, 10) <= end);
    return { startDate: start, endDate: end, days };
  }
  async bulletins() { return this.request('/bulletinboards?type=parent'); }
  async bookCareTimeRanges({ childName, ranges, excludedDates = [] }) {
    if (!childName?.trim()) throw new Error('Provide a unique child name.');
    const { days, skippedDates } = expandBookingRanges(ranges, excludedDates);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (days[0].date < today) throw new Error('Cannot book past dates.');
    const keys = days.map(d => `${childName.trim().toLocaleLowerCase()}|${d.date}`);
    if (keys.some(key => this.pendingBookings.has(key))) throw new Error('A booking for one of these dates is in progress or has an uncertain outcome. Check DaisyFamily before retrying.');
    for (const key of keys) this.pendingBookings.add(key);
    let dispatched = false;
    try {
      const children = await this.request('/persons/getchildren/');
      if (!Array.isArray(children?.ListChildren)) throw new Error('Could not validate children and placements.');
      const matches = children.ListChildren.filter(c => [c.FirstName, c.Name, `${c.FirstName} ${c.LastName}`].some(n => typeof n === 'string' && n.trim().toLocaleLowerCase() === childName.trim().toLocaleLowerCase()));
      if (matches.length !== 1 || !GUID.test(matches[0].Id) || !Array.isArray(matches[0].Placements)) throw new Error('Child name must uniquely match a child with valid placements.');
      const child = matches[0];
      const calendar = await this.careTimes(days[0].date, days.at(-1).date);
      const formatted = date => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
      const reservations = days.map(({ date, startTime, endTime }) => {
        const placements = child.Placements.filter(p => GUID.test(p.Id) && typeof p.Start === 'string' && p.Start.slice(0, 10) <= date && (p.End === null || (typeof p.End === 'string' && p.End.slice(0, 10) >= date)));
        if (placements.length !== 1) throw new Error(`Expected exactly one active placement for ${date}.`);
        const placement = placements[0];
        const hours = /^(?:MA-PE|MON-FRI)\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/i.exec(placement.OpenTimes || '');
        if (!hours || startTime < hours[1] || endTime > hours[2]) throw new Error(`Cannot validate opening hours for ${date}, or requested times are outside them.`);
        const day = calendar.days.find(d => d.Date?.slice(0, 10) === date);
        if (!day || day.IsLockedDate !== false || day.NotSelectable !== false || day.WeekHoliday || day.OnVacation !== false || !Array.isArray(day.NursingTimes) || !Array.isArray(day.Statuses) || !Array.isArray(day.CareTimeTest) || !day.CareTimeTest.some(c => c.ChildId === child.Id)) throw new Error(`${date} is locked, unavailable, or could not be safely validated.`);
        if (day.Statuses.length || day.NursingTimes.some(n => n.PersonId === child.Id || !n.PersonId)) throw new Error(`Existing reservations or statuses were found on ${date}; nothing was submitted.`);
        return { PersonId: child.Id, PlacementId: placement.Id, Start: startTime, End: endTime, Date: formatted(date), Type: 'I' };
      });
      const body = { MultiReservations: reservations, DeleteOld: false, FocusDate: formatted(days[0].date) };
      // Never replay the save, even if the response or verification fails.
      dispatched = true;
      const saved = await this.request('/nursingtimes/savenursingtimes2/', { method: 'POST', body });
      const status = saved?.[1];
      if (!status || typeof status.Code !== 'number') throw new Error('The server returned an unrecognized booking response.');
      const verified = await this.careTimes(days[0].date, days.at(-1).date);
      const results = days.map((entry, index) => {
        const day = verified.days.find(d => d.Date?.slice(0, 10) === entry.date);
        const booking = day?.NursingTimes?.some(n => n.PersonId === child.Id && n.PlacementId === reservations[index].PlacementId && n.Start?.slice(11, 16) === entry.startTime && n.End?.slice(11, 16) === entry.endTime);
        return { ...entry, confirmed: booking === true };
      });
      if (status.Code === 0 && results.every(r => r.confirmed)) {
        for (const key of keys) this.pendingBookings.delete(key);
      }
      return { status: status.Code === 0 && results.every(r => r.confirmed) ? 'confirmed' : 'partial_or_unconfirmed', child: child.FirstName, serverCode: status.Code, results, skippedDates, errors: status.GroupedErrors || [], overtime: status.OvertimeDatas || [], ...(status.Code === 0 && results.every(r => r.confirmed) ? {} : { note: 'Do not retry automatically. Inspect DaisyFamily and the per-date results first.' }) };
    } catch (error) {
      if (!dispatched) for (const key of keys) this.pendingBookings.delete(key);
      if (dispatched) throw new Error(`Bulk booking outcome may be uncertain: ${error.message} Check DaisyFamily before retrying; the request will not be retried automatically.`);
      throw error;
    }
  }
  async bookCareTime({ childName, date, startTime, endTime }) {
    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (!childName?.trim() || !validDate(date) || !timePattern.test(startTime) || !timePattern.test(endTime) || startTime >= endTime) throw new Error('Provide a child name, a valid date, and same-day times in HH:MM order.');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (date < today) throw new Error('Cannot book a past date.');
    const key = `${childName.trim().toLocaleLowerCase()}|${date}`;
    if (this.pendingBookings.has(key)) throw new Error('A booking for this child and day is already in progress or has an uncertain outcome. Check DaisyFamily before retrying.');
    this.pendingBookings.add(key);
    let dispatched = false;
    try {
      const data = await this.request('/persons/getchildren/');
      if (!Array.isArray(data?.ListChildren)) throw new Error('Could not validate children and placements.');
      const matches = data.ListChildren.filter(c => [c.FirstName, c.Name, `${c.FirstName} ${c.LastName}`].some(n => typeof n === 'string' && n.trim().toLocaleLowerCase() === childName.trim().toLocaleLowerCase()));
      if (matches.length !== 1) throw new Error('Child name must uniquely match an available child.');
      const child = matches[0];
      if (!GUID.test(child.Id) || !Array.isArray(child.Placements)) throw new Error('Cannot validate the child or placements.');
      const placements = child.Placements.filter(p => GUID.test(p.Id) && typeof p.Start === 'string' && p.Start.slice(0, 10) <= date && (p.End === null || (typeof p.End === 'string' && p.End.slice(0, 10) >= date)));
      if (placements.length !== 1) throw new Error('Expected exactly one active placement for this date.');
      const placement = placements[0];
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if ((weekday === 6 && placement.IsOpenSaturday !== true) || (weekday === 0 && placement.IsOpenSunday !== true)) throw new Error('The placement is not open for bookings on this weekend day.');
      const hours = /^(?:MA-PE|MON-FRI)\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/i.exec(placement.OpenTimes || '');
      if (weekday === 0 || weekday === 6 || !hours) throw new Error('Cannot safely validate opening hours for this day; use DaisyFamily directly.');
      if (startTime < hours[1] || endTime > hours[2]) throw new Error(`Requested times are outside placement opening hours ${hours[1]}–${hours[2]}.`);
      const calendar = await this.careTimes(date, date);
      const day = calendar.days.find(d => d.Date?.slice(0, 10) === date);
      if (!day || day.IsLockedDate !== false || day.NotSelectable !== false || day.WeekHoliday || day.OnVacation !== false || !Array.isArray(day.NursingTimes) || !Array.isArray(day.Statuses) || !Array.isArray(day.CareTimeTest) || !day.CareTimeTest.some(c => c.ChildId === child.Id)) throw new Error('The date is locked, unavailable, or could not be safely validated.');
      if (day.Statuses.length || day.NursingTimes.some(n => n.PersonId === child.Id || !n.PersonId)) throw new Error('Existing reservations or statuses were found. This tool will not alter them.');
      const formattedDate = `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
      const body = { MultiReservations: [{ PersonId: child.Id, PlacementId: placement.Id, Start: startTime, End: endTime, Date: formattedDate, Type: 'I' }], DeleteOld: false, FocusDate: formattedDate };
      // No automatic retries: a transport failure can happen after the server saved it.
      dispatched = true;
      const saved = await this.request('/nursingtimes/savenursingtimes2/', { method: 'POST', body });
      const status = saved?.[1];
      if (!status || typeof status.Code !== 'number') throw new Error('The server returned an unrecognized booking response.');
      const verified = await this.careTimes(date, date);
      const updated = verified.days.find(d => d.Date?.slice(0, 10) === date);
      const hasBooking = updated?.NursingTimes?.some(n => n.PersonId === child.Id && n.PlacementId === placement.Id && n.Start?.slice(11, 16) === startTime && n.End?.slice(11, 16) === endTime);
      if (status.Code !== 0 || !hasBooking) throw new Error(`Booking response code ${status.Code}; matching booking ${hasBooking ? 'found' : 'not confirmed'}. Inspect DaisyFamily before retrying.`);
      this.pendingBookings.delete(key);
      return { status: 'confirmed', child: child.FirstName, date, startTime, endTime, serverCode: status.Code, warnings: status.GroupedErrors || [], overtime: status.OvertimeDatas || [] };
    } catch (error) {
      if (!dispatched) this.pendingBookings.delete(key);
      if (dispatched) throw new Error(`Booking outcome may be uncertain: ${error.message} Check DaisyFamily before retrying; the request will not be retried automatically.`);
      throw error;
    }
  }
  async attachment(threadId, attachmentId) {
    if (!GUID.test(attachmentId)) throw new Error('Invalid attachment ID.');
    const thread = await this.getThread(threadId);
    const attachments = (thread?.listMessageModels || []).flatMap(message => message.ListAttachments || []);
    const item = attachments.find(a => String(a.Id).toLowerCase() === attachmentId.toLowerCase());
    if (!item) throw new Error('Attachment was not found in the specified thread.');
    const data = await this.request('/files/downloadFile', { method: 'POST', body: { FileId: item.Id, FileType: 'ATTACHMENT', FileMimeType: item.MimeType } });
    if (typeof data !== 'string') throw new Error('Unsupported attachment response from DaisyFamily.');
    const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(data);
    const encoded = (match ? match[2] : data).replace(/\s/g, '');
    if (!encoded || encoded.length > 28_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Attachment is too large or has an unsupported encoding.');
    return { name: item.FileName, mimeType: item.MimeType || match?.[1] || 'application/octet-stream', bytes: Buffer.from(encoded, 'base64') };
  }
}
