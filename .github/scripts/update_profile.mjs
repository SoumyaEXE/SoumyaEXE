#!/usr/bin/env node
/**
 * Regenerates the ASCII blocks inside README.md.
 *
 * Bars are drawn by chartscii; the boxes around them are drawn here.
 * Needs node 18+ (built-in fetch) and `npm ci`. Reads GH_TOKEN from env.
 * Everything between <!--START:key--> and <!--END:key--> gets replaced.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import Chartscii from 'chartscii';

const USER = process.env.GH_USER ?? 'SoumyaEXE';
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const README = process.env.README_PATH ?? 'README.md';
const TZ_OFFSET = 5.5 * 60 * 60 * 1000; // Asia/Kolkata

const API = 'https://api.github.com/graphql';
// the canvas is 94 columns: two half panes (42 inner + 4 of border and padding
// = 46 each) with a 2 column gap, or one full pane (90 inner + 4).
const HALF = 42;
const FULL = 90;
const GAP = 2;

// ──────────────────────────────────────────────────────────── api

async function gql(query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      authorization: `bearer ${TOKEN}`,
      'content-type': 'application/json',
      'user-agent': `${USER}-profile-bot`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const payload = await res.json();
  if (payload.errors) throw new Error(JSON.stringify(payload.errors, null, 2));
  return payload.data;
}

const Q_ID = 'query($login:String!){ user(login:$login){ id createdAt } }';

const Q_MAIN = `
query($login:String!, $uid:ID!, $from:DateTime!, $to:DateTime!) {
  user(login:$login) {
    followers { totalCount }
    following { totalCount }
    pullRequests(states: MERGED) { totalCount }
    issues { totalCount }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false,
                 orderBy: {field: PUSHED_AT, direction: DESC}) {
      totalCount
      nodes {
        name
        stargazerCount
        forkCount
        isPrivate
        pushedAt
        primaryLanguage { name }
        languages(first: 12, orderBy: {field: SIZE, direction: DESC}) {
          edges { size node { name } }
        }
        defaultBranchRef {
          target {
            ... on Commit {
              history(first: 100, author: {id: $uid}) {
                totalCount
                nodes { committedDate }
              }
            }
          }
        }
      }
    }
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      restrictedContributionsCount
      totalPullRequestReviewContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount weekday } }
      }
    }
  }
}
`;

async function fetchProfile() {
  const ident = (await gql(Q_ID, { login: USER })).user;
  const to = new Date();
  const from = new Date(to.getTime() - 365 * 864e5);
  const data = (await gql(Q_MAIN, {
    login: USER,
    uid: ident.id,
    from: from.toISOString(),
    to: to.toISOString(),
  })).user;
  data._createdAt = ident.createdAt;
  return data;
}

// ──────────────────────────────────────────────────────── drawing

/** rows: strings, or ['sep', label] tuples for a mid-box divider. */
export function box(title, rows, width = HALF) {
  const head = `┌─ ${title} `;
  const out = [head + '─'.repeat(Math.max(1, width + 3 - head.length)) + '┐'];
  for (const r of rows) {
    if (Array.isArray(r) && r[0] === 'sep') {
      const lead = `├─ ${r[1]} `;
      out.push(lead + '─'.repeat(Math.max(1, width + 3 - lead.length)) + '┤');
    } else {
      out.push(`│ ${r.slice(0, width).padEnd(width)} │`);
    }
  }
  out.push('└' + '─'.repeat(width + 2) + '┘');
  return out.join('\n');
}

/**
 * grows a rendered box to `height` lines with blank interior rows. they go in
 * just above the last divider (verdict / meta) so the footer row stays pinned
 * to the bottom border; a box with no divider gets them at the end of its body.
 */
function stretch(lines, height) {
  const extra = height - lines.length;
  if (extra <= 0) return lines;
  const blank = `│${' '.repeat(lines[0].length - 2)}│`;
  let at = lines.findLastIndex((l) => l.startsWith('├'));
  if (at < 0) at = lines.length - 1; // no divider: pad above the bottom border
  return [...lines.slice(0, at), ...new Array(extra).fill(blank), ...lines.slice(at)];
}

