import {
  formatEther as viemFormatEther,
  parseEther as viemParseEther,
  parseUnits as viemParseUnits,
} from "viem";

export function formatEther(value: bigint) {
  return viemFormatEther(value);
}

export function formatToDecimals(value: bigint) {
  const v = (+formatEther(value));
  return (v % 1 !== 0) ? v.toFixed(6) : v.toString();
}

export function parseUnits(value: string, decimals: number) {
  return viemParseUnits(value as `${number}`, decimals);
}

export function parseEther(value: string) {
  return viemParseEther(value as `${number}`);
}
