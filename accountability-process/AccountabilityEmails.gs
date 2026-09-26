/**
 * Collections & Recovery – Performance Accountability Emails
 *
 * Lives inside the existing rankings Google Sheet (Extensions > Apps Script).
 * Reads weekly / monthly results from the sheet, works out who has missed
 * target how many times in a row, and sends the right email automatically.
 *
 * Tabs this script expects (first row = headers, exactly as written):
 *   Settings            : Setting | Value
 *   Contacts            : Emp ID | Name | Role | City | Email | TL Email | Manager Email | HR Email | Status
 *   Weekly Results      : Week Start | Emp ID | Target Met        (Yes / No / Excused)
 *   TL Weekly Ranking   : Week Start | Emp ID | Pan-India Rank | In Bottom   (Yes / No)
 *   TL Monthly Ranking  : Month | Emp ID | Pan-India Rank | In Bottom       (Yes / No)
 *   Email Log           : Sent At | Key | Emp ID | Stage | To | CC | Subject   (filled by the script)
 *
 * One-time setup: fill the tabs, keep Settings > Dry Run = TRUE, run setupTriggers() once.
 * After 2 good test weeks, set Dry Run = FALSE to go live.
 */

const TABS = {
  settings: 'Settings',
  contacts: 'Contacts',
  weekly: 'Weekly Results',
  tlWeekly: 'TL Weekly Ranking',
  tlMonthly: 'TL Monthly Ranking',
  log: 'Email Log',
};

// ---------- Email wording ----------
// {name} {weeks} {period} {rank} {tl} are filled in automatically.

const TEMPLATES = {
  WARNING: {
    subject: 'Performance Warning – target missed for {weeks} weeks in a row',
    body:
      'Dear {name},\n\n' +
      'Our records show that you have not achieved your weekly target for the last {weeks} weeks in a row (latest week starting {period}).\n\n' +
      'This is a formal warning. Please speak to your Team Lead this week to agree on a plan to get back on track. ' +
      'Your Team Lead and Manager are copied and will support you.\n\n' +
      'Please note: if the target is missed for 4 weeks in a row, it will lead to separation from the company.\n\n' +
      'Regards,\nCollections & Recovery Management',
  },
  FINAL_WARNING: {
    subject: 'FINAL WARNING – target missed for {weeks} weeks in a row',
    body:
      'Dear {name},\n\n' +
      'You have not achieved your weekly target for {weeks} weeks in a row (latest week starting {period}).\n\n' +
      'This is your final warning. If the target is not achieved in the coming week, your employment will end as per company policy.\n\n' +
      'Manager: if there is a valid reason (approved leave, system issue, wrong data), please mark this person as "On Hold" in the Contacts tab before next Monday.\n\n' +
      'Regards,\nCollections & Recovery Management',
  },
  EXIT: {
    subject: 'Separation Notice – target missed for {weeks} weeks in a row',
    body:
      'Dear {name},\n\n' +
      'Despite the earlier warning and final warning, the weekly target has not been achieved for {weeks} weeks in a row (latest week starting {period}).\n\n' +
      'As per the company performance policy, we will not be able to continue your employment. ' +
      'HR will contact you with the next steps, including the full and final settlement.\n\n' +
      'We thank you for your contribution and wish you the best.\n\n' +
      'Regards,\nCollections & Recovery Management',
  },
  TL_WEEKLY_ALERT: {
    subject: 'Manager Alert – {tl} in bottom of Pan-India TL ranking for {weeks} weeks',
    body:
      'Dear Manager,\n\n' +
      'Team Lead {tl} has been in the bottom of the Pan-India Team Lead ranking for {weeks} weeks in a row ' +
      '(latest week starting {period}, rank {rank}).\n\n' +
      'Please review the team\'s performance with the Team Lead this week and agree on corrective steps.\n\n' +
      'Regards,\nCollections & Recovery Management',
  },
  TL_LOW_PERFORMANCE: {
    subject: 'Low Performance – {tl} in bottom of Pan-India TL ranking for {weeks} months',
    body:
      'Dear {name},\n\n' +
      'Your team has been in the bottom of the Pan-India Team Lead ranking for {weeks} months in a row ' +
      '(latest month {period}, rank {rank}).\n\n' +
      'Senior management is copied on this email. Please share a written improvement plan with your Manager within 3 working days.\n\n' +
      'Regards,\nCollections & Recovery Management',
  },
  TL_ESCALATION: {
    subject: 'ESCALATION – {tl} in bottom of Pan-India TL ranking for {weeks} months',
    body:
      'Dear {name},\n\n' +
      'Your team has been in the bottom of the Pan-India Team Lead ranking for {weeks} months in a row ' +
      '(latest month {period}, rank {rank}).\n\n' +
      'This has been escalated to leadership. A formal review of your role will be scheduled by your Manager and HR.\n\n' +
      'Regards,\nCollections & Recovery Management',
  },
};

