import type { DatabaseEngine } from "./api";

export type ShownError = {
  message: string;
  hint: string | null;
};

const prefixes = [/^database:\s*/i, /^error returned from database:\s*/i, /^invalid connection config:\s*/i];

/** Strips transport prefixes so the database's own words come first. */
function cleanMessage(raw: string): string {
  let message = raw.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      const next = message.replace(prefix, "");
      if (next !== message) {
        message = next;
        changed = true;
      }
    }
  }
  return message || raw;
}

function hintFor(message: string, sql: string | null, engine: DatabaseEngine): string | null {
  const missingColumn = /column "([^"]+)" does not exist/i.exec(message);
  if (missingColumn && sql && sql.includes(`"${missingColumn[1]}"`) && engine !== "mysql") {
    return `Las comillas dobles nombran columnas o tablas. Para texto usa comillas simples: '${missingColumn[1]}'.`;
  }
  if (/^Bloqueado por la política de seguridad/i.test(message)) {
    return "Cambia la política en Editar conexión → Seguridad si de verdad necesitas hacerlo.";
  }
  if (/^No se ejecutó: falta tu autorización/i.test(message)) {
    return "No se cambió nada en la base.";
  }
  if (/current transaction is aborted/i.test(message)) {
    return "La transacción abierta falló. Ejecuta ROLLBACK para seguir trabajando.";
  }
  if (/relation "[^"]+" does not exist|no such table|doesn't exist/i.test(message)) {
    return "Revisa el nombre y el esquema, o actualiza el explorador si la tabla es nueva.";
  }
  if (/read-only transaction|read only|READ ONLY|1792/i.test(message)) {
    return "La conexión está en modo solo lectura.";
  }
  if (isConnectionLost(message)) {
    return "Se perdió la conexión con el servidor (suspensión, VPN o túnel). Pulsa Reconectar.";
  }
  if (/cannot insert multiple commands into a prepared statement/i.test(message)) {
    return "Hay varias sentencias. Usa «Todo» (⇧⌘↵) para ejecutarlas una tras otra.";
  }
  return null;
}

/** Errors that mean the session to the server is gone, so reconnecting can help. */
export function isConnectionLost(message: string): boolean {
  return /is not open|not connected|connection (closed|reset|refused)|broken pipe|reset by peer|unexpected eof|end of file|pool timed out|timed out while waiting|io error|server closed|terminating connection|lost connection|gone away|tunnel|channel closed/i.test(message);
}

export function describeError(raw: string, sql: string | null, engine: DatabaseEngine): ShownError {
  const message = cleanMessage(raw);
  return { message, hint: hintFor(message, sql, engine) };
}
