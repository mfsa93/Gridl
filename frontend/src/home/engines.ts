import { allEngines } from "../engines";
import type { DatabaseEngine } from "../lib/api";
import { t } from "../lib/i18n";

export type EngineOption = {
  id: DatabaseEngine;
  short: string;
  name: string;
  color: string;
  description: string;
};

/** A line about each built-in engine; an engine without one shows its name. */
const descriptions: Record<string, () => string> = {
  postgres: () => t("home.engine.postgres"),
  mysql: () => t("home.engine.mysql"),
  sqlite: () => t("home.engine.sqlite"),
};

/** The engines a new connection can use, as the engine specs describe them. */
export function engineOptions(): EngineOption[] {
  return allEngines().map((spec) => ({
    id: spec.id as DatabaseEngine,
    short: spec.short,
    name: spec.name,
    color: spec.color,
    description: descriptions[spec.id]?.() ?? spec.name,
  }));
}
