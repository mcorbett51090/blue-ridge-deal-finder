/**
 * The schema fingerprint — compared against `?f=json` BEFORE any data query
 * (plan §7 P2 pre-build gate). A mismatch aborts the run and ingests nothing.
 *
 * ⛔ MEASURED TRAP (P0 §8.1; re-measured live at P2, 2026-08-19, with controls —
 * see sources/evidence/schema/nc-onemap-parcels.MapServer-1.f-json.json, the
 * exact 12,387-byte body the probe parsed):
 *
 *     Object.hasOwn(meta, 'objectIdFieldName')  -> false     <- the trap
 *     Object.hasOwn(meta, 'fields')             -> true, 71  <- positive control,
 *                                                              same object, same
 *                                                              method: the probe
 *                                                              CAN see present keys
 *     meta.fields.find(f => f.type === 'esriFieldTypeOID').name -> 'objectid'
 *     a live query page: Object.keys(features[0].attributes)[0] -> 'objectid'
 *     the same page:     fieldAliases.objectid                  -> 'OBJECTID'
 *
 * So: a client that reads the documented property gets `undefined`, and the
 * ALIAS is uppercase while the attribute KEY is lowercase. `outFields=OBJECTID`
 * is accepted by the server, but `feature.attributes.OBJECTID` then reads
 * `undefined` — the same `undefined < floor === false` shape this project has
 * already been bitten by twice.
 *
 * Hence `objectIdFieldOf()`: it never trusts the documented property alone and
 * never guesses a casing. It finds the field whose declared TYPE is
 * `esriFieldTypeOID`, which is the only self-describing answer available.
 *
 * WHAT THE FINGERPRINT COVERS, and why exactly this:
 *   - every field's NAME and TYPE, sorted — the drift the pipeline actually
 *     cares about (acceptance 5: a renamed field trips the gate)
 *   - geometryType — the polygon/point distinction the whole plan turns on
 *   - the OID field name — pagination depends on it
 * WHAT IT DELIBERATELY EXCLUDES: `currentVersion`, `description`, `drawingInfo`,
 * `extent`, `serviceItemId` and the other ~55 presentation keys. A fingerprint
 * over the whole body goes red on a symbology edit, and a gate that cries wolf
 * gets its constant bumped without anyone reading the diff — disabled while
 * still appearing to run.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Only the keys the fingerprint reads. Unknown keys pass through untouched. */
export const LayerMetadataSchema = z.object({
  name: z.string(),
  geometryType: z.string(),
  maxRecordCount: z.number().int().positive(),
  fields: z
    .array(z.object({ name: z.string(), type: z.string() }))
    .min(1, 'a layer with zero fields is a failed read, not a schema'),
  /** ⛔ ABSENT on this layer. Optional here so the parse does not throw before
   *  objectIdFieldOf() gets the chance to say why it is absent. */
  objectIdFieldName: z.string().optional(),
});

export type LayerMetadata = z.infer<typeof LayerMetadataSchema>;

export class SchemaDriftError extends Error {
  readonly sourceId: string;
  readonly expected: string;
  readonly actual: string;
  readonly added: string[];
  readonly removed: string[];
  constructor(sourceId: string, expected: string, actual: string, added: string[], removed: string[]) {
    const detail =
      added.length || removed.length
        ? `field(s) ADDED: [${added.join(', ')}]; field(s) REMOVED: [${removed.join(', ')}]`
        : 'field list identical — geometryType, maxRecordCount or the OID field changed';
    super(
      `[${sourceId}] SCHEMA DRIFT — expected ${expected}, got ${actual}. ${detail}. ` +
        'Run aborted BEFORE any data query; nothing was ingested.',
    );
    this.name = 'SchemaDriftError';
    this.sourceId = sourceId;
    this.expected = expected;
    this.actual = actual;
    this.added = added;
    this.removed = removed;
  }
}

export const OID_FIELD_TYPE = 'esriFieldTypeOID';

/**
 * The OID field name, derived from the field TYPE rather than from the absent
 * `objectIdFieldName` property. Returns the name exactly as upstream spells it
 * (`objectid`, lowercase, on this layer) because that is the key the query
 * response uses for the attribute.
 */
export function objectIdFieldOf(meta: LayerMetadata): string {
  const declared = meta.objectIdFieldName;
  const byType = meta.fields.find((f) => f.type === OID_FIELD_TYPE);
  if (byType) {
    // If upstream ever DOES publish objectIdFieldName and it disagrees with the
    // typed field, that is a schema we do not understand — refuse rather than
    // pick a winner and page on the loser.
    if (declared !== undefined && declared !== byType.name) {
      throw new Error(
        `objectIdFieldName='${declared}' disagrees with the ${OID_FIELD_TYPE} field '${byType.name}' — ` +
          'refusing to guess which one pagination should sort on',
      );
    }
    return byType.name;
  }
  if (declared !== undefined) return declared;
  throw new Error(
    `no field of type ${OID_FIELD_TYPE} and no objectIdFieldName — this layer cannot be paged deterministically`,
  );
}

/** The canonical, order-independent shape the fingerprint is taken over. */
export function canonicalSchema(meta: LayerMetadata): string {
  const fields = meta.fields
    .map((f) => `${f.name}:${f.type}`)
    .slice()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    geometryType: meta.geometryType,
    maxRecordCount: meta.maxRecordCount,
    objectIdField: objectIdFieldOf(meta),
    fieldCount: fields.length,
    fields,
  });
}

export function schemaFingerprint(meta: LayerMetadata): string {
  return createHash('sha256').update(canonicalSchema(meta)).digest('hex');
}

export function fieldNames(meta: LayerMetadata): string[] {
  return meta.fields.map((f) => f.name);
}

/**
 * The pre-build gate. Throws SchemaDriftError naming the added and removed
 * fields — "a renamed field trips the drift gate LOUDLY" (acceptance 5) means
 * the operator must see WHICH field without re-running anything. A rename shows
 * up as one addition and one removal, which is the signature to look for.
 */
export function assertSchemaFingerprint(
  meta: LayerMetadata,
  expected: string,
  sourceId: string,
  knownFields?: readonly string[],
): void {
  const actual = schemaFingerprint(meta);
  if (actual === expected.replace(/^sha256:/i, '').toLowerCase()) return;

  const now = new Set(fieldNames(meta));
  const before = new Set(knownFields ?? []);
  const added = [...now].filter((f) => !before.has(f)).sort();
  const removed = [...before].filter((f) => !now.has(f)).sort();
  throw new SchemaDriftError(sourceId, expected, actual, added, removed);
}
