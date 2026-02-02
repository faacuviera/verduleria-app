export const money = (n) =>
  new Intl.NumberFormat("es-UY", {
    style: "currency",
    currency: "UYU",
    maximumFractionDigits: 0
  }).format(Number(n || 0));

export const todayISO = () => new Date().toISOString().slice(0, 10);

export const monthISO = (d) => (d || new Date()).toISOString().slice(0, 7);

export const uid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now()) + Math.random().toString(16).slice(2);

export function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function download(filename, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
}

export function toCSV(rows, headers) {
  const head = headers.map(csvEscape).join(",") + "\n";
  const body = rows
    .map((r) => headers.map((h) => csvEscape(r[h])).join(","))
    .join("\n");
  return head + body + "\n";
}

export function matchesQuery(value, query) {
  const term = (query || "").trim().toLowerCase();
  if (!term) return true;

  if (Array.isArray(value)) {
    return value.some((item) => matchesQuery(item, term));
  }

  if (value && typeof value === "object") {
    return Object.values(value).some((item) => matchesQuery(item, term));
  }

  return String(value ?? "").toLowerCase().includes(term);
}

export function filterByQuery(list, query) {
  const items = Array.isArray(list) ? list : [];
  if (!query) return items;
  return items.filter((item) => matchesQuery(item, query));
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      default: return c;
    }
  });
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function highlightTerm(text, term) {
  const rawText = escapeHtml(text);
  const normalized = (term || "").trim();
  if (!normalized) return rawText;

  const pattern = new RegExp(`(${escapeRegExp(normalized)})`, "gi");
  return rawText.replace(pattern, "<mark>$1</mark>");
}

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") {
          current += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "\"") {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(current);
      current = "";
      continue;
    }

    if (ch === "\n") {
      row.push(current);
      if (row.some((cell) => String(cell ?? "").trim() !== "")) {
        rows.push(row);
      }
      row = [];
      current = "";
      continue;
    }

    if (ch === "\r") {
      continue;
    }

    current += ch;
  }

  row.push(current);
  if (row.some((cell) => String(cell ?? "").trim() !== "")) {
    rows.push(row);
  }

  return rows;
}
