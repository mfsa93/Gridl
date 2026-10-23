// Tests read the Spanish catalog whatever the machine's language is, so their
// assertions hold on any runner. English is tested through `translate("en", …)`.
Object.defineProperty(globalThis.navigator, "languages", { value: ["es-ES"], configurable: true });
Object.defineProperty(globalThis.navigator, "language", { value: "es-ES", configurable: true });
