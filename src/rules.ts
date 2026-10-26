import type { MailExample, Rule } from "./types";

export function learnedRules(
  examples: MailExample[],
  selected: Set<string>,
  kind: "sender" | "domain",
  existing: Rule[],
): Rule[] {
  const values = [...new Set(examples
    .filter((mail) => selected.has(mail.akonadi_id))
    .map((mail) => kind === "sender" ? mail.sender : mail.sender.split("@")[1])
    .filter((value): value is string => Boolean(value)))];
  return values
    .filter((value) => !existing.some((rule) => kind === "sender"
      ? rule.senders?.includes(value)
      : rule.domains?.includes(value)))
    .map((value) => kind === "sender"
      ? { senders: [value], reason: "learned sender rule" }
      : { domains: [value], reason: "learned domain rule" });
}
