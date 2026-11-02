/** Fuseau horaire utilisé pour définir un "jour" (limite de parties solo par jour). */
export const DEFAULT_TIMEZONE = "Europe/Paris";

/** Décalage (ms) entre l'heure locale du fuseau et UTC à l'instant `at`. */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return localAsUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Instant (UTC) correspondant à minuit, heure locale du fuseau, du jour qui contient `at`. Gère l'heure d'été. */
export function startOfDay(at: Date, timeZone: string = DEFAULT_TIMEZONE): Date {
  const offset = offsetMs(at, timeZone);
  const local = new Date(at.getTime() + offset);
  const midnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let guess = midnightAsUtc - offset;
  const offsetAtGuess = offsetMs(new Date(guess), timeZone);
  if (offsetAtGuess !== offset) guess = midnightAsUtc - offsetAtGuess;
  return new Date(guess);
}

/** Date locale "AAAA-MM-JJ" d'un instant dans le fuseau donné (sert à compter les jours d'activité). */
export function localDayKey(at: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

/** Heure locale (0-23) et jour de la semaine (0 = lundi) d'un instant dans le fuseau donné. */
export function localHourAndWeekday(at: Date, timeZone: string = DEFAULT_TIMEZONE): { hour: number; weekday: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", weekday: "short" }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return { hour: Number(p.hour), weekday: Math.max(0, names.indexOf(p.weekday)) };
}

/** Jour suivant ou précédent d'une date "AAAA-MM-JJ" (calcul de calendrier pur, sans fuseau). */
export function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Début (instant UTC) de la période en cours dans le fuseau : jour, semaine (lundi), mois, année. */
export function startOfPeriod(period: "today" | "week" | "month" | "year", at: Date, timeZone: string = DEFAULT_TIMEZONE): Date {
  const key = localDayKey(at, timeZone);
  const [y, m, d] = key.split("-").map(Number);
  let target = key;
  if (period === "week") {
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0 = lundi
    target = addDaysKey(key, -dow);
  } else if (period === "month") target = `${y}-${String(m).padStart(2, "0")}-01`;
  else if (period === "year") target = `${y}-01-01`;
  const [ty, tm, td] = target.split("-").map(Number);
  return startOfDay(new Date(Date.UTC(ty, tm - 1, td, 12)), timeZone);
}
