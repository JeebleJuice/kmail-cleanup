import { describe, expect, it } from "vitest";
import { learnedRules } from "./rules";
import type { MailExample } from "./types";

const example = (id: string, sender: string): MailExample => ({
  akonadi_id: id, imap_uid: id, date: "", sender, from: sender, subject: "",
  classification: "keep", reason: "", generic_category: "keep",
});

describe("learnedRules", () => {
  it("deduplicates domains selected from KMail examples", () => {
    const rows = [example("1", "one@example.com"), example("2", "two@example.com")];
    expect(learnedRules(rows, new Set(["1", "2"]), "domain", [])).toEqual([
      { domains: ["example.com"], reason: "learned domain rule" },
    ]);
  });

  it("does not recreate an existing sender rule", () => {
    const rows = [example("1", "one@example.com")];
    expect(learnedRules(rows, new Set(["1"]), "sender", [{ senders: ["one@example.com"] }])).toEqual([]);
  });
});