/** two rendered boxes, joined line by line. the shorter one is stretched first. */
export function sideBySide(left, right, gap = GAP) {
  const a = left.split('\n');
  const b = right.split('\n');
  const height = Math.max(a.length, b.length);
  const l = stretch(a, height);
  const r = stretch(b, height);
  return l.map((line, i) => line + ' '.repeat(gap) + r[i]).join('\n');
}

/**
 * chartscii emits ANSI even with color:false, and GitHub renders escapes as
 * literal junk inside a code block, so they get stripped here.
 * barSize:1 is not cosmetic: without it valueLabels makes every bar 5 rows tall.
 * each line comes back labelWidth + 2 + width characters wide (label, a space,
 * the axis glyph, then the bar), which is what the callers budget against.
 */
export function bars(points, { width = 24, labelWidth, max = 100 } = {}) {
  const unit = max / width; // value that one character is worth
  const data = points.map(([label, value]) => ({
    label: labelWidth ? pad(label, labelWidth) : label,
    // chartscii rounds, so anything under half a character rounds away to an
    // empty rail. floor real-but-tiny shares at half a char so they read as
    // "small", not "none". the printed % below is the untouched value.
    value: value > 0 ? Math.max(value, unit / 2) : 0,
  }));
  const chart = new Chartscii(data, {
    width,
    // a numeric scale is a divisor yielding a character count, not a max value.
    // max/width therefore measures every bar against `max` (100 for percentages),
    // where the default 'auto' stretches whatever the largest entry is to full width.
    scale: unit,
    barSize: 1, // without this, valueLabels silently makes each bar 5 rows tall
    color: false,
    colorLabels: false,
    fill: '─',
    char: '█',
    labels: true,
    // labels are appended by the callers instead, so that the bar-value nudge
    // above can never leak into the number that gets printed
    valueLabels: false,
  });
  return chart
    .create()
    .replace(/\x1b\[[0-9;]*m/g, '') // GitHub renders ANSI escapes as literal junk
    .split('\n')
    .filter((line) => line.trim().length);
}

// never wider than 5 characters below a million, the stats columns rely on it
const human = (n) => {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 100 ? `${k.toFixed(1)}k`.replace('.0k', 'k') : `${k.toFixed(0)}k`;
};

export function humanBytes(n) {
  // G is there for width, not realism: without it 10G+ prints as a 7 char 'M'
  for (const [unit, step] of [['G', 1024 ** 3], ['M', 1024 ** 2], ['k', 1024]]) {
    if (n >= step) {
      const v = n / step;
      return v < 100 ? `${v.toFixed(1)}${unit}` : `${v.toFixed(0)}${unit}`;
    }
  }
  return `${n}B`;
}

const pad = (s, n) => String(s).slice(0, n).padEnd(n);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ist = (d) => new Date(d.getTime() + TZ_OFFSET); // read via getUTC* after this
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// ──────────────────────────────────────────────────────── renders
// every half pane row is budgeted to exactly 42 columns. box() slices an
// overlong row without complaint, so when a width changes, redo the sum.

export function renderStats(d) {
  const c = d.contributionsCollection;
  const repos = d.repositories.nodes;
  const stars = repos.reduce((a, r) => a + r.stargazerCount, 0);
  const forks = repos.reduce((a, r) => a + r.forkCount, 0);
  const commits = c.totalCommitContributions + c.restrictedContributionsCount;
  const [cur, longest] = streaks(c.contributionCalendar);
  const created = new Date(d._createdAt);
  const joined = ist(created);
  const age = Math.floor((Date.now() - created.getTime()) / 864e5);

  // 14 label + 5 value, ' │ ', 14 label + 6 value: 19 + 3 + 20 = 42.
  // the left value column is the one that gives up a character, and human()
  // never returns more than 5, so a label and its number cannot touch.
  // `bw` moves the split on the right, for a short label with a long value.
  const row = ([a, av, b, bv], bw = 14) =>
    `${pad(a, 14)}${av.padStart(5)} │ ${pad(b, bw)}${bv.padStart(20 - bw)}`;

  const pairs = [
    ['commits (1y)', human(commits), 'merged PRs', human(d.pullRequests.totalCount)],
    ['contributions', human(c.contributionCalendar.totalContributions),
      'issues', human(d.issues.totalCount)],
    ['stars earned', human(stars), 'forks', human(forks)],
    ['repos', human(d.repositories.totalCount),
      'code reviews', human(c.totalPullRequestReviewContributions)],
    ['followers', human(d.followers.totalCount),
      'following', human(d.following.totalCount)],
    ['current streak', `${cur}d`, 'longest streak', `${longest}d`],
  ];
  const rows = pairs.map((p) => row(p)); // not map(row): the index would land in bw
  rows.push(['sep', 'meta'],
    row(['account age', `${age}d`, 'joined',
      `${MONTHS[joined.getUTCMonth()]} ${joined.getUTCFullYear()}`], 12));
  return box('stats', rows);
}

function streaks(cal) {
  const days = cal.weeks
    .flatMap((w) => w.contributionDays)
    .map((day) => [day.date, day.contributionCount])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const today = ist(new Date()).toISOString().slice(0, 10);
  let longest = 0, run = 0;
  for (const [, n] of days) {
    run = n > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let cur = 0;
  for (const [date, n] of [...days].reverse()) {
    if (n === 0) {
      if (date >= today) continue; // today isn't over yet, don't punish it
      break;
    }
    cur += 1;
  }
  return [cur, longest];
}

function commitTimes(d) {
  const hours = new Array(24).fill(0);
  const wdays = new Array(7).fill(0);
  for (const r of d.repositories.nodes) {
    const hist = r.defaultBranchRef?.target?.history?.nodes ?? [];
    for (const node of hist) {
      const t = ist(new Date(node.committedDate));
      hours[t.getUTCHours()] += 1;
      wdays[(t.getUTCDay() + 6) % 7] += 1; // sunday-first -> monday-first
    }
  }
  return [hours, wdays];
}

export function renderClock(d) {
  const [hours, wdays] = commitTimes(d);
  const sum = (hs) => hs.reduce((a, h) => a + hours[h], 0);
  const sampled = hours.reduce((a, b) => a + b, 0);
  const total = sampled || 1;

  const buckets = [
    ['morning 05-12', sum([5, 6, 7, 8, 9, 10, 11])],
    ['daytime 12-17', sum([12, 13, 14, 15, 16])],
    ['evening 17-22', sum([17, 18, 19, 20, 21])],
    ['gremlin 22-05', sum([22, 23, 0, 1, 2, 3, 4])],
  ].map(([l, n]) => [l, (n / total) * 100]);

  const wtotal = wdays.reduce((a, b) => a + b, 0) || 1;
  const byDay = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    .map((nm, i) => [nm, (wdays[i] / wtotal) * 100]);

  // 13 label + 2 axis + 20 bar + 7 for ' 100.0%' = 42
  const opts = { width: 20, labelWidth: 13 };
  const withPct = (points) => {
    const lines = bars(points, opts);
    return lines.map((line, i) =>
      i < points.length ? `${line} ${points[i][1].toFixed(1).padStart(5)}%` : line);
  };
  const rows = [
    ...withPct(buckets).slice(0, -1), // drop this group's baseline, a sep follows
    ['sep', 'by weekday'],
    ...withPct(byDay),
  ];
  // with nothing sampled every hour ties at zero and "peak 00:00" would be a lie
  const peak = hours.indexOf(Math.max(...hours));
  rows.push(['sep', 'verdict'], sampled
    ? `peak ${String(peak).padStart(2, '0')}:00 IST · ${plural(sampled, 'commit')} sampled`
    : 'no commits sampled yet');
  return box('when i actually commit', rows);
}

export function renderLangs(d) {
  const sizes = new Map();
  for (const r of d.repositories.nodes) {
    for (const e of r.languages.edges) {
      sizes.set(e.node.name, (sizes.get(e.node.name) ?? 0) + e.size);
    }
  }
  // chartscii throws on an empty dataset, so bail before it gets the chance
  if (!sizes.size) return box('languages by bytes written', ['no languages found']);

  const total = [...sizes.values()].reduce((a, b) => a + b, 0) || 1;
  const ranked = [...sizes].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 7);
  const rest = ranked.slice(7);

  const points = top.map(([name, size]) => [name, (size / total) * 100]);
  const tail = top.map(([, size]) => humanBytes(size));
  if (rest.length) {
    const other = rest.reduce((a, [, s]) => a + s, 0);
    points.push([`+${rest.length} more`, (other / total) * 100]);
    tail.push(humanBytes(other));
  }

  // 11 label + 2 axis + 15 bar + 7 for ' 100.0%' + 7 for the byte count = 42
  const lines = bars(points, { width: 15, labelWidth: 11 });
  // last line is chartscii's baseline; the value columns only apply to bars
  const rows = lines.map((line, i) =>
    i < points.length
      ? `${line} ${points[i][1].toFixed(1).padStart(5)}% ${tail[i].padStart(6)}`
      : line);

  const [lead, size] = top[0];
  // the name is capped at 16 ("jupyter notebook") so the line cannot pass 42
  rows.push(['sep', 'verdict'],
    `${((size / total) * 100).toFixed(0)}% ${lead.toLowerCase().slice(0, 16)} · ` +
    `${plural(sizes.size, 'lang')} · ${humanBytes(total)}`);
  return box('languages by bytes written', rows);
}

export function renderRepos(d) {
  // private repos are excluded: their names would otherwise be published here
  const repos = d.repositories.nodes
    .filter((r) => !r.isPrivate)
    .map((r) => [r.name, r.defaultBranchRef?.target?.history?.totalCount ?? 0])
    .filter(([, commits]) => commits > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!repos.length) return box('where the commits went', ['no commits found']);

  const top = repos.slice(0, 6);
  // 16 label + 2 axis + 18 bar + 6 for the count = 42. repo names run long,
  // so the label gets the columns that a percentage takes in the other panes.
  const lines = bars(top, { width: 18, labelWidth: 16, max: top[0][1] });
  const rows = lines.map((line, i) =>
    i < top.length ? `${line} ${String(top[i][1]).padStart(5)}` : line);

  const counted = repos.reduce((a, [, n]) => a + n, 0);
  rows.push(['sep', 'verdict'],
    `${plural(repos.length, 'repo')} touched · ${counted.toLocaleString('en-US')} ` +
    `commit${counted === 1 ? '' : 's'} by me`);
  return box('where the commits went', rows);
}

// shade glyphs (░▒▓) fall back to a taller font on github and bleed across rows,
// so the ramp sticks to characters the code font itself carries
const RAMP = '·:+#█'; // index 0 is a day with nothing, 1-4 are the quartiles
const HEAT_COLS = 53; // a year is 52 weeks plus the partial one it starts in
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * calendar dates arrive as plain 'YYYY-MM-DD' strings and are only ever sliced,
 * never fed through Date, so no timezone can nudge a day into its neighbour.
 */
const prettyDay = (iso) =>
  `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

export function renderHeat(d) {
  const cal = d.contributionsCollection.contributionCalendar;
  // a 365 day window that opens on a saturday spills into 54 weeks; keep the
  // newest 53 so the grid width is fixed and the summary describes what is drawn
  const weeks = cal.weeks.filter((w) => w.contributionDays.length).slice(-HEAT_COLS);
  const days = weeks.flatMap((w) => w.contributionDays);
  const count = (list) => list.reduce((a, x) => a + x.contributionCount, 0);

  // quartiles of the non-zero days. bucketing against the max instead would let
  // a single 80-commit day push every ordinary day down into the faintest shade.
  const busy = days.map((x) => x.contributionCount).filter((n) => n > 0)
    .sort((a, b) => a - b);
  const cuts = [0.25, 0.5, 0.75].map((q) => busy[Math.floor(q * (busy.length - 1))]);
  const shade = (n) => (n > 0 ? RAMP[1 + cuts.filter((c) => n > c).length] : RAMP[0]);

  // one column per week, one row per weekday. the first and last weeks are
  // usually partial, and the days they lack stay blank instead of reading as zero.
  const grid = WEEKDAYS.map(() => new Array(HEAT_COLS).fill(' '));
  weeks.forEach((w, col) => {
    for (const day of w.contributionDays) {
      grid[day.weekday][col] = shade(day.contributionCount);
    }
  });

  // a month is labelled over the first week that begins inside it. the opening
  // column is usually the tail end of a month, so it only gets a label when the
  // next one is far enough away not to collide with it.
  const months = new Array(HEAT_COLS).fill(' ');
  const monthOf = (w) => Number(w.contributionDays[0].date.slice(5, 7)) - 1;
  let starts = weeks.map((w, i) => i)
    .filter((i) => i === 0 || monthOf(weeks[i]) !== monthOf(weeks[i - 1]));
  if (starts.length > 1 && starts[1] - starts[0] < 4) starts = starts.slice(1);
  let free = 0; // first column the next label is allowed to start in
  for (const col of starts) {
    if (col < free || col + 3 > HEAT_COLS) continue;
    [...MONTHS[monthOf(weeks[col])]].forEach((ch, k) => { months[col + k] = ch; });
    free = col + 4;
  }

  const sum = count(days);
  const best = days.reduce((a, x) => (x.contributionCount > a.contributionCount ? x : a),
    { contributionCount: 0 });
  const weekSums = weeks.map((w) => count(w.contributionDays));
  const bestWeek = weekSums.indexOf(Math.max(0, ...weekSums));
  const perWeekday = WEEKDAYS.map((_, i) => count(days.filter((x) => x.weekday === i)));
  const topWeekday = perWeekday.indexOf(Math.max(...perWeekday));

  // the total comes from the api so that it agrees with the stats box
  const total = cal.totalContributions ?? sum;
  const side = [
    ['total', total.toLocaleString('en-US')],
    ['active', `${busy.length} of ${plural(days.length, 'day')}`],
    ['daily avg', `${(days.length ? sum / days.length : 0).toFixed(1)} per day`],
    ['busiest', sum ? `${prettyDay(best.date)} · ${human(best.contributionCount)}` : 'none yet'],
    ['best week', sum
      ? `${prettyDay(weeks[bestWeek].contributionDays[0].date)} · ${human(weekSums[bestWeek])}`
      : 'none yet'],
    ['weekday', sum
      ? `${WEEKDAYS[topWeekday]} · ${((perWeekday[topWeekday] / sum) * 100).toFixed(0)}% of all`
      : 'none yet'],
  ].map(([k, v]) => `${pad(k, 10)}${v}`); // 10 + at most 19 of value
  side.push('', `less ${[...RAMP].join(' ')} more`);

  // 3 label + 1 space + 53 grid = 57, ' │ ' = 3, which leaves 30 for the summary
  const left = [months, ...grid].map((cells, i) =>
    `${pad(i ? WEEKDAYS[i - 1] : '', 3)} ${cells.join('')}`);
  const rows = left.map((l, i) => `${l} │ ${side[i] ?? ''}`);
  return box('a year of contributions', rows, FULL);
}

// ────────────────────────────────────────────────────────── write

export function splice(text, key, payload) {
  const start = `<!--START:${key}-->`;
  const end = `<!--END:${key}-->`;
  const pat = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pat.test(text)) {
    console.error(`  !  marker '${key}' missing, skipped`);
    return text;
  }
  return text.replace(pat, `${start}\n\`\`\`\n${payload}\n\`\`\`\n${end}`);
}

async function main() {
  if (!TOKEN) {
    console.error('GH_TOKEN / GITHUB_TOKEN not set');
    process.exit(1);
  }
  const d = await fetchProfile();
  let text = await readFile(README, 'utf8');

  for (const [key, fn] of [
    ['top', (x) => sideBySide(renderStats(x), renderRepos(x))],
    ['code', (x) => sideBySide(renderClock(x), renderLangs(x))],
    ['heat', renderHeat],
  ]) {
    try {
      text = splice(text, key, fn(d));
      console.log(`  ok  ${key}`);
    } catch (e) {
      console.error(`  !!  ${key}: ${e.message}`);
    }
  }

  await writeFile(README, text, 'utf8');
  console.log('README.md written');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
