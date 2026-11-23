export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const digits = Math.abs(value) >= 1 ? 4 : 6;
  const trimmed = value.toFixed(digits).replace(/\.?0+$/, "");
  const [whole, frac = ""] = trimmed.split(".");
  const padded = frac.padEnd(2, "0");
  return `${whole}.${padded} USD`;
}
