import { CATALOG_MAX_ROWS } from "@/_defs";
import type { PostgresDriver } from "./postgres-driver";

// Catalog reads go through the same execute() as the model's SQL — guarded, read-only, rolled back.
// The relation-detail queries take the oid the server just returned, inlined as a number, so the
// seven of them run as one call: through a tunnel each call is several round trips.
// Written for PostgreSQL 12+ (pg_partition_tree, pg_attribute.attgenerated).
// Every name comes back as SQL writes it (quote_ident), so a name copied from the output means the same object in a query.

/**
 * `schema.name` of the relation `oidExpression` points at, always schema-qualified — `::regclass::text`
 * leaves the schema out when the session's search_path reaches it, so the name would depend on it.
 */
function qualifiedNameOf(oidExpression: string): string {
    return `(SELECT quote_ident(qn.nspname) || '.' || quote_ident(qc.relname) FROM pg_class qc JOIN pg_namespace qn ON qn.oid = qc.relnamespace WHERE qc.oid = ${oidExpression})`;
}

/**
 * A partition is listed under its parent — except when the parent lives in another schema, where
 * hiding it would make its own schema look empty.
 */
const LISTED_RELATION_FILTER = `NOT (c.relispartition AND EXISTS (
    SELECT 1 FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
    WHERE i.inhrelid = c.oid AND p.relnamespace = c.relnamespace))`;

/** A partitioned parent stores nothing itself: its size and rows are its leaf partitions'. */
const RELATION_SIZE_SQL = `CASE
           WHEN c.relkind = 'p' THEN pg_size_pretty((SELECT sum(pg_total_relation_size(t.relid)) FROM pg_partition_tree(c.oid) t WHERE t.isleaf))
           WHEN c.relkind IN ('r', 'm') THEN pg_size_pretty(pg_total_relation_size(c.oid))
       END`;
// A partial sum is marked as one: a partition never analyzed (reltuples -1) — often the newest, holding most rows — adds nothing to it
const RELATION_ROWS_SQL = `CASE
           WHEN c.relkind = 'p' THEN (
               SELECT CASE
                          WHEN bool_and(l.reltuples >= 0) THEN sum(l.reltuples)::bigint::text
                          WHEN bool_or(l.reltuples >= 0) THEN '≥' || (sum(l.reltuples) FILTER (WHERE l.reltuples >= 0))::bigint
                              || ' (' || count(*) FILTER (WHERE l.reltuples < 0) || ' of ' || count(*) || ' leaf partitions never analyzed)'
                      END
               FROM pg_partition_tree(c.oid) t JOIN pg_class l ON l.oid = t.relid WHERE t.isleaf)
           WHEN c.relkind IN ('r', 'm') AND c.reltuples >= 0 THEN c.reltuples::bigint::text
       END`;
// The partition count is of direct children — the partitions section of db_describe lists exactly those
const RELATION_KIND_SQL = `CASE
           WHEN c.relispartition THEN CASE c.relkind WHEN 'f' THEN 'foreign table, ' WHEN 'p' THEN 'partitioned table, ' ELSE '' END
                                      || 'partition of ' || (SELECT ${qualifiedNameOf("i.inhparent")} FROM pg_inherits i WHERE i.inhrelid = c.oid)
           WHEN c.relkind = 'p' THEN (SELECT 'partitioned table, ' || count(*) || CASE count(*) WHEN 1 THEN ' partition' ELSE ' partitions' END
                                      FROM pg_inherits i WHERE i.inhparent = c.oid)
           WHEN c.relkind = 'r' THEN 'table' WHEN c.relkind = 'v' THEN 'view' WHEN c.relkind = 'm' THEN 'materialized view'
           WHEN c.relkind = 'f' THEN 'foreign table' WHEN c.relkind = 'S' THEN 'sequence'
       END`;

const SCHEMAS_SQL = `
SELECT quote_ident(n.nspname) AS schema,
       pg_get_userbyid(n.nspowner) AS owner,
       count(c.oid) FILTER (WHERE c.relkind IN ('r', 'p', 'f'))::int AS tables,
       count(c.oid) FILTER (WHERE c.relkind IN ('v', 'm'))::int AS views,
       count(c.oid) FILTER (WHERE c.relkind = 'S')::int AS sequences,
       obj_description(n.oid, 'pg_namespace') AS comment
FROM pg_namespace n
LEFT JOIN pg_class c ON c.relnamespace = n.oid AND ${LISTED_RELATION_FILTER}
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND n.nspname NOT LIKE 'pg\\_temp\\_%'
  AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
GROUP BY n.oid, n.nspname, n.nspowner
ORDER BY n.nspname`;

