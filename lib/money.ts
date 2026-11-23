export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const digits = Math.abs(value) >= 1 ? 4 : 6;
  const trimmed = value.toFixed(digits).replace(/\.?0+$/, "");
  const [whole, frac = ""] = trimmed.split(".");
  const padded = frac.padEnd(2, "0");
  return `${whole}.${padded} USD`;
}

const SCALE = BigInt(100000000);

export type Money = string;

export function moneyFromNumber(value: number): Money {
  if (!Number.isFinite(value)) throw new Error("金额无效");
  const negative = Object.is(value, -0) || value < 0;
  const scaled = BigInt(Math.round(Math.abs(value) * 1e8));
  return formatScaled(negative ? -scaled : scaled);
}

export function moneyFromDecimal(value: string): Money {
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error("金额无效");
  return formatScaled(scale(text));
}

export function moneyToNumber(value: Money): number {
  return Number(value);
}

export function moneyEquals(left: Money, right: Money): boolean {
  return scale(left) === scale(right);
}

export function addMoney(left: Money, right: Money): Money {
  return formatScaled(scale(left) + scale(right));
}

export function subMoney(left: Money, right: Money): Money {
  return formatScaled(scale(left) - scale(right));
}

export function compareMoney(left: Money, right: Money): number {
  const delta = scale(left) - scale(right);
  if (delta === BigInt(0)) return 0;
  return delta > BigInt(0) ? 1 : -1;
}

function scale(value: string): bigint {
  const negative = value.startsWith("-");
  const raw = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = raw.split(".");
  const frac = (fraction + "00000000").slice(0, 8);
  if (!/^\d+$/.test(whole || "0") || !/^\d{8}$/.test(frac)) throw new Error("金额无效");
  const scaled = BigInt(whole || "0") * SCALE + BigInt(frac);
  return negative ? -scaled : scaled;
}

function formatScaled(scaled: bigint): Money {
  const negative = scaled < BigInt(0);
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  const text = frac ? `${whole.toString()}.${frac}` : whole.toString();
  return negative ? `-${text}` : text;
}
