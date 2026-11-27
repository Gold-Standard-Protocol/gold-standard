/**
 * The verdict vocabulary the launch scripts share: `fail` stops a ceremony step, `warn` is
 * read out and acknowledged, `pass` carries the value it confirmed so a printout doubles
 * as the ceremony record.
 */
export type Verdict = "pass" | "warn" | "fail";

export interface Finding {
  name: string;
  verdict: Verdict;
  detail: string;
}

export const pass = (name: string, detail = ""): Finding => ({ name, verdict: "pass", detail });
export const warn = (name: string, detail: string): Finding => ({ name, verdict: "warn", detail });
export const fail = (name: string, detail: string): Finding => ({ name, verdict: "fail", detail });

export function hasFailures(findings: Finding[]): boolean {
  return findings.some((f) => f.verdict === "fail");
}

export function formatFindings(findings: Finding[]): string {
  const mark: Record<Verdict, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const lines = findings.map((f) => `  ${mark[f.verdict]}  ${f.name}${f.detail ? ": " + f.detail : ""}`);
  const counts = (v: Verdict) => findings.filter((f) => f.verdict === v).length;
  lines.push("", `${counts("pass")} passed, ${counts("warn")} warnings, ${counts("fail")} failed`);
  return lines.join("\n");
}
