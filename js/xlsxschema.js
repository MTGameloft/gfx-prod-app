/**
 * What the Excel files look like.
 *
 * This is the ONLY place the column layout is described. Both directions read
 * it: `buildWorkbook()` writes these headers, `readWorkbook()` expects them.
 * Anything else would drift the moment one side changed, and a template whose
 * columns no longer match the importer is worse than no template at all.
 *
 * Rules the rest of the code relies on:
 *
 *  - Column `ID` holds the internal record id. Blank means "this is a new
 *    record"; filled means "update this one". That is what lets you rename a
 *    person in Excel without the app treating them as a different person.
 *  - Fields NOT listed on a sheet are never touched by importing that sheet.
 *    Deliberate: the People sheet has no Allocations column, so importing it
 *    cannot wipe anyone's project split.
 *  - `t: 'derived'` and `t: 'formula'` columns are written for readability and
 *    ignored on read.
 *
 * FOUR FILES, AND WHY
 *
 * There were nine. Everything about a person now lives in `01_People.xlsx`,
 * because the question being answered is almost always "what is going on with
 * this one person", and that should not mean opening four files.
 *
 * What could not be collapsed further: goals, 1:1 notes, leave and project
 * splits are all one-to-many. A person with four goals cannot be one row
 * without inventing Goal1..Goal4 columns, which caps the count and cannot hold
 * a milestone. So they stay separate sheets — but nothing on them has to be
 * typed twice:
 *
 *  - every one names its person in a `Person` drop-down, not an id;
 *  - the person's Division and Role appear on the row by formula;
 *  - the People sheet carries formula columns summarising each person's goals,
 *    open actions and booked leave, so the overview needs no other tab.
 */

import {
  STATUSES, PRIORITIES, LEAVE_TYPES, VENDOR_STATUS, RATE_MODELS, BATCH_STATUS,
  SENIORITY, CONTRACT, GOAL_CATEGORY, GOAL_STATUS, MOODS,
} from './calc.js';
import { wbDivisions, WB_APPROACHES, WB_COMPLEXITY } from './wb.js';

/*
 * The allowed values.
 *
 * Taken from `calc.js` wherever it already owns the list, because a schema that
 * restates a vocabulary drifts from it. The first round-trip test of this file
 * failed on exactly that: hand-written enums rejected the app's own data —
 * `day-rate`, `discovery`, `critical` and `outsource` were all real values my
 * guesses did not include.
 *
 * The four lists below have no single owner in the codebase yet; each one names
 * the view that defines it, so there is somewhere to look when it changes.
 */
const ids = list => list.map(x => x.id);

// SENIORITY, CONTRACT and MOODS are imported from calc.js above.

/* The work-breakdown vocabularies, from the module that owns the maths. */
/* A function, not an array: the divisions are the roster's now, so this must
   be read when it is used rather than when this module loaded. */
const WB_DIV_IDS      = () => wbDivisions().map(d => d.id);
const WB_APPROACH_IDS = WB_APPROACHES.map(a => a.id);
const WB_CX_IDS       = WB_COMPLEXITY.map(c => c.id);
const WB_EST_STATUS   = ['draft', 'quoted', 'approved', 'done', 'dropped'];   // views/gfxwb.js

const P_STATUS  = ['discovery', 'production', 'live', 'paused', 'archived'];  // views/projects.js
const MS_STATUS = ['planned', 'at-risk', 'done', 'slipped'];                  // views/projects.js
const O_STATUS  = ['on-track', 'at-risk', 'off-track', 'done', 'dropped'];    // views/objectives.js
const BUDGET_T  = ['internal', 'outsource', 'license', 'hardware', 'other'];  // views/finance.js

/* ---------- drop-down vocabularies -------------------------------------- */

/**
 * The lists behind the `_Data` sheet and the Excel drop-downs.
 *
 * `_Data` is written once per export and every drop-down points at a column of
 * it, so the vocabulary in the file is always the app's own — you cannot type
 * `2D Art` into a Division cell and discover on import that the division is
 * called `2D`.
 *
 * `strict` is the difference between a rule and a hint. A Division, Person or
 * Project that is not in the list cannot be imported, so Excel refuses it at
 * the point of typing — that is a kindness, not an obstruction. Role is the
 * opposite: it is free text in the app and a new one is a normal thing to
 * invent, so its drop-down suggests and does not enforce.
 */
const uniq = xs => [...new Set(xs.map(v => String(v ?? '').trim()).filter(Boolean))].sort();

