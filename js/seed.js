/* ============================================================================
   seed.js — the template dataset the app starts with.

   IMPORTANT — EVERYTHING IN HERE IS FICTIONAL, and must stay that way. This
   file ships in a PUBLIC repository, so it must never contain a real
   colleague's name, email, salary or leave record, a real product or client
   name, a real Jira project key or epic id, or a path on anybody's disk.

   `Skylark` and `Harbour Tales` are invented titles.

   EVERY MONEY FIGURE IN HERE IS ZERO, AND MUST STAY ZERO. Salaries, rate-card
   bands, project budgets, vendor rates, budget lines and agreed batch costs.
   They were invented before, which was not enough: an invented cost published
   beside a real employer reads as that employer's cost to anyone who finds it,
   and this file is served from a public repository. Zero states nothing.

   Nothing breaks at zero — the money is data, and the views render 0 rather
   than failing. Real values are entered inside the app, where they live in
   your own browser storage and are never committed anywhere:

     People → Import CSV ......... roster, salaries
     Settings → Organisation ..... rate card
     Settings → Integrations ..... Jira projects, folder paths
     Finance ..................... budgets and budget lines
     Outsourcing ................. vendor rates and batch costs

   Everything below is designed to be thrown away: Settings → Data → "Clear
   all sample data" leaves the structure and removes the content.
   ========================================================================= */

const MONTHS_2026 = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);

/** spread a total across a month range with an optional shape */
function spread(total, from, to, shape = 'flat') {
  const a = MONTHS_2026.indexOf(from), b = MONTHS_2026.indexOf(to);
  const n = b - a + 1, out = {};
  if (n <= 0) return out;
  const weights = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    weights.push(
      shape === 'ramp'  ? 0.4 + 1.2 * t :
      shape === 'peak'  ? 0.5 + 1.6 * Math.sin(Math.PI * t) :
      shape === 'front' ? 1.6 - 1.2 * t : 1
    );
  }
  const sum = weights.reduce((x, y) => x + y, 0);
  for (let i = 0; i < n; i++) out[MONTHS_2026[a + i]] = Math.round(total * weights[i] / sum);
  return out;
}

/** actuals = plan ± noise, but only for months that have already closed */
function actualise(plan, throughMonth, variance = 0.12, rnd = mulberry(7)) {
  const cut = MONTHS_2026.indexOf(throughMonth), out = {};
  for (const [m, v] of Object.entries(plan)) {
    if (MONTHS_2026.indexOf(m) > cut) continue;
    out[m] = Math.round(v * (1 + (rnd() * 2 - 1) * variance));
  }
  return out;
}
function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const d = (iso) => iso; // readability only

