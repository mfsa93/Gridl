import { describe, expect, it } from "vitest";
import { GuardError } from "../lib/api";
import { CodedError, describeError, errorCode } from "../lib/errors";
import { detectLocale, locale, plural, pluralIn, t, translate } from "../lib/i18n";
import { en } from "../locales/en";
import { es } from "../locales/es";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("i18n", () => {
  it("follows the first preferred language", () => {
    expect(detectLocale(["es-MX", "en-US"])).toBe("es");
    expect(detectLocale(["ES"])).toBe("es");
    expect(detectLocale(["en-GB", "es-ES"])).toBe("en");
    expect(detectLocale(["pt-BR"])).toBe("en");
    expect(detectLocale(["", "es-ES"])).toBe("es");
    expect(detectLocale([])).toBe("en");
    // The test setup pretends the system is in Spanish.
    expect(locale).toBe("es");
  });

  it("fills placeholders and leaves unknown ones alone", () => {
    expect(translate("en", "error.blocked", { reason: "modifies data" })).toBe("Blocked by the safety policy: modifies data");
    expect(translate("es", "error.blocked", { reason: "modifica datos" })).toBe("Bloqueado por la política de seguridad: modifica datos");
    expect(t("app.status.range", { from: 1, to: 50 })).toBe("1–50 de {total}");
    expect(translate("en", "error.unexpected", { unused: "x" })).toBe("Unexpected error");
  });

  it("picks the plural form and formats the count", () => {
    expect(pluralIn("en", "common.rows", 1)).toBe("1 row");
    expect(pluralIn("en", "common.rows", 0)).toBe("0 rows");
    expect(pluralIn("en", "common.rows", 12345)).toBe("12,345 rows");
    expect(pluralIn("es", "common.rows", 1)).toBe("1 fila");
    expect(pluralIn("es", "common.rows", 3)).toBe("3 filas");
    expect(plural("common.rows", 2)).toBe("2 filas");
  });

  it("has every English key in Spanish, with the same placeholders", () => {
    const english = Object.keys(en).sort();
    expect(Object.keys(es).sort()).toEqual(english);
    for (const key of english as (keyof typeof en)[]) {
      expect(es[key].trim(), key).not.toBe("");
      expect(placeholders(es[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it("decides on error codes, not on wording", () => {
    const refused = new CodedError("not-authorized", t("error.notAuthorized"));
    expect(errorCode(new Error("wrapped", { cause: refused }))).toBe("not-authorized");
    expect(describeError(refused, null, "postgres").hint).toBe(t("hint.notAuthorized"));
    const blocked = new GuardError({ mode: "block", reason: "x", dangerous: false, environment: "production", sql: "delete from t" });
    expect(errorCode(blocked)).toBe("blocked");
    expect(describeError(blocked, null, "postgres").hint).toBe(t("hint.blocked"));
    expect(describeError("Bloqueado por la política de seguridad: x", null, "postgres").hint).toBeNull();
  });
});