export const VOCAB = {
  Division:     { strict: true,  of: s => (s.divisions || []).map(d => d.id).filter(Boolean) },
  Person:       { strict: true,  of: s => uniq((s.people || []).map(p => p.name)) },
  Project:      { strict: true,  of: s => uniq((s.projects || []).map(p => p.code)) },
  Role:         { strict: false, of: s => uniq((s.people || []).map(p => p.role)) },
  Seniority:    { strict: true,  of: () => SENIORITY },
  Contract:     { strict: true,  of: () => CONTRACT },
  GoalCategory: { strict: true,  of: () => ids(GOAL_CATEGORY) },
  GoalStatus:   { strict: true,  of: () => ids(GOAL_STATUS) },
  LeaveType:    { strict: true,  of: () => ids(LEAVE_TYPES) },
  Mood:         { strict: true,  of: () => ids(MOODS) },
  Half:         { strict: false, of: () => ['am', 'pm'] },
  VendorStatus: { strict: true,  of: () => ids(VENDOR_STATUS) },
  RateModel:    { strict: true,  of: () => ids(RATE_MODELS) },
  BatchStatus:  { strict: true,  of: () => ids(BATCH_STATUS) },
  TaskStatus:   { strict: true,  of: () => ids(STATUSES) },
  TaskPriority: { strict: true,  of: () => ids(PRIORITIES) },
  ProjectStatus:{ strict: true,  of: () => P_STATUS },
  Health:       { strict: true,  of: () => ['green', 'amber', 'red'] },
  MilestoneStat:{ strict: true,  of: () => MS_STATUS },
  ObjectiveStat:{ strict: true,  of: () => O_STATUS },
  BudgetType:   { strict: true,  of: () => BUDGET_T },
  Vendor:       { strict: true,  of: s => uniq((s.vendors || []).map(v => v.name)) },
  /* Not strict: a task may name an objective that is about to be created on
     the Objectives sheet of the same file. */
  Objective:    { strict: false, of: s => uniq((s.objectives || []).map(o => o.title)) },

  /* The work breakdown uses the roster's divisions now, so `Division` above is
     the same list — there is no separate `WbDivision` to drift from it. */
  WbApproach:   { strict: true,  of: () => WB_APPROACHES.map(a => a.id) },
  WbComplexity: { strict: true,  of: () => WB_COMPLEXITY.map(c => c.id) },
  WbEstStatus:  { strict: true,  of: () => WB_EST_STATUS },
  /* Not strict: a line may name an estimate the same file is about to create. */
  WbEstimate:   { strict: false, of: s => uniq((s.wbEstimates || []).map(e => e.name)) },
};

/** The values behind one drop-down, in the order they appear in `_Data`. */
export const vocabList = (name, state) => {
  const v = VOCAB[name];
  if (!v) return [];
  try { return v.of(state || {}).map(String).filter(Boolean); } catch { return []; }
};

/** Which vocabularies a workbook's sheets actually reference. */
export function vocabsUsed(wbId, state = null) {
  const seen = [];
  for (const s of sheetsOf(wbId, state)) {
    for (const col of s.cols || []) {
      if (col.dv && VOCAB[col.dv] && !seen.includes(col.dv)) seen.push(col.dv);
    }
  }
  return seen;
}

/* ---------- workbooks ---------------------------------------------------- */

/*
 * Sheet order is the tab order in Excel, and the first one is what opens.
 * `People` is deliberately first and `READ ME` deliberately last: the readme
 * is for the first hour and the roster is for every hour after it.
 */
export const WORKBOOKS = [
  { id: 'people', file: '01_People.xlsx', title: 'People',
    sheets: ['People', 'Allocations', 'Goals', 'GoalMilestones',
             'OneToOnes', 'OneToOneActions', 'Leave', 'Skills', 'Divisions'],
    blurb: 'Everything about everyone: the roster, project splits, goals and their milestones, 1:1 notes and the actions agreed in them, booked leave, and the skill matrix.' },

  { id: 'outsourcing', file: '02_Outsourcing.xlsx', title: 'Outsourcing',
    sheets: ['Vendors', 'Batches'],
    blurb: 'External studios and freelancers, and every batch of work sent to them.' },

  { id: 'finance', file: '03_Projects_Finance.xlsx', title: 'Projects & Finance',
    sheets: ['Projects', 'Milestones', 'Budget_Plan', 'Budget_Actual', 'RateCard', 'Holidays',
             'WB_Items', 'WB_Estimates', 'WB_Lines'],
    blurb: 'Projects, their milestones, the month-by-month budget planned against actual, the rate card, the public-holiday calendar, and the GFX work-breakdown catalogue with its estimates.' },

  { id: 'work', file: '04_Tasks_Objectives.xlsx', title: 'Tasks & Objectives',
    sheets: ['Tasks', 'Objectives', 'KeyResults', 'JiraProjects', 'JiraImports'],
    blurb: 'The task board, the quarterly objectives with their key results, and a log of every task filed into Jira.' },
];

/** Every workbook, in display order. */
export function allWorkbooks() { return WORKBOOKS; }

/**
 * Filenames the app used to export, and where their contents went.
 *
 * Recognised by name so an old file lying in the folder is named as old rather
 * than guessed at. Without this a stale `04_Leave.xlsx` matches one sheet in
 * `01_People.xlsx` (Leave) and one in `03_Projects_Finance.xlsx` (Holidays),
 * so the guess is a coin flip — and the losing side silently skips half the
 * file.
 */
