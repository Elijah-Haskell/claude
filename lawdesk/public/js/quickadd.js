// Quick-add: turn one typed line into a task.
//
//   "Call client re indemnity cap fri @jordan #d-1004 !high"
//     -> title "Call client re indemnity cap", due this Friday, Jordan, matter D-1004, high
//
// Dates: today, tomorrow (tmrw), weekday names (mon, friday; "next fri" = Friday of next
// week), eow (this Friday), next week (next Monday), in 3 days / in 2 weeks / in 4 bd,
// +3, +2w, +5bd, 11/20, 11/20/2026, 2026-11-20, nov 20. A "due", "by" or "on" in front
// of the date is dropped too. Business days ("bd") skip weekends only; the server applies
// firm closed days to checklist rules, not to typed dates.
// People: @ plus the start of any part of their name, or their initials (@jr).
// Matters: # plus the matter number or the start of a word in its name or client.
// Priority: !high, !h, !!, !low, !l.
//
// Pure functions, no DOM: tests/tasks/quickadd.test.ts runs this file in Node.

const DAY = 86_400_000;
const WEEKDAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const ms = (d) => Date.parse(d + "T00:00:00Z");
export const addDays = (d, n) => iso(ms(d) + n * DAY);
const dow = (d) => new Date(ms(d)).getUTCDay();

export function addWeekdays(d, n) {
  let cur = d;
  let left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    const w = dow(cur);
    if (w !== 0 && w !== 6) left--;
  }
  return cur;
}

function validDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return iso(ms(s)) === s ? s : null;
}

/** Month/day with no year: this year, or next year if that date has passed. */
function nearestYear(today, m, d) {
  const y = Number(today.slice(0, 4));
  const s = validDate(y, m, d);
  if (!s) return null;
  return s < today ? validDate(y + 1, m, d) : s;
}

function weekdayOnOrAfter(today, target) {
  return addDays(today, (target - dow(today) + 7) % 7);
}

/** The given weekday in next calendar week (weeks start Monday). */
function weekdayNextWeek(today, target) {
  const mondayThisWeek = addDays(today, -((dow(today) + 6) % 7));
  return addDays(mondayThisWeek, 7 + ((target + 6) % 7));
}

/**
 * Try to read a date starting at words[i]. Returns { date, used } (number of words used)
 * or null.
 */
export function readDate(words, i, today) {
  const w = (k) => (words[i + k] || "").toLowerCase().replace(/[,.;]$/, "");
  const a = w(0);
  if (!a) return null;
  if (a === "today" || a === "tod") return { date: today, used: 1 };
  if (a === "tomorrow" || a === "tmrw" || a === "tmr") return { date: addDays(today, 1), used: 1 };
  if (a === "eow") return { date: weekdayOnOrAfter(today, 5), used: 1 };
  if (a === "end" && w(1) === "of" && w(2) === "week") return { date: weekdayOnOrAfter(today, 5), used: 3 };
  if (a === "next" && w(1) === "week") return { date: weekdayNextWeek(today, 1), used: 2 };
  if (a === "next" && w(1) in WEEKDAYS) return { date: weekdayNextWeek(today, WEEKDAYS[w(1)]), used: 2 };
  if (a in WEEKDAYS) return { date: weekdayOnOrAfter(today, WEEKDAYS[a]), used: 1 };

  const unit = (n, u) => {
    if (/^(d|day|days)$/.test(u)) return addDays(today, n);
    if (/^(w|wk|wks|week|weeks)$/.test(u)) return addDays(today, 7 * n);
    if (/^(bd|bds|business)$/.test(u)) return addWeekdays(today, n);
    return null;
  };
  if (a === "in" && /^\d{1,3}$/.test(w(1))) {
    const n = Number(w(1));
    if (w(2) === "business" && /^days?$/.test(w(3))) return { date: addWeekdays(today, n), used: 4 };
    const d = unit(n, w(2));
    if (d) return { date: d, used: 3 };
  }
  if (a === "in") {
    const m = /^(\d{1,3})(d|w|bd)$/.exec(w(1));
    if (m) return { date: unit(Number(m[1]), m[2]), used: 2 };
  }
  let m = /^\+(\d{1,3})(d|w|bd)?$/.exec(a);
  if (m) return { date: unit(Number(m[1]), m[2] || "d"), used: 1 };

  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  if (m) {
    const d = validDate(+m[1], +m[2], +m[3]);
    return d ? { date: d, used: 1 } : null;
  }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(a);
  if (m) {
    let d;
    if (m[3]) d = validDate(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), +m[1], +m[2]);
    else d = nearestYear(today, +m[1], +m[2]);
    return d ? { date: d, used: 1 } : null;
  }
  if (a in MONTHS) {
    const dm = /^(\d{1,2})(st|nd|rd|th)?$/.exec(w(1));
    if (dm) {
      const yearWord = /^\d{4}$/.test(w(2)) ? Number(w(2)) : null;
      const d = yearWord ? validDate(yearWord, MONTHS[a], +dm[1]) : nearestYear(today, MONTHS[a], +dm[1]);
      return d ? { date: d, used: yearWord ? 3 : 2 } : null;
    }
  }
  return null;
}