const RELATIONS_SQL = `
SELECT quote_ident(c.relname) AS name,
       ${RELATION_KIND_SQL} AS kind,
       ${RELATION_ROWS_SQL} AS approx_rows,
       ${RELATION_SIZE_SQL} AS size,
       obj_description(c.oid, 'pg_class') AS comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND ${LISTED_RELATION_FILTER}
ORDER BY CASE c.relkind WHEN 'r' THEN 0 WHEN 'p' THEN 0 WHEN 'v' THEN 1 WHEN 'm' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, c.relname`;

const TYPES_SQL = `
SELECT quote_ident(t.typname) AS name,
       CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'd' THEN 'domain' ELSE 'composite' END AS kind,
       CASE t.typtype
           WHEN 'e' THEN (SELECT string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
           WHEN 'd' THEN format_type(t.typbasetype, t.typtypmod)
           WHEN 'c' THEN (SELECT string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
                          FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped)
       END AS detail
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = $1
  AND (t.typtype IN ('e', 'd') OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class r WHERE r.oid = t.typrelid AND r.relkind = 'c')))
ORDER BY 2, t.typname`;

/** $1 lists candidate spellings in preference order, as in RELATION_SQL; `name` is the stored one, `shown` as SQL writes it. */
const SCHEMA_SQL = `
SELECT n.nspname AS name, quote_ident(n.nspname) AS shown
FROM pg_namespace n
WHERE n.nspname = ANY($1::text[])
ORDER BY array_position($1::text[], n.nspname::text)`;

/**
 * $1 / $2 are candidate spellings in preference order — how SQL reads the name first (an unquoted
 * name folded to lower case), then the name as typed. $1 null: the session's search_path, temp schema
 * and pg_catalog included, in the order SQL resolves an unqualified name. The name's spelling ranks
 * first, so the SQL reading found anywhere on the path beats the typed spelling in an earlier schema.
 * Every match comes back, so a second object the same spelling could mean is reported rather than
 * silently passed over.
 */
const RELATION_SQL = `
SELECT c.oid AS oid, quote_ident(n.nspname) AS schema, quote_ident(c.relname) AS name, c.relkind::text AS relkind,
       ${RELATION_KIND_SQL} AS kind,
       ${RELATION_ROWS_SQL} AS approx_rows,
       ${RELATION_SIZE_SQL} AS size,
       obj_description(c.oid, 'pg_class') AS comment,
       CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS view_definition,
       CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partition_key,
       CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END AS partition_bound,
       CASE WHEN NOT c.relispartition THEN
           (SELECT string_agg(${qualifiedNameOf("i.inhparent")}, ', ' ORDER BY i.inhseqno) FROM pg_inherits i WHERE i.inhrelid = c.oid)
       END AS inherits_from
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ANY(coalesce($1::text[], current_schemas(true)::text[])) AND c.relname = ANY($2::text[]) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
ORDER BY array_position($2::text[], c.relname::text), array_position(coalesce($1::text[], current_schemas(true)::text[]), n.nspname::text)
LIMIT 5`;

// enum_values: the column's type, its element type (an enum[]), or its base type (a domain over an enum)
const COLUMNS_SQL = `
SELECT quote_ident(a.attname) AS name,
       format_type(a.atttypid, a.atttypmod) AS type,
       a.attnotnull AS not_null,
       pg_get_expr(d.adbin, d.adrelid) AS default_value,
       CASE a.attidentity WHEN 'a' THEN 'always' WHEN 'd' THEN 'by default' END AS identity,
       CASE a.attgenerated WHEN 's' THEN 'stored' WHEN 'v' THEN 'virtual' END AS generated,
       (SELECT string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) FROM pg_enum e
        WHERE e.enumtypid IN (a.atttypid, t.typelem, t.typbasetype)) AS enum_values,
       col_description(a.attrelid, a.attnum) AS comment
FROM pg_attribute a
JOIN pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = {oid}::oid AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum;`;

// Left out: a validated NOT NULL (contype 'n', PostgreSQL 18 — the column list says it), and the
// copies PostgreSQL makes of one FK for each partition of the table it references
const CONSTRAINTS_SQL = `
SELECT quote_ident(c.conname) AS name,
       CASE c.contype WHEN 'p' THEN 'primary key' WHEN 'u' THEN 'unique' WHEN 'f' THEN 'foreign key'
                      WHEN 'c' THEN 'check' WHEN 'x' THEN 'exclusion' WHEN 'n' THEN 'not null' ELSE c.contype::text END AS type,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.conrelid = {oid}::oid
  AND (c.contype <> 'n' OR NOT c.convalidated)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint p WHERE p.oid = c.conparentid AND p.conrelid = c.conrelid)
ORDER BY CASE c.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, c.conname;`;