// ---------- Scheduled jobs ----------

/** Every Monday: callers and bikers (warning / final warning / exit) + TL weekly alert to manager. */
function runWeeklyChecks() {
  const s = getSettings_();
  const people = getContacts_();
  const sent = getLoggedKeys_();

  // Callers & Bikers
  const results = readTab_(TABS.weekly).filter(r => !isValue_(r['Target Met'], 'excused'));
  const stageFor = {};
  stageFor[Number(s['Warning After Weeks'])] = 'WARNING';
  stageFor[Number(s['Final Warning After Weeks'])] = 'FINAL_WARNING';
  stageFor[Number(s['Exit After Weeks'])] = 'EXIT';

  forEachCurrentStreak_(results, 'Week Start', r => isValue_(r['Target Met'], 'no'), (id, weeks, period) => {
    const stage = stageFor[weeks];
    const p = people[id];
    if (!stage || !p || !isActive_(p)) return;
    const cc = [p['TL Email'], p['Manager Email']];
    if (stage !== 'WARNING') cc.push(p['HR Email']);
    if (stage === 'EXIT') cc.push(s['GM Email']);
    send_(s, sent, id, stage, period, p['Email'], cc, { name: p['Name'], weeks: weeks, period: fmt_(period) });
  });

  // Team Leads – 2 weeks in a row in the bottom -> email to their Manager
  const tlWeeks = Number(s['TL Manager Alert After Weeks']);
  forEachCurrentStreak_(readTab_(TABS.tlWeekly), 'Week Start', r => isValue_(r['In Bottom'], 'yes'), (id, weeks, period, row) => {
    const p = people[id];
    if (weeks !== tlWeeks || !p || !isActive_(p)) return;
    const manager = p['Manager Email'] || s['GM Email']; // no manager assigned -> GM
    send_(s, sent, id, 'TL_WEEKLY_ALERT', period, manager, [s['GM Email']],
      { name: p['Name'], tl: p['Name'], weeks: weeks, period: fmt_(period), rank: row['Pan-India Rank'] });
  });
}

/** Early each month: Team Leads in the bottom for 2 / 3 months in a row. */
function runMonthlyTLChecks() {
  const s = getSettings_();
  const people = getContacts_();
  const sent = getLoggedKeys_();
  const lowAfter = Number(s['TL Low Performance After Months']);
  const escalateAfter = Number(s['TL Escalation After Months']);

  forEachCurrentStreak_(readTab_(TABS.tlMonthly), 'Month', r => isValue_(r['In Bottom'], 'yes'), (id, months, period, row) => {
    const p = people[id];
    if (!p || !isActive_(p)) return;
    let stage = null;
    if (months === lowAfter) stage = 'TL_LOW_PERFORMANCE';
    if (months === escalateAfter) stage = 'TL_ESCALATION';
    if (!stage) return;
    const cc = [p['Manager Email'], s['GM Email'], s['Upper Management Emails']];
    if (stage === 'TL_ESCALATION') cc.push(s['Leadership Emails'], p['HR Email']);
    send_(s, sent, id, stage, period, p['Email'], cc,
      { name: p['Name'], tl: p['Name'], weeks: months, period: fmtMonth_(period), rank: row['Pan-India Rank'] });
  });
}

