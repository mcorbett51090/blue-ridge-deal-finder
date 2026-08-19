/**
 * The paginated ArcGIS reader (plan §7 P2, §4.2, §4.3, RT-1, RT-2).
 *
 * This module decides WHAT to ask for and WHETHER THE ANSWER IS REAL. It never
 * opens a socket itself — every request goes through pipeline/fetch/client.ts,
 * which is the only module permitted to, and which has already applied PAUSE,
 * the denylist, registry completeness, UA honesty, live robots and the rate
 * limit before this file sees a byte.
 *
 * ⛔ HEALTH IS NEVER KEYED ON HTTP STATUS. Five separate HTTP-200-on-error cases
 * are recorded against these hosts:
 *   1. a nonexistent service under /secure/  -> 200 {"error":{"code":499,…}}   (E7.4)
 *   2. a query-level failure                 -> 200 {"error":{"code":400,…}}   (RT-1)
 *   3. a nonexistent service name            -> 200 {"error":{"code":404,…}}   (measured
 *      live at P2: .../NC1Map_ZZZNOSUCH/MapServer/1?f=json -> 200, 93 bytes)
 *   4. an UPPERCASE onStatisticField         -> 200 {"status":"error","messages":
 *      ["Could not access any server machines…"]} — an infrastructure-sounding
 *      message for what is a field-name typo                                   (P0 §8.3)
 *   5. EPQS (a sibling enrichment host)      -> 200 with a PLAIN-TEXT error     (P0 §7)
 * assertHealthy() is called on every page and asserts positive shape first.
 *
 * ⛔ PAGINATION SORTS ON THE OID FIELD, WHICH IS `objectid` (lowercase) AND IS
 * NOT DISCOVERABLE FROM `objectIdFieldName` (absent). See schema-fingerprint.ts
 * for the measurement and the controls. `orderByFields` is sent on every page
 * regardless — ArcGIS does not contract stable ordering without it, even though
 * P0 measured it holding.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { assertControlBlock, assertHealthy, type HealthExpectation } from './assert-healthy.ts';
import type { FetchClient } from './client.ts';
import { LayerMetadataSchema, objectIdFieldOf, type LayerMetadata } from './schema-fingerprint.ts';
import type { Source } from './types.ts';

/** An ArcGIS attribute bag. Values are unknown until normalize inspects them. */
export const AttributesSchema = z.record(z.string(), z.unknown());

export const QueryResponseSchema = z.object({
  features: z.array(z.object({ attributes: AttributesSchema, geometry: z.unknown().optional() })),
  exceededTransferLimit: z.boolean().optional(),
  fields: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
});

export const CountResponseSchema = z.object({ count: z.number().int().nonnegative() });

export type QueryResponse = z.infer<typeof QueryResponseSchema>;

/**
 * The fields requested on the attribute pass. An EXPLICIT list, never `*`:
 * `outFields=*` means an upstream schema addition silently starts flowing into
 * Tier 0 without passing the drift gate, and §4.4's whole argument is that a new
 * field arriving with owner data in it must not be able to ride downstream.
 *
 * The owner block IS fetched. It is consumed in memory by the redaction boundary
 * to derive three booleans and then discarded — that is what §4.4 means by
 * "consumed and then discarded", and it is why the boundary sits between the
 * health assert and the Tier-0 write rather than at the request.
 */
export const ATTRIBUTE_FIELDS = [
  // identity + key
  'objectid', 'parno', 'altparno', 'stcntyfips', 'cntyname', 'cntyfips', 'stfips',
  // value
  'parval', 'parvaltype', 'landval', 'improvval',
  // acreage
  'gisacres',
  // dates — saledate/sourcedate are epoch ms; reviseyear is a STRING
  'saledate', 'sourcedate', 'revisedate', 'reviseyear',
  // use / veto inputs
  'parusedesc', 'parusecode', 'owntype', 'presentval',
  // address — EMPTY STRING on vacant land, kept only as evidence of that
  'siteadd',
  // ⛔ PII. Consumed by redact.ts, never written to any tier.
  'ownname', 'ownname2', 'ownfrst', 'ownlast', 'mailadd', 'munit', 'mcity', 'mstate', 'mzip',
] as const;

