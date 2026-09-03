// Phase D：隐私状态机（计划 §10 / §4.5）。
//
// 四态（additive，不削弱既有会话鉴权）：
// - clear            ：正常本地保存与远程发送
// - redacted         ：以脱敏副本形式存储/导出（原文不动）
// - privacy_uncertain：允许本地持久化；远程发送与外部导出在用户确认前被阻断
// - blocked          ：不允许离开本地边界（不导出、不远程）
//
// 边界：脱敏只作用于导出/远程副本，绝不改动不可变的原始会话记录。
// 复用 lib/redaction.ts 的规则（EMAIL/PHONE/SECRET），检测与替换同源，避免两套口径。

import { redactText, type RedactionManifest } from "@/lib/redaction";

export type PrivacyState = "clear" | "redacted" | "privacy_uncertain" | "blocked";

export const PRIVACY_STATES: readonly PrivacyState[] = ["clear", "redacted", "privacy_uncertain", "blocked"];

export function isPrivacyState(value: unknown): value is PrivacyState {
  return typeof value === "string" && (PRIVACY_STATES as readonly string[]).includes(value);
}

export interface PrivacyAssessment {
  state: PrivacyState;
  /** 命中的检测类别（SECRET/EMAIL/PHONE），供 UI 与审计解释；不含原值。 */
  reasons: string[];
}

/**
 * 出站前检测：SECRET（密钥形态）→ blocked；EMAIL/PHONE → privacy_uncertain；
 * 无命中 → clear。确定性规则，无网络、无模型调用。
 */
export function assessPrivacy(...texts: string[]): PrivacyAssessment {
  const joined = texts.filter((text) => typeof text === "string" && text.length > 0).join("\n");
  const reasons: string[] = [];
  if (/\b(?:sk|api|token|key)[-_A-Za-z0-9]{8,}\b/i.test(joined)) reasons.push("SECRET");
  if (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(joined)) reasons.push("EMAIL");
  if (/(?<!\d)(?:\+?\d[\d -]{8,}\d)(?!\d)/.test(joined)) reasons.push("PHONE");
  if (reasons.includes("SECRET")) return { state: "blocked", reasons };
  if (reasons.length > 0) return { state: "privacy_uncertain", reasons };
  return { state: "clear", reasons: [] };
}

/** blocked / privacy_uncertain 均不允许外部导出（vault）与远程发送。 */
export function canLeaveLocalBoundary(state: PrivacyState): boolean {
  return state === "clear" || state === "redacted";
}

export interface RedactedCopy {
  title: string;
  summary: string;
  content: string;
  manifest: RedactionManifest;
}

/**
 * 生成导出/远程用脱敏副本：仅替换副本字段，输入原值不落盘、不入库。
 * aliases 一并作为脱敏字典注入（别名可能是人名/项目名）。
 */
export function redactCopy(title: string, summary: string, content: string, aliases: string[] = []): RedactedCopy {
  const dictionary: { PERSON: string[] } = { PERSON: aliases.filter((alias) => alias.trim().length > 0) };
  const titleOut = redactText(title, { dictionary });
  const summaryOut = redactText(summary, { dictionary });
  const contentOut = redactText(content, { dictionary });
  return {
    title: titleOut.text,
    summary: summaryOut.text,
    content: contentOut.text,
    manifest: {
      ruleVersion: "redaction-v1",
      manualReviewRequired: true,
      replacementCounts: sumCounts(titleOut.manifest.replacementCounts, summaryOut.manifest.replacementCounts, contentOut.manifest.replacementCounts),
    },
  };
}

function sumCounts(...counts: Array<Record<string, number>>): Record<string, number> {
  const total: Record<string, number> = {};
  for (const record of counts) {
    for (const [key, value] of Object.entries(record)) {
      total[key] = (total[key] ?? 0) + value;
    }
  }
  return total;
}