/** Run once by hand to schedule the two jobs above. */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runWeeklyChecks').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(11).create();
  ScriptApp.newTrigger('runMonthlyTLChecks').timeBased().onMonthDay(3).atHour(11).create();
}

// ---------- Helpers ----------

/**
 * For each person, counts how many periods in a row they "missed", ending at the
 * latest period in the tab. People with no row for the latest period are skipped.
 */
function forEachCurrentStreak_(rows, periodKey, missed, callback) {
  if (!rows.length) return;
  const latest = Math.max.apply(null, rows.map(r => new Date(r[periodKey]).getTime()));
  const byId = {};
  rows.forEach(r => {
    const id = String(r['Emp ID']).trim();
    (byId[id] = byId[id] || []).push(r);
  });
  Object.keys(byId).forEach(id => {
    const list = byId[id].sort((a, b) => new Date(a[periodKey]) - new Date(b[periodKey]));
    const last = list[list.length - 1];
    if (new Date(last[periodKey]).getTime() !== latest) return;
    let streak = 0;
    for (let i = list.length - 1; i >= 0 && missed(list[i]); i--) streak++;
    if (streak > 0) callback(id, streak, new Date(last[periodKey]), last);
  });
}

function send_(s, sent, id, stage, period, to, ccList, vars) {
  const key = [id, stage, fmt_(period)].join('|');
  if (sent.has(key) || !to) return; // never send the same email twice
  const t = TEMPLATES[stage];
  let subject = fill_(t.subject, vars);
  let body = fill_(t.body, vars);
  let cc = ccList.join(',').split(',').map(e => e.trim())
    .filter((e, i, all) => e && e !== to && all.indexOf(e) === i).join(',');

  const dryRun = String(s['Dry Run']).toUpperCase() !== 'FALSE';
  if (dryRun) { // test mode: everything goes only to the GM
    body = '[TEST MODE – would have gone to: ' + to + (cc ? ' | cc: ' + cc : '') + ']\n\n' + body;
    subject = '[TEST] ' + subject;
    to = s['GM Email'];
    cc = '';
  }
  GmailApp.sendEmail(to, subject, body, { cc: cc, name: s['Sender Name'] || 'Collections Performance' });
  sheet_(TABS.log).appendRow([new Date(), key, id, stage, to, cc, subject]);
  sent.add(key);
}

function getSettings_() {
  const s = {};
  sheet_(TABS.settings).getDataRange().getValues().slice(1).forEach(r => {
    if (r[0] !== '') s[String(r[0]).trim()] = r[1];
  });
  return s;
}

function getContacts_() {
  const map = {};
  readTab_(TABS.contacts).forEach(c => { map[String(c['Emp ID']).trim()] = c; });
  return map;
}

function getLoggedKeys_() {
  return new Set(readTab_(TABS.log).map(r => String(r['Key'])));
}

function readTab_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const head = values.shift().map(h => String(h).trim());
  return values
    .filter(r => r.some(c => c !== ''))
    .map(r => {
      const o = {};
      head.forEach((h, i) => { o[h] = r[i]; });
      return o;
    });
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name);
  return sh;
}

function isActive_(p) {
  const status = String(p['Status'] || '').trim().toLowerCase();
  return status === '' || status === 'active';
}

function isValue_(v, expected) {
  return String(v).trim().toLowerCase() === expected;
}

function fill_(text, vars) {
  return text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

function fmt_(d) {
  return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'dd-MMM-yyyy');
}

function fmtMonth_(d) {
  return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'MMM yyyy');
}
