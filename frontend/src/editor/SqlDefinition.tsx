import { useMemo } from "react";
import type { DatabaseEngine } from "../lib/api";
import { highlightSql } from "./highlight";

/** Read-only SQL with the editor's token colors, for catalog definitions. */
export function SqlDefinition({ sql, engine }: { sql: string; engine: DatabaseEngine }) {
  const parts = useMemo(() => highlightSql(sql, engine), [sql, engine]);
  return <pre className="definition-view sql-tokens">{parts}</pre>;
}
