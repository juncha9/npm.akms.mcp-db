import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDbMcpServer, type DbMcpServerInstance } from "@/server";
import { startPgliteServer, type PgliteServer } from "./support/pglite-server";

// db_schemas / db_tables / db_describe against a schema built to hit each catalog corner:
// partitions (one living in another schema), an FK to a partitioned table, quoted names, an
// INVALID index, a replica-only trigger, enum arrays and domains, generated columns, a sequence.

const SETUP_SQL = [
    "CREATE SCHEMA cat_app",
    "CREATE SCHEMA cat_archive",
    "CREATE SCHEMA \"Cat_Mixed\"",
    "CREATE TYPE cat_app.status AS ENUM ('active', 'blocked')",
    "CREATE DOMAIN cat_app.status_dom AS cat_app.status",
    "CREATE TYPE cat_app.address AS (street text, zip int)",
    "CREATE TABLE cat_app.customers (id int PRIMARY KEY, status cat_app.status DEFAULT 'active', statuses cat_app.status[], sdom cat_app.status_dom,"
        + " total numeric, doubled numeric GENERATED ALWAYS AS (total * 2) STORED)",
    "CREATE TABLE cat_app.regions (id int, region text, PRIMARY KEY (id, region)) PARTITION BY LIST (region)",
    "CREATE TABLE cat_app.regions_kr PARTITION OF cat_app.regions FOR VALUES IN ('kr')",
    "CREATE TABLE cat_archive.regions_us PARTITION OF cat_app.regions FOR VALUES IN ('us')",
    "CREATE TABLE cat_app.orders (id int, region_id int, region text, customer_id int REFERENCES cat_app.customers,"
        + " FOREIGN KEY (region_id, region) REFERENCES cat_app.regions)",
    "INSERT INTO cat_app.customers (id, total) SELECT g, g FROM generate_series(1, 50) g",
    "INSERT INTO cat_app.regions SELECT g, CASE WHEN g % 2 = 0 THEN 'kr' ELSE 'us' END FROM generate_series(1, 40) g",
    "ANALYZE cat_app.regions_kr",
    "ANALYZE cat_archive.regions_us",
    "CREATE SEQUENCE cat_app.ticket_seq START 100 INCREMENT 5",
    "ALTER TABLE cat_app.orders ADD COLUMN ticket int DEFAULT nextval('cat_app.ticket_seq')",
    "ALTER SEQUENCE cat_app.ticket_seq OWNED BY cat_app.orders.ticket",
    "CREATE TABLE \"Cat_Mixed\".\"OrderLine\" (id int, dup int)",
    "CREATE TABLE \"Cat_Mixed\".\"a.b\" (id int)",
    "INSERT INTO \"Cat_Mixed\".\"OrderLine\" VALUES (1, 7), (2, 7)",
    "CREATE FUNCTION cat_app.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
    "CREATE TRIGGER customers_touch BEFORE UPDATE ON cat_app.customers FOR EACH ROW EXECUTE FUNCTION cat_app.touch()",
    "ALTER TABLE cat_app.customers ENABLE REPLICA TRIGGER customers_touch",
    "CREATE TABLE cat_app.nn (a int, b int)",
    "INSERT INTO cat_app.nn VALUES (NULL, 1)",
    "ALTER TABLE cat_app.nn ADD CONSTRAINT nn_a_not_null NOT NULL a NOT VALID",
    // Two objects one unquoted spelling could mean; SQL reads CatUsers as catusers
    "CREATE TABLE public.\"CatUsers\" (upper_col int)",
    "CREATE TABLE public.catusers (lower_col int)",
    // PostgreSQL folds only A–Z: ÄRGER is stored as Ärger
    "CREATE TABLE cat_app.ÄRGER (a int)",
    "CREATE SCHEMA \"cat.dotted\"",
    "CREATE TABLE \"cat.dotted\".inside (a int)",
    // One partition analyzed, the bigger one not
    "CREATE TABLE cat_app.logs (id int, at date) PARTITION BY RANGE (at)",
    "CREATE TABLE cat_app.logs_old PARTITION OF cat_app.logs FOR VALUES FROM ('2020-01-01') TO ('2025-01-01')",
    "CREATE TABLE cat_app.logs_cur PARTITION OF cat_app.logs FOR VALUES FROM ('2025-01-01') TO ('2030-01-01')",
    "INSERT INTO cat_app.logs SELECT g, '2021-01-01' FROM generate_series(1, 10) g",
    "INSERT INTO cat_app.logs SELECT g, '2026-01-01' FROM generate_series(1, 50) g",
    "ANALYZE cat_app.logs_old",
    // A partitioned index made ON ONLY the parent — invalid until each partition's index is attached
    "CREATE INDEX logs_id_idx ON ONLY cat_app.logs (id)",
    "CREATE TABLE cat_app.single (id int) PARTITION BY LIST (id)",
    "CREATE TABLE cat_app.single_1 PARTITION OF cat_app.single FOR VALUES IN (1)",
    "CREATE TABLE cat_app.inh_parent (a int)",
    "CREATE TABLE cat_app.inh_child (b int) INHERITS (cat_app.inh_parent)",
    // Prisma / EF style: every name mixed case, so each one needs its quotes in SQL
    "CREATE TYPE \"Cat_Mixed\".\"Mood\" AS ENUM ('calm', 'loud')",
    "CREATE TABLE \"Cat_Mixed\".\"Account\" (\"userId\" int PRIMARY KEY, \"mood\" \"Cat_Mixed\".\"Mood\")",
    "CREATE SEQUENCE \"Cat_Mixed\".\"Account_seq\" OWNED BY \"Cat_Mixed\".\"Account\".\"userId\"",
    // A second schema the unquoted spelling CAT_APP could mean
    "CREATE SCHEMA \"CAT_APP\"",
    // Two schemas and two tables one unquoted spelling could mean
    "CREATE SCHEMA cat_pair",
    "CREATE SCHEMA \"CAT_PAIR\"",
    "CREATE TABLE cat_pair.t (lower_col int)",
    "CREATE TABLE \"CAT_PAIR\".t (upper_col int)",
    // Unquoted SpOrder: SQL reads sporder, so public.sporder wins over cat_app."SpOrder" even with cat_app first on the path
    "CREATE TABLE cat_app.\"SpOrder\" (mixed_col int)",
    "CREATE TABLE public.sporder (lower_col int)",
    // On the search_path (public): ::regclass::text would print these without their schema
    "CREATE TABLE public.cat_plog (id int) PARTITION BY LIST (id)",
    "CREATE TABLE public.cat_plog_1 PARTITION OF public.cat_plog FOR VALUES IN (1)",
];

