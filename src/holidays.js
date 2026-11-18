// Dates are computed in UTC as calendar dates, not converted between time zones.
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString().slice(0, 10);

export function finnishHolidayDates(year) {
  if (!Number.isInteger(year) || year < 1900 || year > 2099) throw new Error('Finnish holiday calculation supports years 1900–2099.');
  // Gregorian Easter (Meeus/Jones/Butcher algorithm).
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = (h + l - 7 * m + 114) % 31 + 1;
  const easter = Date.UTC(year, month - 1, day);
  // Midsummer Day is the Saturday from June 20–26; its eve is the Friday.
  let midsummer = Date.UTC(year, 5, 20);
  while (new Date(midsummer).getUTCDay() !== 6) midsummer += DAY;
  return new Set([
    `${year}-01-01`, `${year}-01-06`, iso(easter - 2 * DAY), iso(easter),
    iso(easter + DAY), `${year}-05-01`, iso(easter + 39 * DAY), iso(easter + 49 * DAY),
    iso(midsummer - DAY), iso(midsummer), `${year}-12-06`, `${year}-12-24`, `${year}-12-25`, `${year}-12-26`
  ]);
}
