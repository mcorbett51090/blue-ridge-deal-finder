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
