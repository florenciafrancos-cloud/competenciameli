/**
 * Parte un archivo .sql en sentencias individuales.
 *
 * Hace falta porque el driver HTTP de Neon ejecuta UNA sentencia por
 * llamada, a diferencia de `psql` o del cliente `pg` clasico.
 *
 * La version anterior de esto tenia un bug que costo un rato de debug:
 * partia por ";" y despues descartaba los pedazos que empezaban con "--".
 * Como cada CREATE TABLE del schema viene precedido por un comentario
 * explicativo, el pedazo entero (comentario + CREATE TABLE) empezaba con
 * "--" y se descartaba en silencio. Resultado: solo se creaban los
 * indices, y despues fallaban porque su tabla no existia.
 *
 * Esta version recorre el texto caracter por caracter respetando los
 * literales entre comillas, asi que un ";" o un "--" dentro de un string
 * no parten nada.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Comentario de linea: -- hasta el fin de linea
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }

    // Comentario de bloque: /* ... */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Literal entre comillas simples. '' es una comilla escapada.
    if (ch === "'") {
      current += ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          current += "'";
          i++;
          break;
        }
        current += sql[i];
        i++;
      }
      continue;
    }

    // Identificador entre comillas dobles
    if (ch === '"') {
      current += ch;
      i++;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Fin de sentencia
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const last = current.trim();
  if (last) statements.push(last);

  return statements;
}
