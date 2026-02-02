import { describe, expect, it } from "vitest";
import { money } from "./utils.js";
import {
  validateDateInput,
  validatePositiveAmount,
  validateRequiredText
} from "./validation.js";

describe("validateRequiredText", () => {
  it("trims and returns value when present", () => {
    const res = validateRequiredText("  hola  ", "el nombre");
    expect(res.error).toBe("");
    expect(res.value).toBe("hola");
  });

  it("flags empty strings", () => {
    const res = validateRequiredText("   ", "el nombre");
    expect(res.error).toContain("el nombre");
    expect(res.value).toBe("");
  });
});

describe("validateDateInput", () => {
  it("accepts ISO dates", () => {
    const res = validateDateInput("2024-12-01", "la fecha");
    expect(res.error).toBe("");
    expect(res.value).toBe("2024-12-01");
  });

  it("complains when missing", () => {
    const res = validateDateInput("", "la fecha");
    expect(res.error).toContain("fecha");
  });
});

describe("validatePositiveAmount", () => {
  it("normalizes valid amounts", () => {
    const res = validatePositiveAmount("1500.5", "este ingreso");
    expect(res.error).toBe("");
    expect(res.amount).toBeCloseTo(1500.5);
    expect(res.normalized.replace(/\s/g, "")).toContain(money(1500.5).replace(/\s/g, ""));
  });

  it("rejects zero or negative numbers", () => {
    expect(validatePositiveAmount("0", "el monto").error).toContain("mayor a 0");
    expect(validatePositiveAmount("-2", "el monto").error).toContain("mayor a 0");
  });

  it("rejects non numeric values", () => {
    const res = validatePositiveAmount("abc", "el monto");
    expect(res.amount).toBeNull();
    expect(res.error).toContain("monto");
  });
});
