/**
 * Lee la lista de SKU y precios propios desde una hoja de Google publicada
 * como CSV.
 *
 * El Sheet NO decide qué se monitorea: eso se sigue haciendo pegando el
 * link de la publicación. Esto es solo la lista para elegir el SKU y traer
 * el precio propio, para poder comparar contra el de la competencia.
 *
 * Se lee por URL publicada (Archivo → Compartir → Publicar en la web → CSV),
 * así no hace falta OAuth de Google ni dar acceso al Drive.
 */

export type SkuRow = {
  sku: string;
  price: number | null;
  /** Lo que haya en la fila además del SKU y el precio, para reconocerlo. */
  label?: string | null;
};

type Cache = { at: number; rows: SkuRow[] } | null;
let cache: Cache = null;
const TTL_MS = 5 * 60 * 1000;

/** Letra de columna ("A", "E") a índice 0-based. */
export function colIndex(letter: string): number {
  const s = (letter ?? "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(s)) return -1;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Parser de CSV que respeta comillas y saltos de línea dentro de campos.
 * Los exports de Google traen nombres con comas, así que partir por "," a
 * secas rompe las filas.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  // Sacar BOM si viene.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Convierte un precio escrito como en Argentina a número.
 *
 * Tiene que aguantar lo que sale de un Sheet real:
 *   "$ 68.000,00"  "68.000"  "68000"  "68,5"  "$68.000,50"  ""  "-"
 *
 * La regla: el ÚLTIMO separador manda. Si es coma, es decimal; si es punto
 * y quedan 1-2 dígitos después, es decimal; si no, es separador de miles.
 */
export function parsePrice(raw: string): number | null {
  let s = (raw ?? "").trim();
  if (!s) return null;
  s = s.replace(/[^\d.,-]/g, ""); // saca $, espacios, letras
  if (!s || s === "-") return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma > lastDot) {
    // coma decimal: 68.000,50
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    const decimals = s.length - lastDot - 1;
    if (decimals <= 2 && s.indexOf(".") === lastDot) {
      // punto decimal: 68000.50
      s = s.replace(/,/g, "");
    } else {
      // punto de miles: 68.000
      s = s.replace(/\./g, "").replace(/,/g, "");
    }
  } else {
    s = s.replace(/,/g, "");
  }

  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** ¿Esta fila es el encabezado? */
function looksLikeHeader(cells: string[], skuIdx: number, priceIdx: number): boolean {
  const sku = (cells[skuIdx] ?? "").trim().toLowerCase();
  const price = (cells[priceIdx] ?? "").trim().toLowerCase();
  if (/^(sku|codigo|código)$/.test(sku)) return true;
  // Si el precio no es un número, probablemente sea un título.
  return parsePrice(cells[priceIdx] ?? "") === null && /[a-z]/.test(price);
}

export type SkuListResult = {
  rows: SkuRow[];
  source: "sheet" | "none";
  error?: string;
  fetchedAt?: number;
};

/**
 * Trae la lista de SKU. Cachea 5 minutos para no pedirle el CSV a Google
 * en cada click del dashboard.
 */
export async function getSkuList(
  opts: { force?: boolean } = {}
): Promise<SkuListResult> {
  const url = process.env.SHEET_CSV_URL;
  if (!url) {
    return {
      rows: [],
      source: "none",
      error:
        "Falta configurar SHEET_CSV_URL con la URL del Sheet publicado como CSV.",
    };
  }

  if (!opts.force && cache && Date.now() - cache.at < TTL_MS) {
    return { rows: cache.rows, source: "sheet", fetchedAt: cache.at };
  }

  let text: string;
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) {
      return {
        rows: cache?.rows ?? [],
        source: cache ? "sheet" : "none",
        error: `El Sheet respondió ${r.status}. Revisá que siga publicado en la web.`,
      };
    }
    text = await r.text();
  } catch (err) {
    return {
      rows: cache?.rows ?? [],
      source: cache ? "sheet" : "none",
      error: `No se pudo leer el Sheet: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Si Google devuelve HTML es que la hoja no está publicada.
  if (/^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text)) {
    return {
      rows: cache?.rows ?? [],
      source: cache ? "sheet" : "none",
      error:
        "El Sheet devolvió una página web en vez del CSV: probablemente no está publicado. " +
        "Archivo → Compartir → Publicar en la web → hoja 'Activos' → CSV.",
    };
  }

  const skuIdx = colIndex(process.env.SHEET_SKU_COL || "A");
  const priceIdx = colIndex(process.env.SHEET_PRICE_COL || "E");
  const nameIdx = colIndex(process.env.SHEET_NAME_COL || "B");

  const table = parseCsv(text);
  const rows: SkuRow[] = [];
  const seen = new Set<string>();

  for (const [i, cells] of table.entries()) {
    const sku = (cells[skuIdx] ?? "").trim();
    if (!sku) continue;
    if (i === 0 && looksLikeHeader(cells, skuIdx, priceIdx)) continue;
    if (seen.has(sku.toUpperCase())) continue;
    seen.add(sku.toUpperCase());

    rows.push({
      sku,
      price: parsePrice(cells[priceIdx] ?? ""),
      label: (cells[nameIdx] ?? "").trim() || null,
    });
  }

  cache = { at: Date.now(), rows };
  return { rows, source: "sheet", fetchedAt: cache.at };
}

/** Precio propio de un SKU puntual. */
export async function priceForSku(sku: string): Promise<number | null> {
  if (!sku) return null;
  const { rows } = await getSkuList();
  const found = rows.find((r) => r.sku.toUpperCase() === sku.trim().toUpperCase());
  return found?.price ?? null;
}

/** Para los tests. */
export function resetSkuCache(): void {
  cache = null;
}