// conparentid = 0: one row per declared FK, not one per partition of the referencing table
const REFERENCED_BY_SQL = `
SELECT quote_ident(n.nspname) AS from_schema, quote_ident(r.relname) AS from_table, quote_ident(c.conname) AS name, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE c.confrelid = {oid}::oid AND c.contype = 'f' AND c.conparentid = 0
ORDER BY n.nspname, r.relname, c.conname;`;

// idx_scan counts the index's use since this database's statistics were last reset (stats_reset; null when never) —
// the one fact behind "is this index unused?". A standby keeps its own counters, so a primary's count misses reads there.
const INDEXES_SQL = `
SELECT quote_ident(ic.relname) AS name, pg_get_indexdef(i.indexrelid) AS definition, pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
       i.indisvalid AS valid, ic.relkind::text AS index_kind, st.idx_scan AS scans,
       (SELECT date_trunc('second', d.stats_reset)::text FROM pg_stat_database d WHERE d.datname = current_database()) AS stats_reset
FROM pg_index i
JOIN pg_class ic ON ic.oid = i.indexrelid
LEFT JOIN pg_stat_all_indexes st ON st.indexrelid = i.indexrelid
WHERE i.indrelid = {oid}::oid
ORDER BY i.indisprimary DESC, ic.relname;`;

const TRIGGERS_SQL = `
SELECT quote_ident(tgname) AS name, pg_get_triggerdef(oid, true) AS definition, tgenabled::text AS enabled_state
FROM pg_trigger
WHERE tgrelid = {oid}::oid AND NOT tgisinternal
ORDER BY tgname;`;

// Declarative partitions and old-style INHERITS children both live in pg_inherits; is_partition tells them apart
const PARTITIONS_SQL = `
SELECT ${qualifiedNameOf("i.inhrelid")} AS name, pg_get_expr(c.relpartbound, c.oid) AS bound, c.relkind = 'p' AS partitioned,
       c.relispartition AS is_partition
FROM pg_inherits i
JOIN pg_class c ON c.oid = i.inhrelid
WHERE i.inhparent = {oid}::oid
ORDER BY c.relnamespace::regnamespace::text, c.relname;`;

const SEQUENCE_SQL = `
SELECT format_type(s.seqtypid, NULL) AS type, s.seqstart AS start, s.seqincrement AS increment,
       s.seqmin AS min, s.seqmax AS max, s.seqcache AS cache, s.seqcycle AS cycle,
       (SELECT ${qualifiedNameOf("d.refobjid")} || '.' || quote_ident(a.attname)
        FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
        WHERE d.classid = 'pg_class'::regclass AND d.objid = s.seqrelid AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
        LIMIT 1) AS owned_by
FROM pg_sequence s
WHERE s.seqrelid = {oid}::oid`;

export interface CatalogRows {
    rows: Record<string, unknown>[];
    /** More than CATALOG_MAX_ROWS existed; the rest were not read. */
    truncated: boolean;
}

export interface RelationDescription {
    /** As SQL writes it — quoted when it has to be. */
    schema: string;
    /** As SQL writes it — quoted when it has to be. */
    name: string;
    /** `r`, `p`, `v`, `m`, `f` or `S`. */
    relkind: string;
    kind: string;
    approxRows: string | null;
    size: string | null;
    comment: string | null;
    viewDefinition: string | null;
    partitionKey: string | null;
    /** `FOR VALUES …` when this is a partition. */
    partitionBound: string | null;
    /** Parents of an old-style INHERITS child, comma-separated. */
    inheritsFrom: string | null;
    columns: Record<string, unknown>[];
    constraints: Record<string, unknown>[];
    referencedBy: Record<string, unknown>[];
    indexes: Record<string, unknown>[];
    triggers: Record<string, unknown>[];
    partitions: Record<string, unknown>[];
    /** More partitions or INHERITS children exist than CATALOG_MAX_ROWS listed — the two are read together. */
    partitionsTruncated: boolean;
    /** Old-style INHERITS children — not partitions: no bounds, no routing. */
    inheritedBy: Record<string, unknown>[];
    /** Start, increment, bounds and owner — set for a sequence only. */
    sequence: Record<string, unknown> | null;
    /** Other relations the same spelling could name (`"Users"` beside `users`), schema-qualified as SQL writes them. */
    alsoMatches: string[];
}