/** How many times one page may be re-requested before the county fails. */
export const PAGE_RETRIES = 4;
export const PAGE_RETRY_BASE_MS = 3000;

/**
 * Is this body a TRANSIENT backend fault, as opposed to a real refusal?
 *
 * `{"status":"error","messages":["Could not access any server machines. Please
 * contact your system administrator."]}` is ArcGIS's way of saying the map
 * service instance is momentarily unavailable — and P0 §8.3 recorded the SAME
 * message being produced by a permanent field-name typo, so the message alone
 * does not distinguish them. The retry does: a typo still fails after four
 * attempts, a hiccup does not.
 *
 * An `error` object with a code (499 Token Required, 400 bad query, 404 no such
 * service) is NEVER transient — those are refusals, and retrying a refusal is
 * hammering a host that has already given its answer.
 */
export function isTransientInBandError(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  if ('error' in obj) return false;
  return obj['status'] === 'error';
}

export type CountyPlan = {
  county: string;
  minRows: number;
};

export type PageResult = {
  county: string;
  offset: number;
  rows: Record<string, unknown>[];
  exceededTransferLimit: boolean;
  bytes: number;
};

function queryUrlPath(): string {
  return '/query';
}

/** Layer metadata, parsed. Fetched ONCE per run, before any data query. */
export async function fetchLayerMetadata(
  client: FetchClient,
  source: Source,
): Promise<{ meta: LayerMetadata; bytes: number }> {
  const res = await client.fetchJson(source.id, { searchParams: { f: 'json' } });
  const body = res.body;
  // ⛔ Before zod: an in-band error parses as a perfectly valid object and would
  // fail the schema with a confusing "name: Required" instead of "the service
  // said 404". Name the real problem.
  assertNotInBandError(body, source.id, 'layer metadata');
  return { meta: LayerMetadataSchema.parse(body), bytes: res.bytes };
}

export function assertNotInBandError(body: unknown, sourceId: string, what: string): void {
  if (body === null || typeof body !== 'object') {
    throw new Error(`[${sourceId}] ${what}: body is ${body === null ? 'null' : typeof body}, not an object`);
  }
  const obj = body as Record<string, unknown>;
  if ('error' in obj) {
    throw new Error(`[${sourceId}] ${what}: in-band error at HTTP 200 — ${JSON.stringify(obj['error'])}`);
  }
  // Shape 4 above: `status: 'error'` with a `messages` array, no `error` key.
  if (obj['status'] === 'error') {
    throw new Error(`[${sourceId}] ${what}: in-band {status:'error'} — ${JSON.stringify(obj['messages'])}`);
  }
}

/** A `returnCountOnly` query. Used by the control block and the row-count check. */
export async function fetchCount(
  client: FetchClient,
  source: Source,
  where: string,
): Promise<number> {
  const res = await client.fetchJson(source.id, {
    path: queryUrlPath(),
    searchParams: { where, returnCountOnly: 'true', f: 'json' },
  });
  assertNotInBandError(res.body, source.id, `count(${where})`);
  return CountResponseSchema.parse(res.body).count;
}

/**
 * RT-1 fix #3 — THE PER-BATCH CONTROL BLOCK, run before every county's pages.
 *
 * A batch whose positive control misses its count is a FAILED run, not a clean
 * one, and identical positive/negative results mean the endpoint is answering a
 * constant — which is exactly how the 866-row fake NC failover presented.
 */
