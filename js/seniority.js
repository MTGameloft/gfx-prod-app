/* ============================================================================
   seniority.js — the rung ladder, and how to read an old one.

   Its own module, with NO imports, for one reason: both `calc.js` and
   `store.js` need it, and `calc.js` already imports `store.js`. Putting the
   ladder in either of them would make the module graph circular — which would
   probably have worked, since every use is inside a function, and would have
   been a trap for whoever touched it next.

   `calc.js` re-exports `SENIORITY` so the eight places that already import it
   from there keep working.
   ========================================================================= */

/*
 * The rungs, lowest to highest. The ONE list: the person editor, the rate
 * card, the work-breakdown rung picker, the scenario modeller and the Excel
 * drop-downs all read it.
 *
 * `Vendor` is last on purpose. It is not a level of experience — it is how an
 * outsourcing partner is costed, a retainer rather than a salary — and it
 * belongs on the ladder because the rate card is where `rateFor()` looks when
 * a person has no explicit monthly cost of their own.
 *
 * `Director` used to be here. `LEGACY_SENIORITY` maps it, and the earlier
 * lowercase ladder, onto these.
 */
export const SENIORITY = ['Junior 1', 'Junior 2', 'Senior', 'Expert', 'Supervisor', 'Lead', 'Vendor'];

/**
 * Old value -> current rung, for data written before the ladder settled.
 *
 * Keyed and matched lowercase. Anything NOT listed is left exactly as it is
 * rather than guessed at: an unknown rung still shows on the person, and
 * `rateFor()` returning 0 for it falls through to their own `costMonthly`, so
 * nobody's cost silently becomes free.
 *
 * `director` maps to `Lead`, not to `Vendor`. Replacing the top salaried rung
 * with an outsourcing rate would have costed a member of staff at a studio
 * retainer — the kind of error that looks plausible in a forecast.
 */
export const LEGACY_SENIORITY = {
  junior:        'Junior 1',
  'junior 1':    'Junior 1',
  'junior1':     'Junior 1',
  'junior 2':    'Junior 2',
  'junior2':     'Junior 2',
  mid:           'Junior 2',
  intermediate:  'Junior 2',
  senior:        'Senior',
  expert:        'Expert',
  principal:     'Expert',
  supervisor:    'Supervisor',
  lead:          'Lead',
  director:      'Lead',
  vendor:        'Vendor',
  outsource:     'Vendor',
};

/** A stored seniority in its current spelling, or unchanged if unrecognised. */
export function normSeniority(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return '';
  if (SENIORITY.includes(raw)) return raw;
  return LEGACY_SENIORITY[raw.toLowerCase()] || raw;
}