export const RETIRED_FILES = {
  '04_Leave': 'Leave moved into 01_People.xlsx and Holidays into 03_Projects_Finance.xlsx.',
  '05_Tasks_Objectives': 'Renamed to 04_Tasks_Objectives.xlsx — the sheets are unchanged.',
  '06_Goals': 'Goals and GoalMilestones moved into 01_People.xlsx.',
  '06_RateCard_new_ladder': 'The rate card lives on the RateCard sheet of 03_Projects_Finance.xlsx.',
};

/** Was this filename one of ours, before the workbooks were consolidated? */
export function retiredFile(fileName) {
  const base = String(fileName).replace(/\.xls[xm]$/i, '').replace(/ \(\d+\)$/, '');
  if (RETIRED_FILES[base]) return { base, why: RETIRED_FILES[base] };
  if (/^1on1_[A-Za-z0-9_-]{1,24}$/.test(base)) {
    return { base, why: 'The 1:1 notes for every division are now on the OneToOnes sheet of 01_People.xlsx.' };
  }
  return null;
}

/**
 * Does this record belong in a scoped workbook?
 *
 * Nothing is scoped now that the 1:1 notes live in one file rather than one
 * file per division, but the engine still asks, so the answer is yes.
 */
export function inScope(scope, rec, state, spec) {
  if (!scope || !scope.division) return true;
  const pid = rec[spec?.scopeBy || 'personId'];
  const person = (state.people || []).find(x => x.id === pid);
  return !!person && person.division === scope.division;
}

/* ---------- sheets ------------------------------------------------------- */

const c = (h, f, t = 'text', extra = {}) => ({ h, f, t, ...extra });

/*
 * Formula columns.
 *
 * `fx` is handed the Excel row number and a small kit, and returns a formula
 * body without the leading `=`. The kit resolves ranges from this schema
 * rather than from letters typed by hand, so inserting a column above does not
 * silently point a VLOOKUP at the wrong field:
 *
 *   F.me('Name')                      -> '$B'        (this sheet, absolute col)
 *   F.at('Goals', 'Weight')           -> 'Goals!$E$2:$E$41'
 *   F.lookup('$B2', 'People', 'Name', 'Division')
 *                                     -> 'IFERROR(VLOOKUP($B2,People!$B$2:$D$41,3,FALSE),"")'
 *
 * Ranges are bounded to the rows that exist rather than whole columns, because
 * SUMPRODUCT over a blank row is an error, not a zero.
 */
const fill = (from, field, label) =>
  c(label || field, null, 'formula', {
    fx: (r, F) => F.lookup(`${F.me('Person')}${r}`, from, 'Name', field),
    doc: `Filled in automatically from the ${from} sheet once Person is set.`,
  });