export async function runControlBlock(
  client: FetchClient,
  source: Source,
): Promise<{ positiveCount: number; negativeCount: number }> {
  const positiveCount = await fetchCount(client, source, source.control_block.positive.where);
  const negativeCount = await fetchCount(client, source, source.control_block.negative.where);
  assertControlBlock(
    { positiveCount, negativeCount },
    {
      positiveCount: source.control_block.positive.expect_count,
      negativeCount: source.control_block.negative.expect_count,
    },
    source.id,
  );
  // The observed counts are RETURNED, not re-fetched by the caller for the
  // manifest. Two extra count queries per run is not a lot; asking a county
  // government endpoint the same question twice because the plumbing was
  // convenient is exactly the posture §3.4 is about.
  return { positiveCount, negativeCount };
}

export type ObjectIdEnvelope = { min: number; max: number };

/**
 * §4.3 — the OBJECTID envelope, read before and after a county's pages. A
 * mid-run republish reassigns OBJECTIDs and skews `resultOffset` pagination
 * silently: every page after the republish is drawn from a different ordering,
 * and the row COUNT still comes out plausible. Abort; never stitch.
 */
export async function fetchObjectIdEnvelope(
  client: FetchClient,
  source: Source,
  where: string,
  oidField: string,
): Promise<ObjectIdEnvelope> {
  const res = await client.fetchJson(source.id, {
    path: queryUrlPath(),
    searchParams: {
      where,
      // ⛔ LOWERCASE. P0 §8.3 recorded that the uppercase spelling returns HTTP
      // 200 with "Could not access any server machines" — an infrastructure
      // message for a field-name error.
      outStatistics: JSON.stringify([
        { statisticType: 'min', onStatisticField: oidField, outStatisticFieldName: 'mn' },
        { statisticType: 'max', onStatisticField: oidField, outStatisticFieldName: 'mx' },
      ]),
      f: 'json',
    },
  });
  assertNotInBandError(res.body, source.id, `oid envelope(${where})`);
  const parsed = QueryResponseSchema.parse(res.body);
  const attrs = parsed.features[0]?.attributes;
  if (!attrs) throw new Error(`[${source.id}] oid envelope returned no statistics row for ${where}`);
  const min = attrs['mn'];
  const max = attrs['mx'];
  if (typeof min !== 'number' || typeof max !== 'number') {
    throw new Error(
      `[${source.id}] oid envelope min/max are ${typeof min}/${typeof max}, not numbers — ` +
        'refusing to page against an envelope that is not there',
    );
  }
  return { min, max };
}

export type ReadCountyOptions = {
  client: FetchClient;
  source: Source;
  county: string;
  oidField: string;
  pageSize: number;
  minRows: number;
  /** Attribute pass sends returnGeometry=false; the quarterly pass sends true. */
  withGeometry?: boolean;
  onPage?: (page: PageResult) => void | Promise<void>;
  /** Hard cap on pages, so a pathological loop cannot hammer the endpoint. */
  maxPages?: number;
};

export function countyWhere(county: string): string {
  // Single quotes are the SQL string delimiter here; a county name containing
  // one would break the clause. Doubling is the SQL-92 escape and is applied
  // rather than assumed-absent — 'O'Brien County' exists in other states and
  // this reader is not NC-only forever.
  return `cntyname='${county.replace(/'/g, "''")}'`;
}

/**
 * Read one county, page by page, calling `onPage` for each healthy page.
 *
 * Returns the rows only if the caller did not supply `onPage`; with `onPage`
 * the rows are streamed and not retained, because holding 134,741 Buncombe rows
 * and their 71 attributes in one array is how a hosted runner runs out of heap
 * at the last county of the run.
 */
