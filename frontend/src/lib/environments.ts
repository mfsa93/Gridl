import type { Environment } from "./api";
import { t } from "./i18n";

export const environments: { id: Environment; label: string }[] = [
  { id: "local", label: t("environment.local") },
  { id: "development", label: t("environment.development") },
  { id: "staging", label: t("environment.staging") },
  { id: "production", label: t("environment.production") },
];

export function environmentLabel(environment: Environment): string {
  return environments.find((item) => item.id === environment)?.label ?? environment;
}