export const SHEETS = {

  /* ---- people ---------------------------------------------------------- */

  People: {
    coll: 'people', match: ['email', 'name'], label: 'name',
    note: 'One row per person, and the sheet to start from. Leave ID blank to add someone new. The last four columns are calculated — they summarise the Goals, OneToOneActions and Leave sheets so you can see whether someone is set up correctly without leaving this tab.',
    cols: [
      c('ID', 'id', 'id'),
      c('Name', 'name', 'text', { req: true }),
      c('Email', 'email'),
      c('Division', 'division', 'ref:divisions', { dv: 'Division' }),
      c('Role', 'role', 'text', { dv: 'Role' }),
      c('Seniority', 'seniority', 'text', { enum: SENIORITY, dv: 'Seniority' }),
      c('Contract', 'contract', 'text', { enum: CONTRACT, dv: 'Contract' }),
      c('CostMonthly', 'costMonthly', 'num'),
      c('Active', 'active', 'bool'),
      c('Location', 'location'),
      c('StartDate', 'startDate', 'date'),
      c('Manager', 'manager', 'ref:people', { dv: 'Person' }),
      c('CapacityPct', 'capacity', 'num'),
      c('LeaveAllowance', 'leaveAllowance', 'num'),
      c('Notes', 'notes', 'rich'),

      /* Calculated. The point of these is that the roster answers "is this
         person's review set up" on its own — a weight total that is not 100
         is the single most common thing wrong, and it used to need a second
         file open beside this one. */
      c('Goals#', null, 'formula', {
        fx: (r, F) => `COUNTIFS(${F.at('Goals', 'Person')},${F.me('Name')}${r})`,
        doc: 'How many goals this person has on the Goals sheet.' }),
      c('Weight%', null, 'formula', {
        fx: (r, F) => `IF(COUNTIFS(${F.at('Goals', 'Person')},${F.me('Name')}${r})=0,"",`
          + `SUMIFS(${F.at('Goals', 'Weight')},${F.at('Goals', 'Person')},${F.me('Name')}${r},`
          + `${F.at('Goals', 'Status')},"<>dropped"))`,
        doc: 'Total weight of the goals that still count. Should be 100.' }),
      c('OpenActions', null, 'formula', {
        fx: (r, F) => `COUNTIFS(${F.at('OneToOneActions', 'Person')},${F.me('Name')}${r})`
          + `-COUNTIFS(${F.at('OneToOneActions', 'Person')},${F.me('Name')}${r},`
          + `${F.at('OneToOneActions', 'Done')},TRUE)`,
        doc: 'Actions agreed in a 1:1 and not yet ticked off.' }),
      c('LeaveDays', null, 'formula', {
        fx: (r, F) => `SUMPRODUCT((${F.at('Leave', 'Person')}=${F.me('Name')}${r})`
          + `*(${F.at('Leave', 'To')}-${F.at('Leave', 'From')}+1))`,
        doc: 'Days of leave booked on the Leave sheet, counting From and To inclusively.' }),
    ],
  },

  Allocations: {
    child: { parent: 'people', field: 'alloc', by: 'Person', kind: 'array', byRef: 'people' },
    note: 'How each person is split across projects. This is the sheet to edit when someone switches project. Percentages should total about 100 per person. Importing replaces the whole split for every person who appears here and leaves everyone else untouched.',
    cols: [
      c('Person', '@parent', 'parent', { ref: 'people', dv: 'Person' }),
      c('ProjectCode', 'projectId', 'ref:projects', { req: true, dv: 'Project' }),
      c('Percent', 'pct', 'num'),
      fill('People', 'Division'),
    ],
  },

  Goals: {
    coll: 'goals', match: ['@composite'], composite: ['personId', 'title'], label: 'title',
    note: 'One row per objective per person. Category is what kind of objective it is; Weight is how much of the review it carries and should total 100 per person across the goals that still count. Milestones live on the next sheet and are joined by Person and Goal, so there is no id to copy.',
    cols: [
      c('ID', 'id', 'id'),
      c('Person', 'personId', 'ref:people', { req: true, dv: 'Person' }),
      c('Goal', 'title', 'text', { req: true }),
      c('Category', 'category', 'text', { enum: ids(GOAL_CATEGORY), dv: 'GoalCategory' }),
      c('Weight', 'weight', 'num'),
      c('Status', 'status', 'text', { enum: ids(GOAL_STATUS), dv: 'GoalStatus' }),
      c('TargetDate', 'due', 'date'),
      c('Notes', 'notes', 'rich'),
      fill('People', 'Division'),
      c('Milestones', null, 'formula', {
        fx: (r, F) => `COUNTIFS(${F.at('GoalMilestones', 'Person')},${F.me('Person')}${r},`
          + `${F.at('GoalMilestones', 'Goal')},${F.me('Goal')}${r})`,
        doc: 'How many milestones on the next sheet belong to this goal.' }),
    ],
  },

  GoalMilestones: {
    child: {
      parent: 'goals', field: 'milestones', kind: 'array',
      /* Joined on the two columns that identify a goal to a human. The old
         version wanted a GoalID copied across from the Goals sheet, which
         meant exporting once before a milestone could be added at all. */
      pk: [{ h: 'Person', f: 'personId', ref: 'people' }, { h: 'Goal', f: 'title' }],
    },
    note: 'Steps under a goal. Pick the Person and copy the Goal text exactly as it appears on the Goals sheet — both drop-downs help. Importing replaces the whole milestone list for every goal that appears here and leaves the rest alone. Progress on the Goals tab in the app is the share of these ticked.',
    cols: [
      c('Person', '@pk:personId', 'parent', { ref: 'people', dv: 'Person' }),
      c('Goal', '@pk:title', 'parent'),
      c('ID', 'id', 'text'),
      c('Milestone', 'text', 'text', { req: true }),
      c('Due', 'due', 'date'),
      c('Done', 'done', 'bool'),
    ],
  },

  OneToOnes: {
    coll: 'oneToOnes', match: ['@composite'], composite: ['personId', 'date'], label: 'date',
    note: 'One row per 1:1, everyone in one sheet — filter by Division to get one team. Notes keep their formatting in the app; this cell is the plain-text version, and editing it replaces the note. The actions agreed are on the next sheet, joined by Person and Date.',
    cols: [
      c('ID', 'id', 'id'),
      c('Person', 'personId', 'ref:people', { req: true, dv: 'Person' }),
      c('Date', 'date', 'date', { req: true }),
      c('Mood', 'mood', 'text', { enum: ids(MOODS), dv: 'Mood' }),
      c('Notes', 'notes', 'rich'),
      fill('People', 'Division'),
      c('Actions', null, 'formula', {
        fx: (r, F) => `COUNTIFS(${F.at('OneToOneActions', 'Person')},${F.me('Person')}${r},`
          + `${F.at('OneToOneActions', 'Date')},${F.me('Date')}${r})`,
        doc: 'How many actions on the next sheet were agreed in this 1:1.' }),
    ],
  },

  OneToOneActions: {
    child: {
      parent: 'oneToOnes', field: 'actions', kind: 'array',
      pk: [{ h: 'Person', f: 'personId', ref: 'people' }, { h: 'Date', f: 'date', t: 'date' }],
    },
    note: 'The actions agreed in a 1:1. Person and Date must match a row on the OneToOnes sheet. An action stays on that person’s Overview in the app until Done is TRUE.',
    cols: [
      c('Person', '@pk:personId', 'parent', { ref: 'people', dv: 'Person' }),
      c('Date', '@pk:date', 'parent', { t2: 'date' }),
      c('Action', 't', 'text', { req: true }),
      c('Done', 'done', 'bool'),
    ],
  },

  Leave: {
    coll: 'leave', match: ['@composite'], composite: ['personId', 'from'], label: 'from',
    note: 'One row per booking. From and To are inclusive, so a single day has the same date in both. Half is blank, am or pm. The LeaveDays column on the People sheet totals this.',
    cols: [
      c('ID', 'id', 'id'),
      c('Person', 'personId', 'ref:people', { req: true, dv: 'Person' }),
      c('Type', 'type', 'text', { enum: ids(LEAVE_TYPES), dv: 'LeaveType' }),
      c('From', 'from', 'date', { req: true }),
      c('To', 'to', 'date', { req: true }),
      c('Half', 'half', 'text', { enum: ['', 'am', 'pm'], dv: 'Half' }),
      c('Note', 'note'),
      fill('People', 'Division'),
    ],
  },

  Skills: {
    child: { parent: 'people', field: 'skills', by: 'Person', kind: 'map', k: 'Skill', v: 'Level', byRef: 'people' },
    note: 'Skill matrix, 1 to 5. One row per person per skill.',
    cols: [
      c('Person', '@parent', 'parent', { ref: 'people', dv: 'Person' }),
      c('Skill', '@key', 'text', { req: true }),
      c('Level', '@val', 'num'),
    ],
  },

  Divisions: {
    coll: 'divisions', match: ['id', 'name'], label: 'name',
    note: 'The art divisions. ID is what the People and Batches sheets refer to a division by, so keep it short and stable: 2D, 3D, ANIM, VFX, UIUX, PROD. Changing an ID here does not re-point the rows that used it.',
    cols: [
      c('ID', 'id', 'id'),
      c('Name', 'name', 'text', { req: true }),
      c('Color', 'color'),
      c('JiraLabel', 'jiraLabel', 'text', {
        doc: 'The Jira label every task in this division is filed with — 2D, Anim, GFX-Prod. Leave it blank for a division that should add no label. Jira labels cannot contain spaces.' }),
      c('Lead', 'lead', 'ref:people', { dv: 'Person' }),
      c('Headcount', null, 'formula', {
        fx: (r, F) => `COUNTIFS(${F.at('People', 'Division')},${F.me('ID')}${r})`,
        doc: 'How many people on the People sheet are in this division.' }),
    ],
  },

  /* ---- outsourcing ----------------------------------------------------- */

  Vendors: {
    coll: 'vendors', match: ['name'], label: 'name',
    note: 'External studios. A studio Name here must match the Vendor column on the Budget sheets for spend to link up; the app flags any budget line naming a studio that is not listed here. Quality, OnTime and Comms are 1 to 5.',
    cols: [
      c('ID', 'id', 'id'),
      c('Name', 'name', 'text', { req: true }),
      c('Country', 'country'),
      c('Status', 'status', 'text', { enum: ids(VENDOR_STATUS), dv: 'VendorStatus' }),
      c('Specialisms', 'specialisms', 'list'),
      c('ContactName', 'contactName'),
      c('ContactEmail', 'contactEmail'),
      c('RateModel', 'rateModel', 'text', { enum: ids(RATE_MODELS), dv: 'RateModel' }),
      c('RateValue', 'rateValue', 'num'),
      c('Currency', 'currency'),
      c('NDASigned', 'ndaSigned', 'bool'),
      c('MSASigned', 'msaSigned', 'bool'),
      c('Quality', 'quality', 'num'),
      c('OnTime', 'onTime', 'num'),
      c('Comms', 'comms', 'num'),
      c('Notes', 'notes', 'rich'),
    ],
  },

  Batches: {
    coll: 'outsourceBatches', match: ['poNumber', 'title'], label: 'title',
    note: 'One row per batch of outsourced work. Vendor is a studio Name, ProjectCode a project Code. On-time performance is computed from DeliveredOn against DueOn, so those two are worth keeping current.',
    cols: [
      c('ID', 'id', 'id'),
      c('Vendor', 'vendorId', 'ref:vendors', { req: true, dv: 'Vendor' }),
      c('ProjectCode', 'projectId', 'ref:projects', { dv: 'Project' }),
      c('Division', 'division', 'ref:divisions', { dv: 'Division' }),
      c('Title', 'title', 'text', { req: true }),
      c('Qty', 'qty', 'num'),
      c('Unit', 'unit'),
      c('AgreedCost', 'agreedCost', 'num'),
      c('Currency', 'currency'),
      c('PONumber', 'poNumber'),
      c('BriefedOn', 'briefedOn', 'date'),
      c('DueOn', 'dueOn', 'date'),
      c('DeliveredOn', 'deliveredOn', 'date'),
      c('AcceptedOn', 'acceptedOn', 'date'),
      c('Status', 'status', 'text', { enum: ids(BATCH_STATUS), dv: 'BatchStatus' }),
      c('Revisions', 'revisions', 'num'),
      c('Notes', 'notes', 'rich'),
    ],
  },

  /* ---- projects & finance ---------------------------------------------- */

  Projects: {
    coll: 'projects', match: ['code', 'name'], label: 'code',
    note: 'Code is what every other sheet refers to a project by. Changing a Code here renames the reference everywhere, as long as the ID stays put.',
    cols: [
      c('ID', 'id', 'id'),
      c('Code', 'code', 'text', { req: true }),
      c('Name', 'name', 'text', { req: true }),
      c('Status', 'status', 'text', { enum: P_STATUS, dv: 'ProjectStatus' }),
      c('Phase', 'phase'),
      c('Start', 'start', 'date'),
      c('End', 'end', 'date'),
      c('Color', 'color'),
      c('JiraKey', 'jiraKey'),
      /* The epic this project's tasks are filed under. Blank falls back to the
         Jira project's own GFX epic, which is where it normally comes from. */
      c('JiraEpic', 'jiraEpic'),
      c('Budget', 'budget', 'num'),
      c('Currency', 'currency'),
      c('Health', 'health', 'text', { enum: ['green', 'amber', 'red'], dv: 'Health' }),
      /* Ties a project to one division, which is what GFX Prod is: the
         production work as a project, drawing on the GFX Prod division. Its
         Overview then also shows that division's work sitting on the other
         projects. Blank for an ordinary project that spans every division. */
      c('Division', 'divisionId', 'ref:divisions', { dv: 'Division',
        doc: 'Set this to tie the project to one division — GFX Prod is PROD. Its Overview then also lists that division\'s tasks on other projects. Leave blank for a project that spans divisions.' }),
      c('ProducerLead', 'producerLead', 'ref:people', { dv: 'Person' }),
      c('SharePointUrl', 'sharepointUrl'),
      c('Description', 'description', 'rich'),
    ],
  },

  Milestones: {
    child: { parent: 'projects', field: 'milestones', by: 'ProjectCode', kind: 'array', byRef: 'projects' },
    note: 'Feeds the dashboard timeline. Importing replaces the milestone list for every project that appears here.',
    cols: [
      c('ProjectCode', '@parent', 'parent', { ref: 'projects', dv: 'Project' }),
      c('ID', 'id', 'text'),
      c('Name', 'name', 'text', { req: true }),
      c('Date', 'date', 'date', { req: true }),
      c('Status', 'status', 'text', { enum: MS_STATUS, dv: 'MilestoneStat' }),
      c('Owner', 'owner', 'ref:people', { dv: 'Person' }),
    ],
  },

  Budget_Plan: {
    coll: 'budgetLines', match: ['label'], label: 'label', months: 'plannedByMonth',
    note: 'The plan. Fixed columns first, then one column per month headed YYYY-MM. Add or remove month columns freely: the app reads whichever months it finds. A blank cell means nothing planned that month.',
    cols: [
      c('ID', 'id', 'id'),
      c('ProjectCode', 'projectId', 'ref:projects', { req: true, dv: 'Project' }),
      c('Type', 'type', 'text', { enum: BUDGET_T, dv: 'BudgetType' }),
      c('Label', 'label', 'text', { req: true }),
      c('Vendor', 'vendor', 'text', { dv: 'Vendor' }),
      c('Currency', 'currency'),
    ],
  },

  Budget_Actual: {
    coll: 'budgetLines', match: ['label'], label: 'label', months: 'actualByMonth',
    note: 'Actual spend, month by month. Same rows as Budget_Plan; the two are matched on ID, so do not renumber one without the other.',
    cols: [
      c('ID', 'id', 'id'),
      c('ProjectCode', 'projectId', 'ref:projects', { req: true, dv: 'Project' }),
      c('Type', 'type', 'text', { dv: 'BudgetType' }),
      c('Label', 'label', 'text', { req: true }),
      c('Vendor', 'vendor', 'text', { dv: 'Vendor' }),
      c('Currency', 'currency'),
    ],
  },

  RateCard: {
    coll: 'rateCard', match: ['seniority'], label: 'seniority',
    note: 'Blended monthly cost per seniority, used for forecasting when a person has no explicit CostMonthly.',
    cols: [
      c('ID', 'id', 'id'),
      c('Seniority', 'seniority', 'text', { req: true, dv: 'Seniority' }),
      c('Monthly', 'monthly', 'num'),
    ],
  },

  Holidays: {
    coll: 'holidays', match: ['@composite'], composite: ['date', 'region'], label: 'name',
    note: 'Public holidays. These are excluded from working-day and capacity maths.',
    cols: [
      c('ID', 'id', 'id'),
      c('Date', 'date', 'date', { req: true }),
      c('Name', 'name', 'text', { req: true }),
      c('Region', 'region'),
    ],
  },

  /* ---- work ------------------------------------------------------------- */

  Tasks: {
    coll: 'tasks', match: ['title'], label: 'title',
    note: 'The task board. Assignee is a person Name, Project a project Code.',
    cols: [
      c('ID', 'id', 'id'),
      c('Title', 'title', 'text', { req: true }),
      c('Project', 'project', 'ref:projects', { dv: 'Project' }),
      c('Division', 'division', 'ref:divisions', { dv: 'Division' }),
      c('Assignee', 'assignee', 'ref:people', { dv: 'Person' }),
      c('Status', 'status', 'text', { enum: ids(STATUSES), dv: 'TaskStatus' }),
      c('Priority', 'priority', 'text', { enum: ids(PRIORITIES), dv: 'TaskPriority' }),
      c('Due', 'due', 'date'),
      c('EstimateDays', 'estimate', 'num'),
      c('SpentDays', 'spent', 'num'),
      c('Objective', 'objectiveId', 'ref:objectives', { dv: 'Objective' }),
      /* Where the card sits in its board lane. Low numbers are at the top.
         Editable, but the board is far easier to reorder by dragging — this is
         here so a round-trip does not flatten an arrangement. */
      c('BoardOrder', 'order', 'num'),
      // The Jira issue this task became, e.g. PROJ-915. Free text, because
      // a key is only meaningful to Jira and we do not want to invent one.
      c('JiraKey', 'jiraKey'),
      c('Tags', 'tags', 'list'),
      c('Description', 'desc', 'rich'),
    ],
  },

  Objectives: {
    coll: 'objectives', match: ['title'], label: 'title',
    note: 'Quarterly objectives. Key results live on their own sheet.',
    cols: [
      c('ID', 'id', 'id'),
      c('Title', 'title', 'text', { req: true }),
      c('Quarter', 'quarter'),
      c('Owner', 'owner', 'ref:people', { dv: 'Person' }),
      c('Project', 'project', 'ref:projects', { dv: 'Project' }),
      c('Division', 'division', 'ref:divisions', { dv: 'Division' }),
      c('Status', 'status', 'text', { enum: O_STATUS, dv: 'ObjectiveStat' }),
      c('Why', 'why'),
    ],
  },

  /* ---- GFX work breakdown ---------------------------------------------- */

  WB_Items: {
    coll: 'wbItems', match: ['@composite'], composite: ['division', 'name'], label: 'name',
    note: 'The work-breakdown catalogue: the base eyeball ETA for one of each thing, one artist, normal complexity. This is the sheet to bulk-edit — everything the calculator does is a multiplier on these hours. Division is 2D, 3D, ANIM, VFX, UIUX or PROD; PROD is GFX Production overhead (feedback, QA, documentation) and never divides duration by a crew.',
    cols: [
      c('ID', 'id', 'id'),
      c('Division', 'division', 'text', { req: true, enum: WB_DIV_IDS, dv: 'Division' }),
      c('WorkItem', 'name', 'text', { req: true }),
      c('BaseHours', 'hours', 'num', { req: true }),
      c('BaseDays', null, 'formula', {
        fx: (r, F) => `IF(${F.me('BaseHours')}${r}="","",${F.me('BaseHours')}${r}/8)`,
        doc: 'The same number in days at 8h. Read-only — edit BaseHours.' }),
      c('Notes', 'notes'),
      c('Active', 'active', 'bool'),
    ],
  },

  WB_Estimates: {
    coll: 'wbEstimates', match: ['name'], label: 'name',
    note: 'One row per saved estimate. The breakdown itself is on WB_Lines. Crew sizes, per-division seniority overrides and the logged snapshot are deliberately NOT editable here — the first two are planning knobs you turn while looking at the numbers, and the snapshot is what was signed off on a date, which a spreadsheet must not be able to rewrite. Logged and LoggedCost are shown for reading only.',
    cols: [
      c('ID', 'id', 'id'),
      c('Name', 'name', 'text', { req: true }),
      c('Project', 'projectId', 'ref:projects', { dv: 'Project' }),
      /* The default for lines added before the approach moved onto each line.
         Kept so old estimates still read correctly. */
      c('Approach', 'approach', 'text', { enum: WB_APPROACH_IDS, dv: 'WbApproach' }),
      c('Status', 'status', 'text', { enum: WB_EST_STATUS, dv: 'WbEstStatus' }),
      c('ReviewPct', 'reviewPct', 'num'),
      c('ContingencyPct', 'contingencyPct', 'num'),
      c('Parallel', 'parallel', 'bool'),
      c('Start', 'startDate', 'date'),
      c('Notes', 'notes'),
      c('EffortHours', null, 'formula', {
        fx: (r, F) => `SUMIFS(${F.at('WB_Lines', 'Hours')},${F.at('WB_Lines', 'Estimate')},${F.me('Name')}${r})`,
        doc: 'Raw effort from WB_Lines, before review and contingency.' }),
      /* The signed-off snapshot, for reading. Derived, so importing this sheet
         can never rewrite what was committed to on a date. */
      c('Logged', null, 'derived', {
        get: e => (e.logged?.at ? new Date(e.logged.at).toISOString().slice(0, 10) : '') }),
      c('LoggedCost', null, 'derived', {
        get: e => (e.logged?.cost != null ? Math.round(e.logged.cost * 100) / 100 : '') }),
      c('LoggedHours', null, 'derived', {
        get: e => (e.logged?.hours != null ? Math.round(e.logged.hours * 10) / 10 : '') }),
    ],
  },

  WB_Lines: {
    child: {
      parent: 'wbEstimates', field: 'lines', kind: 'array',
      pk: [{ h: 'Estimate', f: 'name' }],
    },
    note: 'The breakdown, one row per work item in an estimate. Estimate must match a Name on WB_Estimates. Hours is calculated for reading — the app recomputes it from BaseHours × complexity × Qty × the approach factor, so editing it changes nothing.',
    cols: [
      c('Estimate', '@pk:name', 'parent', { dv: 'WbEstimate' }),
      c('ID', 'id', 'text'),
      c('ItemID', 'itemId', 'text'),
      c('Division', 'division', 'text', { enum: WB_DIV_IDS, dv: 'Division' }),
      c('WorkItem', 'name', 'text', { req: true }),
      c('BaseHours', 'baseHours', 'num'),
      c('Complexity', 'complexity', 'text', { enum: WB_CX_IDS, dv: 'WbComplexity' }),
      c('Approach', 'approach', 'text', { enum: WB_APPROACH_IDS, dv: 'WbApproach' }),
      c('Qty', 'qty', 'num'),
      c('Seniority', 'seniority', 'text', { enum: ['', ...SENIORITY], dv: 'Seniority' }),
      c('Note', 'note'),
      c('Hours', null, 'formula', {
        fx: (r, F) => `IF(${F.me('WorkItem')}${r}="","",${F.me('BaseHours')}${r}*${F.me('Qty')}${r})`,
        doc: 'BaseHours × Qty, at normal complexity. The complexity and approach factors are applied by the app, so this is a sanity check rather than the number the app uses.' }),
    ],
  },

  /*
   * The Jira projects, as a sheet.
   *
   * They live in state rather than in the source — a tracker's keys and epic
   * ids are not something to publish from a public repository — which means
   * they would be lost with the browser profile. Here they are recoverable
   * from a workbook, and editable in bulk.
   */
  JiraProjects: {
    coll: 'jiraProjects', match: ['key'], label: 'key',
    note: 'Where this app files tasks. Key is the identity — task records store it, so changing a Key here does not re-point the tasks that used it. Priorities must be spelled exactly as that Jira project spells them, separated by spaces; Jira rejects a priority it does not have.',
    cols: [
      c('Key', 'key', 'text', { req: true }),
      c('Name', 'name', 'text'),
      c('IssueType', 'issueType', 'text'),
      c('Component', 'component'),
      c('DefaultEpic', 'defaultParent'),
      c('EpicName', 'defaultParentName'),
      c('Priorities', 'priorities', 'list'),
      c('DefaultPriority', 'defaultPriority'),
      c('EpicRequired', 'requiresParent', 'bool'),
      c('LabelRequired', 'labelsRequired', 'bool'),
    ],
  },

  JiraImports: {
    coll: 'jiraImports', match: ['key'], label: 'key',
    note: 'A log, not a workspace. One row per Jira issue created from this app, written when the local helper reports it and never edited afterwards — it records what was actually sent, so retitling the task later does not rewrite the history. Importing this sheet is only useful for restoring the log itself.',
    cols: [
      c('ID', 'id', 'id'),
      c('IssueKey', 'key', 'text', { req: true }),
      c('Summary', 'title', 'text'),
      c('JiraProject', 'project'),
      c('Project', 'projectId', 'ref:projects', { dv: 'Project' }),
      c('Division', 'division', 'ref:divisions', { dv: 'Division' }),
      c('Labels', 'labels', 'list'),
      c('Parent', 'parent'),
      c('Priority', 'priority'),
      c('Filed', 'date', 'date'),
      c('Run', 'batch'),
      c('AlreadyExisted', 'skipped', 'bool'),
      c('Url', 'url'),
    ],
  },

  KeyResults: {
    child: { parent: 'objectives', field: 'keyResults', by: 'ObjectiveID', kind: 'array' },
    note: 'Measurable results under each objective. Set Invert to TRUE for a metric where lower is better, such as a bug count.',
    cols: [
      c('ObjectiveID', '@parent', 'parent'),
      c('Objective', '@parentLabel', 'derived'),
      c('ID', 'id', 'text'),
      c('Text', 'text', 'text', { req: true }),
      c('Target', 'target', 'num'),
      c('Current', 'current', 'num'),
      c('Unit', 'unit'),
      c('Invert', 'invert', 'bool'),
    ],
  },
};

/* ---------- helpers ------------------------------------------------------ */

/** Find a workbook by id. */
export const workbookOf = (id) => WORKBOOKS.find(w => w.id === id) || null;

export const sheetsOf = (id) =>
  (workbookOf(id)?.sheets || []).map(n => ({ name: n, ...SHEETS[n] }));

/** Which collections a workbook can write to. Shown in the confirm dialog. */
export function collectionsOf(id) {
  const out = new Set();
  for (const s of sheetsOf(id)) out.add(s.coll || s.child.parent);
  return [...out];
}