export function seed() {
  const now = Date.now();

  /* ---------- divisions ------------------------------------------------- */
  /* `jiraLabel` is the label every task in that division carries into Jira.
     It lives on the record rather than in a table in jira.js so a division
     added later — in the app or in Excel — can have one without a code change. */
  const divisions = [
    { id: '2D',   name: '2D Art',     color: '#E8A33D', lead: 'pe_you', jiraLabel: '2D' },
    { id: '3D',   name: '3D Art',     color: '#4C9AFF', lead: 'pe_03',  jiraLabel: '3D' },
    { id: 'ANIM', name: 'Animation',  color: '#A055C9', lead: 'pe_07',  jiraLabel: 'Anim' },
    { id: 'VFX',  name: 'VFX',        color: '#2FB8A8', lead: 'pe_10',  jiraLabel: 'VFX' },
    { id: 'UIUX', name: 'UI/UX',      color: '#E2637E', lead: 'pe_12',  jiraLabel: 'UIUX' },
    /* Production rather than an art discipline — the producer's own work:
       feedback rounds, QA, documentation, alignment. */
    { id: 'PROD', name: 'GFX Prod',   color: '#6264A7', lead: 'pe_you', jiraLabel: 'GFX-Prod' },
  ];

  /* ---------- projects -------------------------------------------------- */
  const projects = [
    {
      id: 'p_skl', code: 'SKY', name: 'Skylark', status: 'live', phase: 'Live Ops',
      start: d('2026-01-01'), end: d('2026-12-31'), color: '#4C9AFF',
      jiraKey: '', budget: 0, currency: 'USD',
      health: 'green', producerLead: 'pe_you',
      sharepointUrl: '',
      description: 'Live-ops content pipeline: seasonal drops, minigames and character packs across all five art divisions.',
      milestones: [
        { id: 'm1', name: 'Autumn Drop — content lock', date: d('2026-09-18'), status: 'at-risk', owner: 'pe_you' },
        { id: 'm2', name: 'Autumn Drop — ship',         date: d('2026-10-02'), status: 'planned', owner: 'pe_you' },
        { id: 'm3', name: 'Winter Event — art kickoff', date: d('2026-10-13'), status: 'planned', owner: 'pe_03' },
        { id: 'm4', name: 'Winter Event — ship',        date: d('2026-12-04'), status: 'planned', owner: 'pe_you' },
        { id: 'm5', name: 'Summer Drop — shipped',      date: d('2026-06-26'), status: 'done',    owner: 'pe_you' },
      ],
      risks: [
        { id: 'r1', text: 'Autumn Drop 3D prop list grew 22% after the design review', impact: 'high', likelihood: 'high',
          mitigation: 'Cut the two low-visibility prop sets; move the rest to Winter.', owner: 'pe_you', status: 'open' },
        { id: 'r2', text: 'Single point of failure on rig authoring', impact: 'high', likelihood: 'medium',
          mitigation: 'Cross-train a second animator on the rig toolkit in Q4.', owner: 'pe_07', status: 'mitigating' },
      ],
    },
    {
      id: 'p_hbr', code: 'HBR', name: 'Harbour Tales', status: 'production', phase: 'Vertical Slice',
      start: d('2026-03-01'), end: d('2027-03-31'), color: '#A055C9',
      jiraKey: '', budget: 0, currency: 'USD',
      health: 'amber', producerLead: 'pe_you',
      sharepointUrl: '',
      description: 'Narrative title in vertical slice. 2D-led with a small 3D and UI team; animation shared with the live-ops title.',
      milestones: [
        { id: 'm1', name: 'Vertical slice — art complete', date: d('2026-11-14'), status: 'planned', owner: 'pe_you' },
        { id: 'm2', name: 'Style guide v2 sign-off',       date: d('2026-09-25'), status: 'planned', owner: 'pe_01' },
        { id: 'm3', name: 'Chapter 1 environments',        date: d('2026-10-30'), status: 'planned', owner: 'pe_02' },
        { id: 'm4', name: 'Greenlight review',             date: d('2026-12-12'), status: 'planned', owner: 'pe_you' },
      ],
      risks: [
        { id: 'r1', text: 'Style guide churn is re-opening approved chapter 1 backgrounds', impact: 'medium', likelihood: 'high',
          mitigation: 'Freeze the guide on 25 Sep; anything after goes to a v3 backlog.', owner: 'pe_01', status: 'open' },
      ],
    },
    /*
     * GFX Prod — the production work itself, as a project.
     *
     * Feedback rounds, QA, documentation, pipeline and alignment are real work
     * that gets left out of a game's plan and then eats the schedule. They are
     * not Skylark work or Harbour Tales work, so they had nowhere to live: the
     * board could hold them but nothing rolled them up.
     *
     * `divisionId` ties it to the GFX Prod division, which is what lets its
     * Overview also show the GFX Prod work sitting on the game projects — see
     * `tabLinked()` in views/projects.js. The two are different axes and the
     * project does not try to own the division's tasks.
     */
    {
      id: 'p_gfxp', code: 'GFXP', name: 'GFX Prod', status: 'live', phase: 'Live Ops',
      start: d('2026-01-01'), end: d('2026-12-31'), color: '#6264A7',
      jiraKey: '', jiraEpic: '', budget: 0, currency: 'USD',
      health: 'green', producerLead: 'pe_you', sharepointUrl: '',
      divisionId: 'PROD',
      description: 'The production work behind the games: feedback rounds, QA passes, documentation, '
        + 'pipeline and cross-team alignment. Costed against the GFX Prod division, filed into Jira '
        + 'with the GFX-Prod label.',
      milestones: [
        { id: 'm1', name: 'Q4 pipeline review', date: d('2026-10-09'), status: 'planned', owner: 'pe_you' },
        { id: 'm2', name: 'Art bible — living doc refresh', date: d('2026-11-20'), status: 'planned', owner: 'pe_you' },
      ],
      risks: [
        { id: 'r1', text: 'Production overhead is invisible in the game plans, so it is the first thing cut',
          impact: 'medium', likelihood: 'high',
          mitigation: 'Every WB estimate now carries its GFX Prod lines; this project is where they roll up.',
          owner: 'pe_you', status: 'mitigating' },
      ],
    },
    {
      id: 'p_inc', code: 'INC', name: 'Incubation / Pitch', status: 'discovery', phase: 'Pre-production',
      start: d('2026-08-01'), end: d('2026-12-31'), color: '#2FB8A8',
      jiraKey: '', budget: 0, currency: 'USD',
      health: 'green', producerLead: 'pe_you', sharepointUrl: '',
      description: 'Ring-fenced exploration time. Concept, one playable art mock-up, no committed scope.',
      milestones: [{ id: 'm1', name: 'Pitch deck art pass', date: d('2026-11-06'), status: 'planned', owner: 'pe_you' }],
      risks: [],
    },
  ];

  /* ---------- people (all fictional) ------------------------------------ */
  const P = (id, name, division, role, seniority, contract, cost, alloc, extra = {}) => ({
    id, name, email: name.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com',
    division, role, seniority, contract, costMonthly: cost, alloc,
    active: true, location: 'Ho Chi Minh City', startDate: extra.startDate || '2024-01-15',
    manager: id === 'pe_you' ? null : 'pe_you',
    capacity: 100, leaveAllowance: 15,
    skills: extra.skills || {}, notes: extra.notes || '',
    ...extra,
  });

  const people = [
    P('pe_you', 'You (Art Producer Lead)', '2D', 'Art Producer Lead', 'Lead', 'staff', 0,
      [{ projectId: 'p_skl', pct: 50 }, { projectId: 'p_hbr', pct: 35 }, { projectId: 'p_inc', pct: 15 }],
      { isMe: true, notes: 'Rename this record in Settings → Profile.' }),

    P('pe_01', 'Ana Ruiz',      '2D',   'Senior Concept Artist',  'Senior', 'staff', 0,
      [{ projectId: 'p_hbr', pct: 80 }, { projectId: 'p_inc', pct: 20 }],
      { skills: { Concept: 5, Illustration: 5, Colour: 4, Mentoring: 4 } }),
    P('pe_02', 'Bruno Silva',   '2D',   '2D Environment Artist',  'Junior 2',    'staff', 0,
      [{ projectId: 'p_hbr', pct: 100 }], { skills: { Environments: 4, Painting: 4, Photoshop: 5 } }),
    P('pe_09', 'Priya Nair',    '2D',   '2D Artist',              'Junior 1', 'staff', 0,
      [{ projectId: 'p_skl', pct: 100 }], { skills: { Props: 3, Painting: 3 }, startDate: '2026-02-03' }),
    P('pe_14', 'Studio Kestrel','2D',   'Outsourcing partner',    '', 'outsource', 0,
      [{ projectId: 'p_skl', pct: 100 }], { notes: 'Prop & icon batches. Rate is a monthly retainer, not a salary.' }),

    P('pe_03', 'Chen Wei',      '3D',   '3D Lead',                'Lead',   'staff', 0,
      [{ projectId: 'p_skl', pct: 70 }, { projectId: 'p_hbr', pct: 30 }],
      { skills: { Modelling: 5, Lookdev: 4, Pipeline: 4, Mentoring: 4 } }),
    P('pe_04', 'Diego Moretti', '3D',   'Senior 3D Artist',       'Senior', 'staff', 0,
      [{ projectId: 'p_skl', pct: 100 }], { skills: { Modelling: 5, Sculpting: 4, Texturing: 4 } }),
    P('pe_05', 'Elif Demir',    '3D',   '3D Artist',              'Junior 2',    'staff', 0,
      [{ projectId: 'p_skl', pct: 60 }, { projectId: 'p_hbr', pct: 40 }], { skills: { Modelling: 4, Texturing: 4 } }),
    P('pe_06', 'Farid Haddad',  '3D',   'Technical Artist',       'Senior', 'staff', 0,
      [{ projectId: 'p_skl', pct: 50 }, { projectId: 'p_hbr', pct: 50 }],
      { skills: { Pipeline: 5, Shaders: 4, Python: 5, Optimisation: 5 } }),

    P('pe_07', 'Grace Okoye',   'ANIM', 'Animation Lead',         'Lead',   'staff', 0,
      [{ projectId: 'p_skl', pct: 60 }, { projectId: 'p_hbr', pct: 40 }],
      { skills: { Rigging: 5, Character: 5, Mentoring: 4 } }),
    P('pe_08', 'Hiro Tanaka',   'ANIM', 'Animator',               'Junior 2',    'staff', 0,
      [{ projectId: 'p_skl', pct: 100 }], { skills: { Character: 4, Cinematics: 3 } }),
    P('pe_15', 'Ines Barbosa',  'ANIM', 'Animator',               'Junior 1', 'contract', 0,
      [{ projectId: 'p_hbr', pct: 100 }], { skills: { Character: 3 }, endDate: '2026-12-31' }),

    P('pe_10', 'Jonas Weber',   'VFX',  'VFX Lead',               'Lead',   'staff', 0,
      [{ projectId: 'p_skl', pct: 65 }, { projectId: 'p_hbr', pct: 35 }],
      { skills: { Realtime: 5, Shaders: 4, Optimisation: 4 } }),
    P('pe_11', 'Keiko Mori',    'VFX',  'VFX Artist',             'Junior 2',    'staff', 0,
      [{ projectId: 'p_skl', pct: 100 }], { skills: { Realtime: 4, Simulation: 3 } }),

    P('pe_12', 'Lucas Fontaine','UIUX', 'UI/UX Lead',             'Lead',   'staff', 0,
      [{ projectId: 'p_skl', pct: 45 }, { projectId: 'p_hbr', pct: 45 }, { projectId: 'p_inc', pct: 10 }],
      { skills: { UX: 5, UI: 5, Prototyping: 4, Research: 3 } }),
    P('pe_13', 'Maya Kapoor',   'UIUX', 'UI Artist',              'Junior 2',    'staff', 0,
      [{ projectId: 'p_skl', pct: 70 }, { projectId: 'p_hbr', pct: 30 }], { skills: { UI: 4, Motion: 3 } }),
  ];

  /* ---------- tasks ------------------------------------------------------ */
  const T = (id, title, project, division, assignee, status, priority, due, extra = {}) => ({
    id, title, project, division, assignee, status, priority, due,
    created: now - 86400000 * (extra.age || 10), updated: now,
    estimate: extra.est || 0, spent: extra.spent || 0,
    tags: extra.tags || [], checklist: extra.checklist || [],
    desc: extra.desc || '', objectiveId: extra.obj || null, order: extra.order || 0,
    ...extra,
  });

  const tasks = [
    T('t01', 'Autumn Drop — lock the 3D prop list with design', 'p_skl', '3D', 'pe_03', 'doing', 'critical', '2026-09-11',
      { est: 6, spent: 4, tags: ['milestone', 'scope'], obj: 'o1',
        desc: 'Prop count went from 41 to 50 after review. Bring a cut list, not a discussion.',
        checklist: [{ t: 'Pull the 50-item list from Jira', done: true }, { t: 'Mark visibility tier per prop', done: true }, { t: 'Agree the cut with design', done: false }] }),
    T('t02', 'Review Autumn Drop character pack — final pass',  'p_skl', '2D',  'pe_09', 'review', 'high', '2026-09-09', { est: 3, spent: 2, tags: ['review'] }),
    T('t03', 'Approve Studio Kestrel batch 12 invoice',         'p_skl', '2D',  'pe_you', 'todo', 'high', '2026-09-10', { est: 1, tags: ['finance', 'outsourcing'], obj: 'o4' }),
    T('t04', 'Winter Event — build the art capacity plan',      'p_skl', null,  'pe_you', 'todo', 'high', '2026-09-15', { est: 4, tags: ['planning'], obj: 'o1' }),
    T('t05', 'Rig toolkit cross-training session #1',           'p_skl', 'ANIM','pe_07', 'todo', 'normal', '2026-09-22', { est: 4, tags: ['risk', 'people'], obj: 'o3' }),
    T('t06', 'Optimise autumn foliage VFX for low-end devices', 'p_skl', 'VFX', 'pe_11', 'doing', 'high', '2026-09-16', { est: 12, spent: 5, tags: ['perf'] }),
    T('t07', 'Icon set refresh — 24 store icons',               'p_skl', 'UIUX','pe_13', 'doing', 'normal', '2026-09-19', { est: 10, spent: 6 }),
    T('t08', 'Autumn Drop — VFX review with tech',              'p_skl', 'VFX', 'pe_10', 'todo', 'normal', '2026-09-17', { est: 2 }),
    T('t09', 'Retire the legacy prop shader',                   'p_skl', '3D',  'pe_06', 'backlog', 'low', '', { est: 8, tags: ['tech-debt'] }),
    T('t10', 'Character LOD pass — 12 hero assets',             'p_skl', '3D',  'pe_04', 'doing', 'normal', '2026-09-25', { est: 20, spent: 9 }),
    T('t11', 'Sept live-ops art burn report',                   'p_skl', null,  'pe_you', 'todo', 'normal', '2026-09-30', { est: 2, tags: ['finance'], obj: 'o4' }),
    T('t12', 'Blocked: waiting on audio for the boss intro',    'p_skl', 'ANIM','pe_08', 'blocked', 'high', '2026-09-12', { est: 6, spent: 3, tags: ['blocked'], desc: 'Audio ETA 10 Sep. Chase in the Thursday sync.' }),

    T('t20', 'Style guide v2 — consolidate feedback',           'p_hbr', '2D',  'pe_01', 'doing', 'critical', '2026-09-19', { est: 8, spent: 5, tags: ['milestone'], obj: 'o2' }),
    T('t21', 'Chapter 1 — 6 environment paintings',             'p_hbr', '2D',  'pe_02', 'doing', 'high', '2026-10-24', { est: 48, spent: 14, obj: 'o2' }),
    T('t22', 'Narrative UI flow — first prototype',             'p_hbr', 'UIUX','pe_12', 'review', 'high', '2026-09-12', { est: 16, spent: 15 }),
    T('t23', 'Chapter 1 hero rig',                              'p_hbr', 'ANIM','pe_07', 'todo', 'high', '2026-10-02', { est: 24 }),
    T('t24', 'Prop kit-bash library for chapter 1',             'p_hbr', '3D',  'pe_05', 'doing', 'normal', '2026-10-09', { est: 30, spent: 11 }),
    T('t25', 'Define the VS art acceptance checklist',          'p_hbr', null,  'pe_you', 'todo', 'high', '2026-09-18', { est: 3, tags: ['quality'], obj: 'o2' }),
    T('t26', 'Ambient VFX pass — chapter 1',                    'p_hbr', 'VFX', 'pe_10', 'backlog', 'normal', '', { est: 18 }),
    T('t27', 'Junior onboarding pack for the narrative style',  'p_hbr', '2D',  'pe_01', 'backlog', 'low', '', { est: 6, tags: ['people'], obj: 'o3' }),

    T('t30', 'Q4 headcount forecast — draft for finance',       null,   null,  'pe_you', 'doing', 'critical', '2026-09-12', { est: 5, spent: 2, tags: ['finance', 'people'], obj: 'o4' }),
    T('t31', '1:1s — September round (14 people)',              null,   null,  'pe_you', 'doing', 'high', '2026-09-26', { est: 12, spent: 5, tags: ['people'], obj: 'o3' }),
    T('t32', 'Mid-year review calibration prep',                null,   null,  'pe_you', 'todo', 'high', '2026-09-24', { est: 6, tags: ['people'], obj: 'o3' }),
    T('t33', 'Update the art division org chart',               null,   null,  'pe_you', 'backlog', 'low', '', { est: 2, tags: ['people'] }),
    T('t34', 'Pitch art mock-up — direction review',            'p_inc','2D',  'pe_01', 'todo', 'normal', '2026-10-16', { est: 10 }),
    T('t35', 'Overdue: close out August outsourcing PO',        'p_skl', null,  'pe_you', 'todo', 'critical', '2026-08-29', { est: 1, tags: ['finance'], age: 28 }),

    T('t40', 'Summer Drop retrospective — actions published',   'p_skl', null,  'pe_you', 'done', 'normal', '2026-07-10', { est: 4, spent: 4, age: 60 }),
    T('t41', 'Summer Drop — 32 props delivered',                'p_skl', '3D',  'pe_04', 'done', 'high', '2026-06-20', { est: 40, spent: 44, age: 80 }),
    T('t42', 'Hire junior 2D artist',                           null,   '2D',  'pe_you', 'done', 'high', '2026-01-30', { est: 20, spent: 26, age: 200, tags: ['people'] }),
  ];

  /* ---------- objectives (OKR) ------------------------------------------ */
  const objectives = [
    {
      id: 'o1', title: 'Ship the Autumn Drop on date with no quality regressions',
      quarter: '2026-Q3', owner: 'pe_you', project: 'p_skl', division: null, status: 'on-track',
      why: 'Live-ops cadence is the commercial engine. A slip pushes the Winter Event into the holiday freeze.',
      keyResults: [
        { id: 'k1', text: 'Content lock held on 18 Sep', target: 1, current: 0, unit: 'done' },
        { id: 'k2', text: 'Art bugs at ship below the 15-bug bar', target: 15, current: 21, unit: 'bugs', invert: true },
        { id: 'k3', text: 'Props delivered', target: 50, current: 38, unit: 'props' },
      ],
      updates: [{ date: '2026-09-01', text: 'Prop scope grew 22%; cut list going to design on 11 Sep.', by: 'pe_you' }],
    },
    {
      id: 'o2', title: "Harbour Tales vertical slice art is review-ready by 14 Nov",
      quarter: '2026-Q4', owner: 'pe_you', project: 'p_hbr', division: null, status: 'at-risk',
      why: 'The greenlight decision is made on the slice. Art is the visible half of it.',
      keyResults: [
        { id: 'k1', text: 'Style guide v2 signed off', target: 1, current: 0, unit: 'done' },
        { id: 'k2', text: 'Chapter 1 environments complete', target: 6, current: 2, unit: 'scenes' },
        { id: 'k3', text: 'Acceptance checklist agreed with the leads', target: 1, current: 0, unit: 'done' },
      ],
      updates: [{ date: '2026-09-03', text: 'Guide churn is the single biggest threat. Freeze proposed for 25 Sep.', by: 'pe_you' }],
    },
    {
      id: 'o3', title: 'No single point of failure in any art division',
      quarter: '2026-Q4', owner: 'pe_you', project: null, division: null, status: 'on-track',
      why: 'Two people carry knowledge nobody else has. That is a delivery risk before it is a people risk.',
      keyResults: [
        { id: 'k1', text: 'Skills matrix shows 2+ people at level 3 per critical skill', target: 8, current: 5, unit: 'skills' },
        { id: 'k2', text: '1:1 coverage each month', target: 100, current: 86, unit: '%' },
        { id: 'k3', text: 'Every direct report has a written development goal', target: 14, current: 9, unit: 'people' },
      ],
      updates: [],
    },
    {
      id: 'o4', title: 'Land FY26 art spend within 2% of forecast',
      quarter: '2026-Q4', owner: 'pe_you', project: null, division: null, status: 'on-track',
      why: 'Forecast accuracy is what buys the team credibility for the FY27 ask.',
      keyResults: [
        { id: 'k1', text: 'Monthly forecast variance', target: 2, current: 3.4, unit: '%', invert: true },
        { id: 'k2', text: 'Outsourcing POs closed in the month they land', target: 100, current: 78, unit: '%' },
        { id: 'k3', text: 'Q4 headcount plan approved', target: 1, current: 0, unit: 'done' },
      ],
      updates: [],
    },
  ];

  /* ---------- finance ---------------------------------------------------- */
  const BL = (id, projectId, type, label, vendor, total, from, to, shape, variance) => {
    const plan = spread(total, from, to, shape);
    return { id, projectId, type, label, vendor, currency: 'USD',
             plannedByMonth: plan, actualByMonth: actualise(plan, '2026-08', variance) };
  };

  const budgetLines = [
    BL('b01', 'p_skl', 'internal',  'Internal art headcount — SKY', '', 0, '2026-01', '2026-12', 'flat',  0.05),
    BL('b02', 'p_skl', 'outsource', 'Outsourcing — props & icons',  'Studio Kestrel', 0, '2026-02', '2026-12', 'peak',  0.18),
    BL('b03', 'p_skl', 'outsource', 'Outsourcing — 2D marketing KV','Bright Anvil', 0, '2026-03', '2026-11', 'ramp',  0.22),
    BL('b04', 'p_skl', 'license',   'DCC & pipeline licences',      'Various', 0, '2026-01', '2026-12', 'flat',  0.03),
    BL('b05', 'p_skl', 'hardware',  'Workstation refresh (6 seats)','IT', 0, '2026-04', '2026-06', 'flat',  0.10),
    BL('b06', 'p_skl', 'other',     'Contingency — SKY',            '', 0, '2026-01', '2026-12', 'flat',  0.55),

    BL('b10', 'p_hbr', 'internal',  'Internal art headcount — HBR', '', 0, '2026-03', '2026-12', 'ramp',  0.06),
    BL('b11', 'p_hbr', 'outsource', 'Outsourcing — background paint','Nine Lanterns', 0, '2026-05', '2026-12', 'ramp',  0.20),
    BL('b12', 'p_hbr', 'license',   'Narrative tooling licences',   'Various', 0, '2026-03', '2026-12', 'flat',  0.04),
    BL('b13', 'p_hbr', 'other',     'Contingency — HBR',            '', 0, '2026-03', '2026-12', 'flat',  0.60),

    BL('b20', 'p_inc', 'internal',  'Incubation time',              '', 0, '2026-08', '2026-12', 'flat',  0.08),
    BL('b21', 'p_inc', 'outsource', 'Concept support',              'Freelance pool', 0, '2026-09', '2026-12', 'flat',  0.30),
  ];

  /* ---------- outsourcing (all fictional studios) ----------------------- */
  // The names deliberately match the `vendor` field on the outsourcing budget
  // lines above, so spend links up without anyone retyping anything.
  const vendors = [
    {
      id: 'v_kestrel', name: 'Studio Kestrel', country: 'Poland', status: 'active',
      specialisms: ['3D', '2D'], contactName: 'Studio lead', contactEmail: 'hello@example.com',
      rateModel: 'retainer', rateValue: 0, currency: 'USD',
      ndaSigned: true, msaSigned: true,
      quality: 4, onTime: 5, comms: 4,
      notes: 'Reliable on props and icons. Ask for the tri budget in writing — they will hit it exactly, including when it is wrong.',
      created: now,
    },
    {
      id: 'v_anvil', name: 'Bright Anvil', country: 'United Kingdom', status: 'active',
      specialisms: ['2D'], contactName: 'Account manager', contactEmail: 'hello@example.com',
      rateModel: 'fixed-bid', rateValue: 0, currency: 'USD',
      ndaSigned: true, msaSigned: true,
      quality: 5, onTime: 3, comms: 5,
      notes: 'Best marketing key art we have used. Slips a few days on almost every batch — brief them a week early.',
      created: now,
    },
    {
      id: 'v_lanterns', name: 'Nine Lanterns', country: 'Vietnam', status: 'trial',
      specialisms: ['2D'], contactName: 'Producer', contactEmail: 'hello@example.com',
      rateModel: 'per-asset', rateValue: 0, currency: 'USD',
      ndaSigned: true, msaSigned: false,
      quality: 3, onTime: 4, comms: 3,
      notes: 'On trial for narrative backgrounds. MSA still unsigned — do not commit past the current batch.',
      created: now,
    },
    {
      id: 'v_pool', name: 'Freelance pool', country: 'Various', status: 'active',
      specialisms: ['2D', 'ANIM'], contactName: '', contactEmail: '',
      rateModel: 'day-rate', rateValue: 0, currency: 'USD',
      ndaSigned: true, msaSigned: false,
      quality: 3, onTime: 3, comms: 3,
      notes: 'Individual concept artists for incubation spikes. Quality varies by person, not by vendor.',
      created: now,
    },
  ];

  const outsourceBatches = [
    { id: 'ob1', vendorId: 'v_kestrel', projectId: 'p_skl', division: '3D',
      title: 'Autumn Drop props — batch 12', qty: 24, unit: 'props',
      agreedCost: 0, currency: 'USD', poNumber: 'PO-2026-0412',
      briefedOn: '2026-08-11', dueOn: '2026-09-05', deliveredOn: '2026-09-04', acceptedOn: '2026-09-08',
      status: 'accepted', revisions: 1, notes: 'Two props sent back for pivot placement. Fixed same day.' },
    { id: 'ob2', vendorId: 'v_kestrel', projectId: 'p_skl', division: '2D',
      title: 'Store icon set refresh', qty: 24, unit: 'icons',
      agreedCost: 0, currency: 'USD', poNumber: 'PO-2026-0431',
      briefedOn: '2026-09-01', dueOn: '2026-09-26', deliveredOn: '', acceptedOn: '',
      status: 'in-progress', revisions: 0, notes: '' },
    { id: 'ob3', vendorId: 'v_anvil', projectId: 'p_skl', division: '2D',
      title: 'Autumn Drop marketing key art', qty: 3, unit: 'KVs',
      agreedCost: 0, currency: 'USD', poNumber: 'PO-2026-0428',
      briefedOn: '2026-08-18', dueOn: '2026-09-11', deliveredOn: '2026-09-15', acceptedOn: '',
      status: 'in-review', revisions: 2, notes: 'Late again. Third round on the hero composition.' },
    { id: 'ob4', vendorId: 'v_lanterns', projectId: 'p_hbr', division: '2D',
      title: 'Chapter 1 background paint — trial batch', qty: 6, unit: 'scenes',
      agreedCost: 0, currency: 'USD', poNumber: 'PO-2026-0435',
      briefedOn: '2026-09-02', dueOn: '2026-09-30', deliveredOn: '', acceptedOn: '',
      status: 'in-progress', revisions: 0, notes: 'Trial. Decide on the MSA once this lands.' },
    { id: 'ob5', vendorId: 'v_anvil', projectId: 'p_skl', division: '2D',
      title: 'Summer Drop marketing key art', qty: 3, unit: 'KVs',
      agreedCost: 0, currency: 'USD', poNumber: 'PO-2026-0361',
      briefedOn: '2026-05-06', dueOn: '2026-06-05', deliveredOn: '2026-06-09', acceptedOn: '2026-06-16',
      status: 'accepted', revisions: 3, notes: 'Four days late, three revision rounds. Still the best-looking KV of the year.' },
    { id: 'ob6', vendorId: 'v_pool', projectId: 'p_inc', division: '2D',
      title: 'Pitch concept sprint', qty: 10, unit: 'days',
      agreedCost: 0, currency: 'USD', poNumber: '',
      briefedOn: '2026-09-07', dueOn: '2026-10-16', deliveredOn: '', acceptedOn: '',
      status: 'briefed', revisions: 0, notes: 'No PO raised yet — chase finance before they start.' },
  ];

  /* ---------- leave & holidays ------------------------------------------ */
  const leave = [
    { id: 'l01', personId: 'pe_01', type: 'annual',   from: '2026-09-14', to: '2026-09-18', note: 'Family trip' },
    { id: 'l02', personId: 'pe_04', type: 'annual',   from: '2026-09-21', to: '2026-09-25', note: '' },
    { id: 'l03', personId: 'pe_07', type: 'annual',   from: '2026-10-05', to: '2026-10-09', note: '' },
    { id: 'l04', personId: 'pe_11', type: 'sick',     from: '2026-09-03', to: '2026-09-04', note: '' },
    { id: 'l05', personId: 'pe_13', type: 'annual',   from: '2026-09-28', to: '2026-10-02', note: 'Crosses the Autumn ship date' },
    { id: 'l06', personId: 'pe_05', type: 'wfh',      from: '2026-09-11', to: '2026-09-11', note: 'Delivery at home' },
    { id: 'l07', personId: 'pe_02', type: 'annual',   from: '2026-12-21', to: '2026-12-31', note: 'Year-end' },
    { id: 'l08', personId: 'pe_08', type: 'training', from: '2026-10-15', to: '2026-10-16', note: 'Animation summit' },
    { id: 'l09', personId: 'pe_12', type: 'annual',   from: '2026-11-09', to: '2026-11-13', note: '' },
    { id: 'l10', personId: 'pe_03', type: 'comp',     from: '2026-09-08', to: '2026-09-08', note: 'Crunch payback' },
    { id: 'l11', personId: 'pe_15', type: 'annual',   from: '2026-10-26', to: '2026-10-30', note: '' },
    { id: 'l12', personId: 'pe_09', type: 'annual',   from: '2026-09-17', to: '2026-09-17', half: 'pm', note: 'Half day' },
  ];

  // Template values — CONFIRM AGAINST YOUR HR CALENDAR before relying on them.
  const holidays = [
    { id: 'h01', date: '2026-01-01', name: "New Year's Day", region: 'VN' },
    { id: 'h02', date: '2026-02-16', name: 'Tết (eve)',      region: 'VN' },
    { id: 'h03', date: '2026-02-17', name: 'Tết',            region: 'VN' },
    { id: 'h04', date: '2026-02-18', name: 'Tết',            region: 'VN' },
    { id: 'h05', date: '2026-02-19', name: 'Tết',            region: 'VN' },
    { id: 'h06', date: '2026-02-20', name: 'Tết',            region: 'VN' },
    { id: 'h07', date: '2026-04-26', name: 'Hùng Kings',     region: 'VN' },
    { id: 'h08', date: '2026-04-30', name: 'Reunification',  region: 'VN' },
    { id: 'h09', date: '2026-05-01', name: 'Labour Day',     region: 'VN' },
    { id: 'h10', date: '2026-09-02', name: 'National Day',   region: 'VN' },
    { id: 'h11', date: '2026-09-03', name: 'National Day +1',region: 'VN' },
  ];

  /* ---------- notes ------------------------------------------------------ */
  const notes = [
    { id: 'n1', title: 'Thursday production sync — standing agenda', pinned: true, updated: now,
      body: '1. Milestone burn — one line per project\n2. Anything blocked over 48h\n3. Leave landing in the next 3 weeks\n4. Outsourcing batches in flight\n5. One risk we are NOT tracking yet' },
    { id: 'n2', title: 'Cut-list principles (Autumn Drop)', pinned: false, updated: now,
      body: 'Cut by visibility tier, never by division fairness.\nA prop seen in the first 10 minutes outranks three seen in hour four.\nIf a cut saves under half a day, it is not a cut, it is a distraction.' },
  ];

  /* ---------- one-to-ones ------------------------------------------------ */
  const oneToOnes = [
    { id: 'oo1', personId: 'pe_09', date: '2026-09-02', mood: 'good',
      notes: 'Settling in well. Wants more prop variety. Action: pair with Diego on the LOD pass.',
      actions: [{ t: 'Pair with Diego on LOD pass', done: false }] },
    { id: 'oo2', personId: 'pe_07', date: '2026-08-28', mood: 'neutral',
      notes: 'Carrying the rig knowledge alone and feels it. Cross-training agreed for Q4.',
      actions: [{ t: 'Schedule cross-training session #1', done: false }] },
    { id: 'oo3', personId: 'pe_01', date: '2026-08-26', mood: 'concerned',
      notes: 'Frustrated by style guide churn. Wants a hard freeze date. Agreed: propose 25 Sep.',
      actions: [{ t: 'Propose guide freeze to design', done: true }] },
  ];

  /* ---------- prefs, settings ------------------------------------------- */
  return {
    v: 1,
    meta: { created: now, updated: now, seeded: true },

    profile: {
      name: 'Art Producer Lead', title: 'Art Producer Lead — GFX', email: '',
      initials: 'AP', timezone: 'Asia/Ho_Chi_Minh',
    },

    prefs: {
      theme: 'auto',              // auto | default | dark | contrast
      accent: '#6264A7',
      density: 'normal',          // compact | normal | roomy
      railMini: false,
      landing: 'dashboard',
      widgets: ['kpis', 'today', 'milestones', 'burn', 'leave', 'okr', 'risks', 'capacity'],
      navOrder: [],
      navCollapsed: {},          // { work:true } = that sidebar group is folded away
      navHidden: [],
      weekStart: 1,
      currency: 'USD',
      fiscalStart: 1,
      dateFmt: 'dd MMM',
      workingDays: [1, 2, 3, 4, 5],
    },

    settings: {
      graph: {
        clientId: '', tenantId: 'common', enabled: false, siteUrl: '', autoConnect: false,
        // Start with the least that works: your own OneDrive, for the backup.
        // Turn the rest on in Settings once your tenant has consented to them.
        caps: { ownFiles: true, allFiles: false, sites: false, people: false, leave: false },
      },
      cloud: {
        enabled: false,                 // needs Microsoft 365 connected first
        folder: 'Apps/GFX Prod App',    // under your own OneDrive root
        keep: 30,                       // daily snapshots to retain
        device: '',                     // blank = auto-detected label
        lastAt: 0,
      },
      // Backup into a folder you pick with the OS picker — typically your
      // OneDrive *sync* folder, so the OneDrive client does the uploading.
      // Needs no app registration and no administrator.
      localBackup: { enabled: false, folderName: '', keep: 30, lastAt: 0 },
      // The local helper (tools/gfx-bridge.ps1). This is the only route that
      // reaches the disk from inside a Teams tab, where the browser blocks
      // the folder API outright.
      bridge: { enabled: false, url: 'http://127.0.0.1:8787', token: '', lastAt: 0 },
      // Excel round-trip. Declared here so fillMissing() hands it to installs
      // that predate the feature, rather than leaving it undefined.
      excel: { lastImport: null },
      // Blank reporter = file as the owner of the API token, which is you.
      // An Atlassian account id is personal, so it is never in the source.
      jira: { reporterAccountId: '', lastResult: null },
      leaveSource: 'manual',      // manual | graph | import
      autoLockMinutes: 15,        // only applies once a password is set; 0 = never
      hoursPerDay: 8,
      utilisationTarget: 85,
      currencySymbol: '$',
      workspaceLinks: [
        { id: 'w1', label: 'Skylark art SharePoint', url: '' },
        { id: 'w2', label: "Harbour Tales art SharePoint", url: '' },
        { id: 'w3', label: 'Art division wiki', url: '' },
      ],
    },

    divisions, projects, people, tasks, objectives, vendors, outsourceBatches,
    budgetLines, leave, holidays, notes, oneToOnes,

    // Per-person objectives, keyed by personId like leave and one-to-ones.
    // Empty on purpose: a goal is something you write about a real person.
    goals: [],

    /*
     * The GFX work-breakdown catalogue.
     *
     * Taken from the team's own WBS spreadsheet, so the base hours are the
     * eyeball ETAs already in use rather than numbers invented here. Editable
     * in Workspace → GFX WB → Catalogue; these are the starting point, not a
     * fixed list.
     *
     * `PROD` is the producer's own overhead — feedback, QA, documentation,
     * alignment. It is in the source sheet for good reason: it is real work
     * that gets left out of estimates and then eats the schedule.
     */
    wbItems: [
      ...[
        ['2D References', 1], ['Visual Design Planning', 1], ['Top Down Layout Sketch', 2],
        ['Design Exploration (1x Silhouette)', 0.2], ['Design Refinement (1x Silhouette)', 0.2],
        ['Turnaround', 6], ['3/4 View — Rendered', 8], ['Material Description & Notes', 0.5],
        ['Expression Sketches', 1], ['Animation Sketches', 1], ['VFX Sketches', 1],
        ['3D Blockout Simple — Base Models', 8], ['3D Blockout Complex — Materials & Light', 16],
        ['Mood Concept', 16], ['Fakescreen', 8], ['Graphic Asset Concept Sketch', 1],
        ['Graphic Asset Rendered', 4], ['2D Animation', 4], ['Illustration', 8],
        ['Storyframe (Storyboard)', 0.5], ['2D Implementation', 2], ['2D Miscellaneous', 1],
      ].map(([name, hours], i) => ({ id: `wbi_2d_${i + 1}`, division: '2D', name, hours, active: true })),

      ...[
        ['3D References', 1], ['3D Blocking Character', 4], ['Sculpting — Highpoly', 8],
        ['Retopology', 4], ['Modelling — Lowpoly', 8], ['Texturing', 4], ['Material Creation', 4],
        ['UV Unwrapping', 1], ['3D Blocking Environment', 4], ['Mesh Optimization', 4],
        ['3D Implementation', 2], ['3D Miscellaneous', 1],
      ].map(([name, hours], i) => ({ id: `wbi_3d_${i + 1}`, division: '3D', name, hours, active: true })),

      ...[
        ['Animation References', 1], ['Rigging', 4], ['Skinning', 4], ['Keypose Blocking', 4],
        ['Animation', 8], ['Keyframe Optimization', 2], ['Timing Polish', 2],
        ['Animation Implementation', 2], ['Ani Miscellaneous', 1],
      ].map(([name, hours], i) => ({ id: `wbi_anim_${i + 1}`, division: 'ANIM', name, hours, active: true })),

      ...[
        ['VFX Creation', 2], ['Custom Mesh', 1], ['Custom Shader', 2], ['Custom Texture', 1],
        ['Sprite Sheet Animation', 1], ['VFX Implementation', 1], ['VFX Miscellaneous', 1],
      ].map(([name, hours], i) => ({ id: `wbi_vfx_${i + 1}`, division: 'VFX', name, hours, active: true })),

      /* UI/UX has no rows in the source sheet yet — these are the obvious
         equivalents, marked like the rest so they can be corrected in place. */
      ...[
        ['UI References', 1], ['Wireframe / Flow', 2], ['UI Mockup — Screen', 6],
        ['UI Asset Rendered', 2], ['Icon Set (10)', 4], ['UI Animation', 3],
        ['UI Implementation', 2], ['UIUX Miscellaneous', 1],
      ].map(([name, hours], i) => ({ id: `wbi_uiux_${i + 1}`, division: 'UIUX', name, hours, active: true })),

      ...[
        ['Feedback', 0.5], ['Quality Assurance', 2], ['Playtesting', 1],
        ['Documentation', 2], ['Information Alignment', 1],
      ].map(([name, hours], i) => ({ id: `wbi_prod_${i + 1}`, division: 'PROD', name, hours, active: true })),
    ],

    /* Saved work-breakdown estimates. Empty on purpose: an estimate is
       something you make about a real deliverable. */
    wbEstimates: [],

    /*
     * Every task ever filed into Jira, one row per issue created.
     *
     * Deliberately its own collection rather than read off the tasks: this is
     * a history, and a task that is later deleted, retitled or re-scoped must
     * not silently rewrite what was sent to Jira in August. Written once by
     * `applyResult()` and never edited afterwards.
     */
    jiraImports: [],

    /* Every step a task has taken towards Jira, with a timestamp. Append-only;
       see pushJiraEvent() in jira.js. */
    jiraEvents: [],

    /*
     * The Jira projects tasks are filed into — EMPTY ON PURPOSE.
     *
     * These were a hard-coded array in jira.js holding real project keys, epic
     * ids and component names. This file ships in a public repository, and a
     * tracker's internal identifiers are not sample data. Add them in
     * Settings → Integrations; they then ride along in backups and in the
     * JiraProjects sheet, so they survive a browser wipe.
     */
    jiraProjects: [],

    /*
     * The rungs, with NO figures against them — every one is 0 on purpose.
     *
     * A salary band per level is the most sensitive shape data takes in this
     * app, and this file is public. Even invented numbers published beside a
     * real employer read as that employer's bands to anyone who finds them,
     * which is a claim this repository has no business making.
     *
     * 0 means "not set". The Rate Card screen shows it as an empty-looking
     * number to type into, and nothing breaks in the meantime: `rateFor()`
     * returns 0 and every cost falls back to the person's own `costMonthly`.
     * Fill them in at Settings → Organisation → Rate card; they then live in
     * your browser and your backups, never here.
     */
    rateCard: [
      { id: 'rc1', seniority: 'Junior 1',   monthly: 0 },
      { id: 'rc2', seniority: 'Junior 2',   monthly: 0 },
      { id: 'rc3', seniority: 'Senior',     monthly: 0 },
      { id: 'rc4', seniority: 'Expert',     monthly: 0 },
      { id: 'rc5', seniority: 'Supervisor', monthly: 0 },
      { id: 'rc6', seniority: 'Lead',       monthly: 0 },
      { id: 'rc7', seniority: 'Vendor',     monthly: 0 },
    ],

    files: { pinned: [], recent: [] },
  };
}
