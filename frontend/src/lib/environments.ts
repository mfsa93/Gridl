import type { Environment } from "./api";

export const environments: { id: Environment; label: string }[] = [
  { id: "local", label: "Local" },
  { id: "development", label: "Desarrollo" },
  { id: "staging", label: "Staging" },
  { id: "production", label: "Producción" },
];

export function environmentLabel(environment: Environment): string {
  return environments.find((item) => item.id === environment)?.label ?? environment;
}
