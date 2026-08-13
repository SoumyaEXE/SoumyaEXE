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
const WIDTH = 55; // inner width of every box, keep it uniform

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
export function box(title, rows, width = WIDTH) {
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
 * chartscii emits ANSI even with color:false, and GitHub renders escapes as
 * literal junk inside a code block, so they get stripped here.
 * barSize:1 is not cosmetic: without it valueLabels makes every bar 5 rows tall.
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

const human = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k`.replace('.0k', 'k') : String(n);

export function humanBytes(n) {
  for (const [unit, step] of [['M', 1024 ** 2], ['k', 1024]]) {
    if (n >= step) {
      const v = n / step;
      return v < 100 ? `${v.toFixed(1)}${unit}` : `${v.toFixed(0)}${unit}`;
    }
  }
  return `${n}B`;
}

const pad = (s, n) => String(s).slice(0, n).padEnd(n);
const ist = (d) => new Date(d.getTime() + TZ_OFFSET); // read via getUTC* after this

// ──────────────────────────────────────────────────────── renders

export function renderStats(d) {
  const c = d.contributionsCollection;
  const repos = d.repositories.nodes;
  const stars = repos.reduce((a, r) => a + r.stargazerCount, 0);
  const forks = repos.reduce((a, r) => a + r.forkCount, 0);
  const commits = c.totalCommitContributions + c.restrictedContributionsCount;
  const [cur, longest] = streaks(c.contributionCalendar);
  const age = Math.floor((Date.now() - Date.parse(d._createdAt)) / 864e5);

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
  const rows = pairs.map(([a, av, b, bv]) =>
    `${pad(a, 14)}${av.padStart(6)}  │  ${pad(b, 14)}${bv.padStart(6)}`);
  rows.push(['sep', 'meta'], `${pad('account age', 14)}${`${age}d`.padStart(6)}`);
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
  const total = hours.reduce((a, b) => a + b, 0) || 1;

  const buckets = [
    ['morning   05-12', sum([5, 6, 7, 8, 9, 10, 11])],
    ['daytime   12-17', sum([12, 13, 14, 15, 16])],
    ['evening   17-22', sum([17, 18, 19, 20, 21])],
    ['gremlin   22-05', sum([22, 23, 0, 1, 2, 3, 4])],
  ].map(([l, n]) => [l, (n / total) * 100]);

  const wtotal = wdays.reduce((a, b) => a + b, 0) || 1;
  const byDay = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    .map((nm, i) => [nm, (wdays[i] / wtotal) * 100]);

  const opts = { width: 24, labelWidth: 15 };
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
  const peak = hours.indexOf(Math.max(...hours));
  rows.push(['sep', 'verdict'],
    `peak hour ${String(peak).padStart(2, '0')}:00 IST · sampled ${total} commits`);
  return box('when i actually commit', rows);
}

export function renderLangs(d) {
  const sizes = new Map();
  for (const r of d.repositories.nodes) {
    for (const e of r.languages.edges) {
      sizes.set(e.node.name, (sizes.get(e.node.name) ?? 0) + e.size);
    }
  }
  const total = [...sizes.values()].reduce((a, b) => a + b, 0) || 1;
  const ranked = [...sizes].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 7);
  const rest = ranked.slice(7);

  const points = top.map(([name, size]) => [name, (size / total) * 100]);
  let tail = top.map(([, size]) => humanBytes(size));
  if (rest.length) {
    const other = rest.reduce((a, [, s]) => a + s, 0);
    points.push([`+${rest.length} more`, (other / total) * 100]);
    tail.push(humanBytes(other));
  }

  const lines = bars(points, { width: 22, labelWidth: 13 });
  // last line is chartscii's baseline; the value columns only apply to bars
  const rows = lines.map((line, i) =>
    i < points.length
      ? `${line} ${points[i][1].toFixed(1).padStart(5)}% ${tail[i].padStart(6)}`
      : line);

  if (top.length) {
    const [lead, size] = top[0];
    rows.push(['sep', 'verdict'],
      `${((size / total) * 100).toFixed(0)}% ${lead.toLowerCase()} · ` +
      `${sizes.size} languages · ${humanBytes(total)} tracked`);
  }
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
  const lines = bars(top, { width: 22, labelWidth: 14, max: top[0][1] });
  const rows = lines.map((line, i) =>
    i < top.length ? `${line} ${String(top[i][1]).padStart(6)}` : line);

  const counted = repos.reduce((a, [, n]) => a + n, 0);
  rows.push(['sep', 'verdict'],
    `${repos.length} repos touched · ${counted.toLocaleString('en-US')} commits by me`);
  return box('where the commits went', rows);
}

export function renderFooter() {
  const now = ist(new Date());
  const stamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
  return box('build info', [
    `${pad('generated', 12)} ${stamp} IST`,
    `${pad('by', 12)} .github/scripts/update_profile.mjs`,
    `${pad('cadence', 12)} every 6 hours, via github actions cron`,
  ]);
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
    ['stats', renderStats], ['clock', renderClock], ['langs', renderLangs],
    ['repos', renderRepos], ['footer', renderFooter],
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