async function readStatements(
    driver: PostgresDriver,
    sql: string,
    params: unknown[],
    signal: AbortSignal | undefined
): Promise<CatalogRows[]> {
    const result = await driver.execute(sql, {
        params: params,
        transaction: "rollback",
        readOnly: true,
        maxRows: CATALOG_MAX_ROWS,
        resetSession: false,
        internalSql: true,
        signal: signal,
    });
    const rowsPerStatement = result.statements.map((statement) => ({ rows: statement.rows, truncated: statement.truncated }));
    return rowsPerStatement;
}

async function readRows(
    driver: PostgresDriver,
    sql: string,
    params: unknown[],
    signal: AbortSignal | undefined
): Promise<CatalogRows> {
    const [rows] = await readStatements(driver, sql, params, signal);
    return rows;
}

export async function listSchemas(driver: PostgresDriver, signal?: AbortSignal): Promise<CatalogRows> {
    const schemas = await readRows(driver, SCHEMAS_SQL, [], signal);
    return schemas;
}

/** The session's search_path as SQL writes it (`app, public`), the implicit pg_catalog and temp schema left out. */
export async function readSearchPath(driver: PostgresDriver, signal?: AbortSignal): Promise<string> {
    const found = await readRows(
        driver,
        "SELECT string_agg(quote_ident(u.schema), ', ' ORDER BY u.position) AS path FROM unnest(current_schemas(false)) WITH ORDINALITY AS u(schema, position)",
        [],
        signal
    );
    return String(found.rows[0]?.path ?? "");
}

/** The schemas among `candidates` (spellings in preference order) that exist, first match first. */
export async function findSchemas(
    driver: PostgresDriver,
    candidates: string[],
    signal?: AbortSignal
): Promise<{ name: string; shown: string }[]> {
    const found = await readRows(driver, SCHEMA_SQL, [candidates], signal);
    return found.rows.map((row) => ({ name: String(row.name), shown: String(row.shown) }));
}

/** `schema` is the stored name, unquoted. */
export async function listRelations(
    driver: PostgresDriver,
    schema: string,
    signal?: AbortSignal
): Promise<{ relations: CatalogRows; types: CatalogRows }> {
    const relations = await readRows(driver, RELATIONS_SQL, [schema], signal);
    const types = await readRows(driver, TYPES_SQL, [schema], signal);
    return { relations: relations, types: types };
}

/**
 * Null when no table, view or sequence matches. Each argument lists spellings to try in order —
 * see resolveRelationName in the tools; `schemaCandidates` null searches the search_path. The first
 * match is described; the others are named.
 */
export async function describeRelation(
    driver: PostgresDriver,
    schemaCandidates: string[] | null,
    nameCandidates: string[],
    signal?: AbortSignal
): Promise<RelationDescription | null> {
    const found = await readRows(driver, RELATION_SQL, [schemaCandidates, nameCandidates], signal);
    if(found.rows.length === 0) {
        return null;
    }
    const relation = found.rows[0];
    const oid = Number(relation.oid);
    if(Number.isInteger(oid) == false || oid <= 0) {
        throw new Error(`catalog returned an unexpected oid for ${String(relation.schema)}.${String(relation.name)}`);
    }

    const detailSql = [COLUMNS_SQL, CONSTRAINTS_SQL, REFERENCED_BY_SQL, INDEXES_SQL, TRIGGERS_SQL, PARTITIONS_SQL, SEQUENCE_SQL]
        .map((sql) => sql.replaceAll("{oid}", String(oid)))
        .join("\n");
    const [columns, constraints, referencedBy, indexes, triggers, partitions, sequence] = await readStatements(driver, detailSql, [], signal);

    const description: RelationDescription = {
        schema: String(relation.schema),
        name: String(relation.name),
        relkind: String(relation.relkind),
        kind: String(relation.kind),
        approxRows: (relation.approx_rows ?? null) as string | null,
        size: (relation.size ?? null) as string | null,
        comment: (relation.comment ?? null) as string | null,
        viewDefinition: (relation.view_definition ?? null) as string | null,
        partitionKey: (relation.partition_key ?? null) as string | null,
        partitionBound: (relation.partition_bound ?? null) as string | null,
        inheritsFrom: (relation.inherits_from ?? null) as string | null,
        columns: columns.rows,
        constraints: constraints.rows,
        referencedBy: referencedBy.rows,
        indexes: indexes.rows,
        triggers: triggers.rows,
        partitions: partitions.rows.filter((row) => row.is_partition == true),
        partitionsTruncated: partitions.truncated,
        inheritedBy: partitions.rows.filter((row) => row.is_partition != true),
        sequence: sequence.rows[0] ?? null,
        alsoMatches: found.rows.slice(1).map((row) => `${String(row.schema)}.${String(row.name)}`),
    };
    return description;
}
