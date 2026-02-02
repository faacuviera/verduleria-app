import { money } from "./utils.js";

export function validateRequiredText(value, label = "este campo") {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return { value: "", error: `Ingresá ${label}; no puede quedar vacío.` };
  }
  return { value: normalized, error: "" };
}

export function validateDateInput(value, label = "este dato") {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return { value: "", error: `Ingresá la fecha de ${label}.` };
  }
  return { value: normalized, error: "" };
}

export function validatePositiveAmount(value, label = "este monto") {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return { amount: null, normalized: "", error: `Ingresá el monto de ${label}.` };
  }

  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { amount: null, normalized: "", error: `Ingresá un monto mayor a 0 para ${label}.` };
  }

  return { amount, normalized: money(amount), error: "" };
}