describe("catalog tools against PGlite", () => {
    let database: PgliteServer;
    let instance: DbMcpServerInstance;
    let client: Client;

    async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
        const result = await client.callTool({ name: name, arguments: args });
        return (result.content as { text: string }[]).map((part) => part.text).join("\n");
    }

    beforeAll(async () => {
        database = await startPgliteServer();
        // A deny pattern that the catalog SQL itself would match (attisdropped, pg_catalog) — it must not refuse the tools
        instance = createDbMcpServer({ DB_DRIVER: "postgres", DB_URL: database.url, DB_SSL: "off", DB_DENY_PATTERNS: "drop, pg_catalog" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await instance.server.connect(serverTransport);
        client = new Client({ name: "catalog-test", version: "0" });
        await client.connect(clientTransport);
        for(const sql of SETUP_SQL) {
            await instance.driver!.execute(sql, { transaction: "autocommit", internalSql: true });
        }
        // A unique index built CONCURRENTLY over duplicates fails and leaves an INVALID index behind
        await instance.driver!.execute("CREATE UNIQUE INDEX CONCURRENTLY orderline_dup_uq ON \"Cat_Mixed\".\"OrderLine\" (dup)", { transaction: "autocommit" })
            .catch(() => undefined);
    }, 60000);

    afterAll(async () => {
        await client?.close();
        await instance?.shutdown();
        await database?.stop();
    });

    it("lists schemas despite deny patterns that match the catalog SQL, counting a schema that holds only a foreign-parented partition", async () => {
        const text = await callTool("db_schemas", {});
        expect(text).not.toMatch(/Refused/);
        expect(text).toMatch(/cat_archive\s+\S+\s+1\s+0\s+0/);
    });

    it("shows a partitioned table with its partitions' size and rows, and lists a partition whose parent is in another schema", async () => {
        const app = await callTool("db_tables", { schema: "cat_app" });
        expect(app).toMatch(/regions\s+partitioned table, 2 partitions\s+40\s+\d+ kB/);
        expect(app).not.toMatch(/regions_kr/);

        const archive = await callTool("db_tables", { schema: "cat_archive" });
        expect(archive).toMatch(/regions_us\s+partition of cat_app\.regions/);
    });

    it("describes a partitioned table: key and partitions, without the FK copies PostgreSQL makes per partition", async () => {
        const regions = await callTool("db_describe", { table: "cat_app.regions" });
        expect(regions).toMatch(/partitioned by: LIST \(region\)/);
        expect(regions).toMatch(/partitions:\n\s+cat_app\.regions_kr\s+FOR VALUES IN \('kr'\)\n\s+cat_archive\.regions_us\s+FOR VALUES IN \('us'\)/);
        expect(regions).toMatch(/referenced by:\n\s+cat_app\.orders \(orders_region_id_region_fkey\)/);
        expect(regions.match(/orders_region_id_region_fkey/g)?.length).toBe(1);

        const orders = await callTool("db_describe", { table: "cat_app.orders" });
        expect(orders.match(/foreign key/g)?.length).toBe(2);
        expect(orders).not.toMatch(/regions_kr|regions_us/);

        const partition = await callTool("db_describe", { table: "cat_archive.regions_us" });
        expect(partition).toMatch(/\(partition of cat_app\.regions\)/);
        expect(partition).toMatch(/partition bound: FOR VALUES IN \('us'\)/);
    });

    it("columns: enum values for an enum array and a domain, a generated expression that is not a default", async () => {
        const text = await callTool("db_describe", { table: "cat_app.customers" });
        expect(text).toMatch(/statuses\s+cat_app\.status\[\]\s+enum \(active, blocked\)/);
        expect(text).toMatch(/sdom\s+cat_app\.status_dom\s+enum \(active, blocked\)/);
        expect(text).toMatch(/doubled\s+numeric\s+generated stored as \(total \* \(2\)::numeric\)/);
        expect(text).not.toMatch(/doubled.*default/);
        expect(text).toMatch(/customers_touch\s+\(replica only — does not fire in ordinary sessions\)/);
    });

    it("marks an INVALID index, and finds quoted names the way SQL writes them", async () => {
        const quoted = await callTool("db_describe", { table: "\"Cat_Mixed\".\"OrderLine\"" });
        expect(quoted).toMatch(/orderline_dup_uq\s+.*INVALID — unusable; drop and recreate/);
        // The planner never uses an invalid index, so its count is 0 whatever else ran; the heading says since when
        expect(quoted).toMatch(/indexes \(scans counted since (the server's statistics began|\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/);
        expect(quoted).toMatch(/orderline_dup_uq\s+\S+ (bytes|kB|MB) · 0 scans · INVALID/);

        const separate = await callTool("db_describe", { table: "\"OrderLine\"", schema: "\"Cat_Mixed\"" });
        // Names come back as SQL writes them, so a copied name means the same object in a query
        expect(separate).toMatch(/^"Cat_Mixed"\."OrderLine"/);

        const dotted = await callTool("db_describe", { table: "\"Cat_Mixed\".\"a.b\"" });
        expect(dotted).toMatch(/^"Cat_Mixed"\."a\.b"/);

        const repeated = await callTool("db_describe", { table: "cat_app.customers", schema: "cat_app" });
        expect(repeated).toMatch(/^cat_app\.customers/);

        const folded = await callTool("db_describe", { table: "CAT_APP.Customers" });
        expect(folded).toMatch(/^cat_app\.customers/);
    });

    it("describes a sequence by its settings and owner, and refuses an index name", async () => {
        const sequence = await callTool("db_describe", { table: "cat_app.ticket_seq" });
        expect(sequence).toMatch(/sequence:\n\s+bigint · start 100 · increment 5/);
        expect(sequence).toMatch(/owned by cat_app\.orders\.ticket/);
        expect(sequence).not.toMatch(/last_value/);

        const index = await callTool("db_describe", { table: "cat_app.customers_pkey" });
        expect(index).toMatch(/^No table, view or sequence named customers_pkey in schema cat_app\. db_tables lists what the schema has\./);
    });

    it("shows a NOT VALID not-null constraint, since the column says not null while NULL rows remain", async () => {
        const text = await callTool("db_describe", { table: "cat_app.nn" });
        expect(text).toMatch(/nn_a_not_null\s+not null\s+NOT NULL a NOT VALID/);
    });

    it("reads a name as SQL does, and says when the same spelling also names another object", async () => {
        const unquoted = await callTool("db_describe", { table: "CatUsers" });
        expect(unquoted).toMatch(/^public\.catusers/);
        expect(unquoted).toMatch(/lower_col/);
        expect(unquoted).toMatch(/note: public\."CatUsers" matches this spelling too/);

        const quoted = await callTool("db_describe", { table: "\"CatUsers\"" });
        expect(quoted).toMatch(/^public\."CatUsers"/);
        expect(quoted).toMatch(/upper_col/);

        const umlaut = await callTool("db_describe", { table: "cat_app.ÄRGER" });
        expect(umlaut).toMatch(/^cat_app\."Ärger"/);
    });

    it("takes a separate schema argument as one name, dots included", async () => {
        const listing = await callTool("db_tables", { schema: "cat.dotted" });
        expect(listing).toMatch(/Relations in "cat\.dotted": 1/);
        expect(listing).toMatch(/inside\s+table/);

        const described = await callTool("db_describe", { table: "inside", schema: "cat.dotted" });
        expect(described).toMatch(/^"cat\.dotted"\.inside/);

        const missing = await callTool("db_tables", { schema: "cat_app.extra" });
        expect(missing).toMatch(/^No schema named "cat_app\.extra"/);
    });

    it("marks a partial row estimate as one, counts direct partitions with the singular, and explains an ON ONLY index", async () => {
        const listing = await callTool("db_tables", { schema: "cat_app" });
        expect(listing).toMatch(/logs\s+partitioned table, 2 partitions\s+≥10 \(1 of 2 leaf partitions never analyzed\)/);
        expect(listing).toMatch(/single\s+partitioned table, 1 partition\b/);

        const logs = await callTool("db_describe", { table: "cat_app.logs" });
        // Already a lower bound: no "~" in front of it
        expect(logs).toMatch(/^cat_app\.logs {2}\(partitioned table, 2 partitions\) · ≥10 rows \(1 of 2 leaf partitions never analyzed\)/);
        expect(logs).toMatch(/logs_id_idx\s+.*INVALID until every partition has its index attached — create the missing ones and ALTER INDEX … ATTACH PARTITION/);
        expect(logs).not.toMatch(/drop and recreate/);
    });

    it("lists INHERITS children apart from partitions, and names a child's parent", async () => {
        const parent = await callTool("db_describe", { table: "cat_app.inh_parent" });
        expect(parent).toMatch(/inherited by \(INHERITS — not partitions\):\n\s+cat_app\.inh_child/);
        expect(parent).not.toMatch(/^partitions:/m);

        const child = await callTool("db_describe", { table: "cat_app.inh_child" });
        expect(child).toMatch(/inherits from: cat_app\.inh_parent/);
    });

    it("writes every name as SQL needs it — schemas, columns, types, constraints, a sequence's owner", async () => {
        const schemas = await callTool("db_schemas", {});
        expect(schemas).toMatch(/^"Cat_Mixed"\s/m);

        const listing = await callTool("db_tables", { schema: "\"Cat_Mixed\"" });
        expect(listing).toMatch(/^Relations in "Cat_Mixed": /m);
        expect(listing).toMatch(/^"Mood"\s+enum\s+calm, loud/m);

        const account = await callTool("db_describe", { table: "\"Cat_Mixed\".\"Account\"" });
        expect(account).toMatch(/^\s+"userId"\s+integer\s+not null/m);
        expect(account).toMatch(/^\s+mood\s+"Cat_Mixed"\."Mood"/m);
        expect(account).toMatch(/^\s+"Account_pkey"\s+primary key/m);

        const sequence = await callTool("db_describe", { table: "\"Cat_Mixed\".\"Account_seq\"" });
        expect(sequence).toMatch(/owned by "Cat_Mixed"\."Account"\."userId"/);
    });

    it("lists the schema SQL would read, and names the other spelling", async () => {
        const listing = await callTool("db_tables", { schema: "CAT_APP" });
        expect(listing).toMatch(/^note: schema "CAT_APP" matches this spelling too/);
        expect(listing).toMatch(/^Relations in cat_app: /m);

        const quoted = await callTool("db_tables", { schema: "\"CAT_APP\"" });
        expect(quoted).toMatch(/^Schema "CAT_APP" has no tables, views, sequences or types\.$/);

        // Both spellings were tried, so quoting it would only repeat one of them
        const missing = await callTool("db_tables", { schema: "NoSuch" });
        expect(missing).toBe("No schema named nosuch or \"NoSuch\". db_schemas lists them.");
    });

    it("keeps the schema a quoted table part names, even when the schema argument is unquoted", async () => {
        const described = await callTool("db_describe", { table: "\"CAT_PAIR\".t", schema: "CAT_PAIR" });
        expect(described).toMatch(/^"CAT_PAIR"\.t {2}\(table\)/);
        expect(described).toMatch(/upper_col/);
        expect(described).not.toMatch(/note:/);
    });

    it("looks an unqualified name up on the search_path, as SQL does — pg_catalog included", async () => {
        const catalogTable = await callTool("db_describe", { table: "pg_class" });
        expect(catalogTable).toMatch(/^pg_catalog\.pg_class {2}\(table\)/);

        const missing = await callTool("db_describe", { table: "cat_no_such_table" });
        // Says which schemas it looked in, and every spelling it tried — quoting would only repeat one of them
        expect(missing).toMatch(/^No table, view or sequence named cat_no_such_table on the search_path \(public\)\. For one in another schema, give the schema: schema\.name/);
        // PGlite runs every connection in one session, so a session SET reaches the catalog call; DISCARD ALL undoes it
        await instance.driver!.execute("SET search_path = cat_app, public", { transaction: "autocommit", resetSession: false });
        try {
            const folded = await callTool("db_describe", { table: "SpOrder" });
            expect(folded).toMatch(/^public\.sporder {2}\(table\)/);
            expect(folded).toMatch(/note: cat_app\."SpOrder" matches this spelling too/);
        }
        finally {
            await instance.driver!.execute("DISCARD ALL", { transaction: "autocommit" });
        }

        const mixed = await callTool("db_describe", { table: "Cat_No_Such" });
        expect(mixed).toMatch(/^No table, view or sequence named cat_no_such or "Cat_No_Such" on the search_path \(public\)\./);
        expect(mixed).not.toMatch(/double quotes/);

        // Advice only where quoting could change the reading
        const dotted = await callTool("db_describe", { table: "Cat_Mixed.a.b" });
        expect(dotted).toMatch(/has 3 dotted parts/);
        const splitAtDot = await callTool("db_describe", { table: "Order.Lines" });
        expect(splitAtDot).toMatch(/in schema order or "Order"\. .* A name that contains a dot goes in double quotes as a whole, as in SQL: "Order\.Lines"\.$/);
        const lowerOnly = await callTool("db_describe", { table: "nope" });
        expect(lowerOnly).toMatch(/A mixed-case name goes in double quotes, as in SQL: "Orders"\.$/);
        const quoted = await callTool("db_describe", { table: "\"Nope\"" });
        expect(quoted).not.toMatch(/double quotes/);
        // With a schema argument the dotted name was already tried whole — no advice to try it again
        const wholeDotted = await callTool("db_describe", { table: "x.y", schema: "public" });
        expect(wholeDotted).toMatch(/^No table, view or sequence named "x\.y" in schema public\./);
        expect(wholeDotted).not.toMatch(/a dot goes in double quotes/);
        // Only the schema part quoted: the name part is still read folded, so the case advice applies
        const schemaQuoted = await callTool("db_describe", { table: "\"Cat_Mixed\".things" });
        expect(schemaQuoted).toMatch(/A mixed-case name goes in double quotes, as in SQL: "Orders"\.$/);
    });

    it("reads each argument by its own quotes — a quoted table does not make the schema argument quoted", async () => {
        const described = await callTool("db_describe", { table: "\"OrderLine\"", schema: "Cat_Mixed" });
        expect(described).toMatch(/^"Cat_Mixed"\."OrderLine"/);

        const same = await callTool("db_describe", { table: "\"Cat_Mixed\".\"OrderLine\"", schema: "Cat_Mixed" });
        expect(same).toMatch(/^"Cat_Mixed"\."OrderLine"/);
    });

    it("schema-qualifies partitions and parents whatever the search_path shows", async () => {
        const parent = await callTool("db_describe", { table: "cat_plog" });
        expect(parent).toMatch(/partitions:\n\s+public\.cat_plog_1\s+FOR VALUES IN \(1\)/);

        const partition = await callTool("db_describe", { table: "cat_plog_1" });
        expect(partition).toMatch(/\(partition of public\.cat_plog\)/);
    });

    it("lists a composite type's fields", async () => {
        const text = await callTool("db_tables", { schema: "cat_app" });
        expect(text).toMatch(/address\s+composite\s+street text, zip integer/);
    });
});
