import builtin from "./builtin.json";
import type { DatabaseEngine } from "../lib/api";

/**
 * What makes an engine different, as the backend's `EngineSpec` describes it
 * (crates/gridl-core/src/engines.rs). The app asks the spec instead of
 * branching on engine names. `builtin.json` is a copy the backend's tests keep
 * in sync, so the first paint and the tests have it without a round trip.
 */
export type EngineSpec = {
  id: string;
  name: string;
  short: string;
  color: string;
  connection: { fileBased: boolean; defaultPort: number | null; defaultUser: string | null; defaultName: string; fileExtensions: string[] };
  sql: {
    identifierQuote: string;
    params: "dollar" | "question";
    paramCasts: boolean;
    dialect: "postgresql" | "mysql" | "sqlite";
    backslashEscapes: boolean;
    hashComments: boolean;
    dollarQuotes: boolean;
    textCast: string;
    nullSafeDiffers: "is-distinct-from" | "not-null-safe-equals" | "is-not";
    contains: "ilike-text" | "like-escape" | "like";
    booleans: "keyword" | "number";
    bytes: "escaped-hex" | "x-hex";
    emptyInsert: string;
    now: [string, string, string];
    outParamVariables: boolean;
  };
  structure: {
    schemas: boolean;
    ddl: "postgres" | "mysql" | "sqlite";
    columnTypes: { name: string; kind: "plain" | "length" | "numeric"; generated?: boolean }[];
    keyType: string;
    lengthHint: string | null;
    referenceRules: [string, string][];
    referenceFallback: string | null;
    alterColumns: boolean;
    uniqueOnAdd: boolean;
    alterForeignKeys: boolean;
    dropForeignKey: string;
  };
  tools: {
    explain: "postgres-json" | "mysql-json" | "sqlite-query-plan" | null;
    rowEstimate: "pg-class" | "information-schema" | null;
    backup: "pg-dump" | "mysqldump" | "vacuum-into" | null;
    restore: boolean;
  };
};

// JSON arrays type as string[]; the backend test guarantees the shape.
let engines: EngineSpec[] = builtin as unknown as EngineSpec[];

/** Every engine this build knows, in the order the app offers them. */
export function allEngines(): EngineSpec[] {
  return engines;
}

/** Replaces the known engines with the backend's list, read once at startup. */
export function setEngines(list: EngineSpec[] | null | undefined) {
  if (Array.isArray(list) && list.length > 0) engines = list;
}

/** The spec of `engine`. Unknown ids get the first engine's spec rather than a crash. */
export function engineSpec(engine: DatabaseEngine | string): EngineSpec {
  return engines.find((spec) => spec.id === engine) ?? (engines[0] as EngineSpec);
}
