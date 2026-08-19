/**
 * The empty-state copy, in ONE place.
 *
 * It lives in its own module because it is rendered twice — server-side by
 * EmptyState.astro and client-side by the filter rail as the reader narrows —
 * and those two must never drift. The whole requirement is a single line of
 * copy; a second copy of that line is a second chance to get it wrong.
 *
 * THE RULE: keyed off `tier`, NEVER off a row count. A row count cannot
 * distinguish "covered county, genuinely nothing there" from "county we cannot
 * see at all", and those are opposite facts.
 */
import type { CoverageTier } from './types';

export interface EmptyArgs {
  /** undefined => the county is not in the tracked set at all */
  tier?: CoverageTier | undefined;
  county?: string | undefined;
  state?: string | undefined;
  /** true when the reader's filters emptied the list, rather than the data */
  filtered?: boolean;
  /** TRUE when the lane has no rows in the PAYLOAD at all — a missing source,
   *  not a filtering outcome. */
  sourceMissing?: boolean;
  lane?: 'market' | 'prospect';
}

export interface EmptyCopy {
  heading: string;
  body: string;
  /** Show the "see coverage" link — only where coverage is the explanation. */
  showStatusLink: boolean;
  tierKey: CoverageTier | 'uncovered';
}

const TIER_NOUN: Record<CoverageTier, string> = {
  rich: 'rich coverage',
  partial: 'partial coverage',
  thin: 'thin coverage',
  'notices-only': 'notices-only coverage',
};

export function emptyCopy(a: EmptyArgs): EmptyCopy {
  const where = a.county ? `${a.county} County${a.state ? `, ${a.state}` : ''}` : 'this area';

  if (a.tier === undefined) {
    return {
      heading: 'Not a tracked county',
      body: `${where} is not one of the counties this project collects. Its absence here says nothing about what is happening there.`,
      showStatusLink: true,
      tierKey: 'uncovered',
    };
  }

  if (a.tier === 'notices-only') {
    return {
      heading: `No parcel or assessment data is collected for ${where}`,
      body: `No parcel data source exists for this county — anything shown here is a published notice, not a parcel record. An empty result means we cannot see this county, not that nothing is for sale in it.`,
      showStatusLink: true,
      tierKey: 'notices-only',
    };
  }

  if (a.tier === 'thin') {
    return {
      heading: `Coverage in ${where} is thin`,
      body: `Only a partial or untested source exists here, so most parcel attributes are unknown. Read an empty result as "mostly unknown", not as "nothing here".`,
      showStatusLink: true,
      tierKey: 'thin',
    };
  }

  // ⛔ A lane with ZERO rows in the payload is not a filtering result, and
  // saying "no matches for these filters" invites the reader to widen a filter
  // that was never the cause. Lane 1 is empty today because no for-sale or
  // distress source has been ingested yet — the parcel corpus is loaded, the
  // evidence join is not. Those are different facts and the copy must say which.
  if (a.lane === 'market' && a.sourceMissing === true) {
    return {
      heading: 'No for-sale or distress source is connected yet',
      body:
        'The parcel corpus is loaded and scored, but nothing has been joined to it that says a ' +
        'property is actually for sale — foreclosure notices, tax-sale rosters and estate filings ' +
        'are a separate ingest that has not run. This lane is empty because that source is missing, ' +
        'not because your filters excluded anything. The prospecting lane below has every scored parcel.',
      showStatusLink: true,
      tierKey: a.tier,
    };
  }

  if (a.filtered) {
    return {
      heading: 'No matches for these filters',
      body: `${where} has ${TIER_NOUN[a.tier]} and rows in the payload — your current filters just exclude all of them. Widen a range or clear a toggle.`,
      showStatusLink: false,
      tierKey: a.tier,
    };
  }

  const noun = a.lane === 'prospect' ? 'records' : 'on-market or distressed properties';
  return {
    heading: `No ${noun} found in ${where}`,
    body: `${where} has ${TIER_NOUN[a.tier]} — parcel data ${a.tier === 'rich' ? 'and assessed values are' : 'is'} collected here, and the county is genuinely quiet right now. This is a real zero, not a gap.`,
    showStatusLink: false,
    tierKey: a.tier,
  };
}