function nameParts(name) {
  return String(name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function matchUser(token, users) {
  const t = token.toLowerCase();
  if (!t) return [];
  const hits = users.filter((u) => {
    const parts = nameParts(u.name);
    return parts.some((p) => p.startsWith(t)) || parts.map((p) => p[0]).join("") === t || parts.join("").startsWith(t);
  });
  return hits;
}

export function matchMatter(token, matters) {
  const t = token.toLowerCase();
  if (!t) return [];
  const byNumber = matters.filter((m) => m.number && m.number.toLowerCase() === t);
  if (byNumber.length) return byNumber;
  return matters.filter((m) => {
    if (m.number && m.number.toLowerCase().startsWith(t)) return true;
    const parts = [...nameParts(m.name), ...nameParts(m.client_name)];
    return parts.some((p) => p.startsWith(t)) || nameParts(m.name).join("").startsWith(t);
  });
}

/**
 * Parse a quick-add line.
 * ctx: { today: "YYYY-MM-DD", users: [{id,name}], matters: [{id,name,number,client_name}] }
 * Returns { title, dueDate, dueText, assignee, matter, priority, problems: [] }.
 */
export function parseQuickAdd(input, ctx) {
  const out = { title: "", dueDate: null, dueText: null, assignee: null, matter: null, priority: null, problems: [] };
  const words = String(input || "").trim().split(/\s+/).filter(Boolean);
  const keep = [];
  let dateHit = null; // last date phrase wins
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.length > 1 && word[0] === "@") {
      const hits = matchUser(word.slice(1), ctx.users || []);
      if (hits.length === 1 || (hits.length > 1 && hits.every((x) => x.id === hits[0].id))) out.assignee = hits[0];
      else if (hits.length > 1) out.problems.push(`${word} could be ${hits.map((x) => x.name).join(" or ")}`);
      else out.problems.push(`Nobody matches ${word}`);
      continue;
    }
    if (word.length > 1 && word[0] === "#") {
      const hits = matchMatter(word.slice(1), ctx.matters || []);
      if (hits.length === 1) out.matter = hits[0];
      else if (hits.length > 1) out.problems.push(`${word} matches ${hits.length} matters: ${hits.slice(0, 3).map((x) => x.number || x.name).join(", ")}`);
      else out.problems.push(`No open matter matches ${word}`);
      continue;
    }
    const pw = word.toLowerCase();
    if (pw === "!!" || pw === "!high" || pw === "!h" || pw === "!1") {
      out.priority = "high";
      continue;
    }
    if (pw === "!low" || pw === "!l" || pw === "!3") {
      out.priority = "low";
      continue;
    }
    if (pw === "!normal" || pw === "!n" || pw === "!2") {
      out.priority = "normal";
      continue;
    }
    const d = readDate(words, i, ctx.today);
    if (d) {
      let start = keep.length;
      // Drop a "due"/"by"/"on" right before the date.
      if (keep.length && /^(due|by|on)$/i.test(keep[keep.length - 1])) start--;
      if (dateHit) {
        // An earlier phrase was a date too; put its words back, the later one wins.
        keep.splice(dateHit.at, 0, ...dateHit.words);
        start += dateHit.words.length;
      }
      const removed = keep.splice(start);
      dateHit = { at: start, words: [...removed, ...words.slice(i, i + d.used)] };
      out.dueDate = d.date;
      out.dueText = dateHit.words.join(" ");
      i += d.used - 1;
      continue;
    }
    keep.push(word);
  }
  out.title = keep.join(" ").trim();
  return out;
}
