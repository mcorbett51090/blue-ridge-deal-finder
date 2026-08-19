export const site = {
  name: 'Blue Ridge Deal Finder',
  short: 'BRDF',
  tagline: 'Land and property signals across 37 Blue Ridge counties',
  /** Named in /about/ so an annoyed county admin has a cheap escalation path
   *  that does not destroy the data (plan §6.4 RT-4). */
  contact: 'matt@ravenpower.net',
  crawlerUA: 'blue-ridge-deal-finder/0.1 (+contact matt@ravenpower.net)',
  /** The freshness bar Lane 1 is measured against, in hours (plan §6.6). */
  lane1FreshHours: 48,
} as const;
