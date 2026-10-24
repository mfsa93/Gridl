import type { DatabaseEngine } from "../lib/api";
import { t } from "../lib/i18n";

export type EngineOption = {
  id: DatabaseEngine;
  short: string;
  name: string;
  color: string;
  description: string;
};

export const ENGINES: EngineOption[] = [
  { id: "postgres", short: "Pg", name: "PostgreSQL", color: "#3b82f6", description: t("home.engine.postgres") },
  { id: "mysql", short: "My", name: "MySQL / MariaDB", color: "#f59e0b", description: t("home.engine.mysql") },
  { id: "sqlite", short: "Sl", name: "SQLite", color: "#8b5cf6", description: t("home.engine.sqlite") },
];
