/**
 * Hard vetoes (plan §5.6). NOT deductions.
 *
 * ⛔ MEASURED, LIVE WAREHOUSE, 2026-08-19. `SELECT ... ORDER BY value/acreage ASC`
 * over the ingested NC corpus returned, as the twelve cheapest rows on the
 * board, twelve Watauga parcels at value=$100 for 5.7-134.2 acres — every one
 * of them `parusedesc = 'EXCLUSIONS (COMMONE AREAS)'` and `owner_is_government=1`.
 * HOA common land carries a nominal $100 assessment precisely BECAUSE it cannot
 * be sold, which is the exact shape of a bargain to a $/acre sort.
 *
 * A deduction would not have fixed it: at $0.75/acre against a county median in
 * the thousands, any finite penalty leaves them on top. They are removed from
 * the RANKING entirely — and they keep their score and their reason, so a
 * filtered-out row still explains itself rather than vanishing.
 *
 * ⛔ THE UPSTREAM TYPO 'COMMONE' IS REAL. It is matched, and so is the spelling
 * it was meant to be, and so is the singular. Matching only the typo would
 * fail open the day the county fixes it.
 */
import type { ScoreConfig } from './config.ts';

export type VetoInput = {
  owner_is_government: number | boolean | null;
  parusedesc: string;
  acreage: number | null;
  /** SITUS address. A second, INDEPENDENT signal of unpurchasability — see the
   *  `situs_excluded` gate below for why it is not redundant with parusedesc. */
  siteadd?: string | null;
};

/** Plan §5 calls these `gates`: reported separately from the score, never folded
 *  into it. `passed: false` means the row is vetoed out of the ranking. */
export type Gate = { id: string; passed: boolean; basis: string };

export function useClassPatterns(cfg: ScoreConfig): RegExp[] {
  return cfg.vetoes.use_class_patterns.map((p) => new RegExp(p, 'i'));
}

export function evaluateGates(row: VetoInput, cfg: ScoreConfig, patterns = useClassPatterns(cfg)): Gate[] {
  const gates: Gate[] = [];

  const isGov = row.owner_is_government === 1 || row.owner_is_government === true;
  gates.push({
    id: 'owner_is_government',
    passed: !isGov,
    basis: isGov
      ? 'Owner name matches a government body — public land is not for sale at any price.'
      : 'Owner name does not match a government body.',
  });

  const use = row.parusedesc.replace(/\s+/g, ' ').trim();
  const hit = patterns.find((re) => re.test(use));
  gates.push({
    id: 'use_class_excluded',
    passed: hit === undefined,
    basis:
      hit === undefined
        ? `Use class ${use === '' ? '(none published)' : `'${use}'`} is not on the excluded list.`
        : `Use class '${use}' is structurally not purchasable (HOA common area, government, cemetery or right-of-way).`,
  });

  // ⛔ THE ADDRESS IS A SECOND, INDEPENDENT VETO SIGNAL — added 2026-08-19 after
  // publishing addresses exposed a scoring defect.
  //
  // Measured: 19 of 500 published rows had an address saying plainly that the
  // parcel is not purchasable — "Common Area-Windy Gap Ln", "ROAD R/W SILVER
  // SLIP", "BARBERRY HTS HOA-WELL LOT" — and ALL NINETEEN SCORED 100, the
  // maximum. They sat at the very top of the ranking.
  //
  // They passed `use_class_excluded` because their parusedesc is EMPTY: the
  // county publishes no use code, so the use-class veto had nothing to match.
  // A veto with one input fails silently wherever that input is absent, and
  // absence is exactly where the bad rows were hiding. Two independent signals
  // do not have the same blind spot.
  const situs = (row.siteadd ?? '').replace(/\s+/g, ' ').trim();
  const situsHit = situs === '' ? undefined : patterns.find((re) => re.test(situs));
  gates.push({
    id: 'situs_excluded',
    passed: situsHit === undefined,
    basis:
      situs === ''
        ? 'No situs address published, so it carries no signal either way.'
        : situsHit === undefined
          ? `Situs address '${situs}' does not name an excluded use.`
          : `Situs address '${situs}' names a structurally unpurchasable use (HOA common area, right-of-way, well lot or similar) even though the county published no use code.`,
  });

  // Unknown acreage does NOT trip this gate. "We do not know how big it is" is
  // not "it is too small", and conflating them vetoes every row a county
  // declines to publish acreage for.
  const tooSmall = row.acreage !== null && row.acreage < cfg.vetoes.min_acres;
  gates.push({
    id: 'acreage_below_min',
    passed: !tooSmall,
    basis: tooSmall
      ? `${row.acreage} ac is below the ${cfg.vetoes.min_acres} ac floor — a remnant strip, not a parcel.`
      : row.acreage === null
        ? 'Acreage unknown — not treated as below the floor.'
        : `${row.acreage} ac is at or above the ${cfg.vetoes.min_acres} ac floor.`,
  });

  return gates;
}

export function isVetoed(gates: readonly Gate[]): boolean {
  return gates.some((g) => !g.passed);
}

export function vetoReasons(gates: readonly Gate[]): string[] {
  return gates.filter((g) => !g.passed).map((g) => g.id);
}