export async function readCounty(options: ReadCountyOptions): Promise<{
  county: string;
  pages: number;
  rows: number;
  bytes: number;
  envelopeBefore: ObjectIdEnvelope;
  envelopeAfter: ObjectIdEnvelope;
}> {
  const { client, source, county, oidField, pageSize, minRows } = options;
  const where = countyWhere(county);
  const maxPages = options.maxPages ?? 1000;

  const envelopeBefore = await fetchObjectIdEnvelope(client, source, where, oidField);

  let offset = 0;
  let pages = 0;
  let rows = 0;
  let bytes = 0;

  for (;;) {
    if (pages >= maxPages) {
      throw new Error(`[${source.id}] ${county}: exceeded maxPages=${maxPages} — refusing to keep requesting`);
    }
    const searchParams: Record<string, string> = {
      where,
      outFields: ATTRIBUTE_FIELDS.join(','),
      returnGeometry: options.withGeometry === true ? 'true' : 'false',
      // ⛔ The OID field name, lowercase, from the layer's own field types.
      orderByFields: oidField,
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      f: 'json',
    };
    // §4.1/R8 — outSR on EVERY geometry request, not just the quarterly pass.
    // Extent SR is wkid 102719 (NC State Plane FEET); un-reprojected coordinates
    // render nowhere, silently.
    if (options.withGeometry === true) searchParams['outSR'] = '4326';

    // A TRANSIENT IN-BAND ERROR NEEDS A BOUNDED RETRY, AND THE CLIENT CANNOT
    // DO IT. client.ts retries on HTTP 429/5xx, but this endpoint answers a
    // transient backend fault with HTTP 200 and
    // `{"status":"error","messages":["Could not access any server machines..."]}`
    // — observed live at P2, on page 3 of a Watauga run that had already served
    // 10,000 rows correctly. The client sees a 200 and returns; only the health
    // assertion knows anything is wrong. Without this loop a 101-page run has to
    // win 101 consecutive coin flips, so it would essentially never complete.
    //
    // Bounded, backed off, and it gives up rather than looping: a persistent
    // error still fails the county, which is what leaves existing rows
    // untouched. Retrying an in-band error forever is how a polite client
    // becomes an impolite one.
    const expectation: HealthExpectation = { minRows: 0, paging: true };
    let page: QueryResponse | null = null;
    let bodyBytes = 0;
    let lastHealthError: unknown = null;
    for (let attempt = 1; attempt <= PAGE_RETRIES; attempt++) {
      const res = await client.fetchJson(source.id, { path: queryUrlPath(), searchParams });
      try {
        // Health FIRST, on the body, before zod and before any count is
        // compared. `paging: true` because a full page legitimately sets
        // exceededTransferLimit; the floor is 0 per PAGE — the per-county floor
        // is asserted below on the TOTAL, which is what it was measured against.
        assertHealthy(res.body, expectation, source.id);
        page = QueryResponseSchema.parse(res.body);
        bodyBytes = res.bytes;
        break;
      } catch (err) {
        lastHealthError = err;
        if (!isTransientInBandError(res.body) || attempt === PAGE_RETRIES) throw err;
        await sleep(PAGE_RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
    if (!page) {
      throw lastHealthError instanceof Error
        ? lastHealthError
        : new Error(`[${source.id}] ${county}: page at offset ${offset} never returned a healthy body`);
    }
    bytes += bodyBytes;

    if (page.features.length === 0) break;

    pages++;
    rows += page.features.length;
    if (options.onPage) {
      await options.onPage({
        county,
        offset,
        rows: page.features.map((f) => f.attributes),
        exceededTransferLimit: page.exceededTransferLimit === true,
        bytes: bodyBytes,
      });
    }

    // A short page is the last page. `exceededTransferLimit` agrees, but the
    // length is the fact and the flag is the claim — trust the fact.
    if (page.features.length < pageSize) break;
    offset += page.features.length;
  }

  const envelopeAfter = await fetchObjectIdEnvelope(client, source, where, oidField);

  // The floor, asserted on the TOTAL and expressed as a positive comparison of
  // two numbers we provably have — never `undefined < floor`.
  if (rows < minRows) {
    throw new Error(
      `[${source.id}] ${county}: FLOOR FAILED — ${rows} rows < measured floor ${minRows}. ` +
        'Existing rows are left untouched; this run contributes nothing for this county.',
    );
  }

  return { county, pages, rows, bytes, envelopeBefore, envelopeAfter };
}

export { objectIdFieldOf };
