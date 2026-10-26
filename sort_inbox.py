#!/usr/bin/env python3
"""Preview or move unwanted KMail Inbox messages to a configured review folder.

No message is permanently deleted. Run without --apply to preview.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime
from email.utils import parseaddr
from pathlib import Path

import classify_kmail as mail


HERE = Path(__file__).resolve().parent
CONFIG = mail.CONFIG
RESOURCE = str(CONFIG["resource"])
ACCOUNT_ROOT = int(CONFIG["account_root_id"])
ACCOUNT_ROOT_NAME = str(CONFIG["account_root_name"])
INBOX = int(CONFIG["inbox_id"])
INBOX_NAME = str(CONFIG.get("inbox_name", "INBOX"))
REVIEW = int(CONFIG["review_id"])
REVIEW_NAME = str(CONFIG["review_name"])
MOVER = HERE / "kmail_cleanup_move"

CUSTOM_RULES = CONFIG.get("cleanup_rules", [])
PROTECTED_SUBJECT = re.compile(CONFIG.get("protected_subject_pattern", r"(?!)"), re.I)
ENABLED_PRESETS = set(CONFIG.get("enabled_presets", ["newsletters", "promotions", "notifications"]))
CATEGORY_PRESETS = {
    "bulk-mail": "newsletters",
    "advertisement": "promotions",
    "notification": "notifications",
}
AI_SETTINGS = CONFIG.get("ai_settings", {})
TRAINING_EXAMPLES = CONFIG.get("training_examples", [])


def learning_features(sender: str, subject: str) -> list[str]:
    sender = sender.casefold()
    domain = sender.rsplit("@", 1)[-1] if "@" in sender else ""
    words = re.findall(r"[^\W_]{3,}", subject.casefold(), re.UNICODE)[:40]
    features = [f"word:{word}" for word in words]
    if sender:
        features.append(f"sender:{sender}")
    if domain:
        features.append(f"domain:{domain}")
    return features


def learned_prediction(sender: str, subject: str) -> tuple[str, float] | None:
    if not AI_SETTINGS.get("enabled", False):
        return None
    labels = ("keep", "clean")
    examples = [item for item in TRAINING_EXAMPLES if item.get("label") in labels]
    minimum = int(AI_SETTINGS.get("min_examples_per_class", 4))
    documents = {label: [item for item in examples if item["label"] == label] for label in labels}
    if any(len(documents[label]) < minimum for label in labels):
        return None

    counts = {label: Counter() for label in labels}
    totals = {label: 0 for label in labels}
    vocabulary: set[str] = set()
    for label in labels:
        for item in documents[label]:
            features = learning_features(str(item.get("sender", "")), str(item.get("subject", "")))
            counts[label].update(features)
            totals[label] += len(features)
            vocabulary.update(features)
    features = learning_features(sender, subject)
    if not features or not vocabulary:
        return None
    scores: dict[str, float] = {}
    for label in labels:
        scores[label] = math.log((len(documents[label]) + 1) / (len(examples) + len(labels)))
        denominator = totals[label] + len(vocabulary)
        scores[label] += sum(math.log((counts[label][feature] + 1) / denominator) for feature in features)
    highest = max(scores, key=scores.get)
    other = labels[0] if highest == labels[1] else labels[1]
    confidence = 1 / (1 + math.exp(-min(scores[highest] - scores[other], 60)))
    threshold = float(AI_SETTINGS.get("confidence_threshold", 0.9))
    return (highest, confidence) if confidence >= threshold else None


def db(sql: str) -> list[list[str]]:
    return mail.query(sql)


def one(sql: str) -> str:
    rows = db(sql)
    if len(rows) != 1 or len(rows[0]) != 1:
        raise RuntimeError(f"Unexpected database result for {sql!r}")
    return rows[0][0]


def validate_account() -> None:
    rows = db(
        "SELECT c.id,CONVERT(c.name USING utf8mb4),c.parentId,r.name "
        "FROM collectiontable c JOIN resourcetable r ON r.id=c.resourceId "
        f"WHERE c.id IN ({ACCOUNT_ROOT},{INBOX},{REVIEW}) ORDER BY c.id"
    )
    expected = [
        [str(ACCOUNT_ROOT), ACCOUNT_ROOT_NAME, "NULL", RESOURCE],
        [str(INBOX), INBOX_NAME, str(ACCOUNT_ROOT), RESOURCE],
        [str(REVIEW), REVIEW_NAME, str(ACCOUNT_ROOT), RESOURCE],
    ]
    if rows != expected:
        raise RuntimeError(f"Account/folder IDs changed. Refusing to run. Found: {rows!r}")
    if not MOVER.is_file():
        raise RuntimeError(f"Akonadi mover is missing: {MOVER}")


def classify(msg, contacts: set[str]) -> str | None:
    subject = mail.clean_header(msg.get("subject"))
    from_header = mail.clean_header(msg.get("from"))
    sender = parseaddr(from_header)[1].lower()
    domain = sender.rsplit("@", 1)[-1]

    for rule in CUSTOM_RULES:
        senders = {value.lower() for value in rule.get("senders", [])}
        domains = {value.lower() for value in rule.get("domains", [])}
        suffixes = tuple(value.lower() for value in rule.get("domain_suffixes", []))
        if senders and sender not in senders:
            continue
        if domains and domain not in domains:
            continue
        if suffixes and not any(domain == suffix or domain.endswith(f".{suffix}") for suffix in suffixes):
            continue
        if rule.get("subject_pattern") and not re.search(rule["subject_pattern"], subject, re.I):
            continue
        if rule.get("exclude_subject_pattern") and re.search(rule["exclude_subject_pattern"], subject, re.I):
            continue
        if rule.get("exclude_subject_exact") and subject.casefold() == rule["exclude_subject_exact"].casefold():
            continue
        return str(rule.get("reason", "configured cleanup rule"))

    if PROTECTED_SUBJECT.search(subject):
        return None
    prediction = learned_prediction(sender, subject)
    if prediction:
        label, confidence = prediction
        return f"learned preference ({confidence:.0%})" if label == "clean" else None
    category, reason = mail.classify(msg, contacts)
    preset = CATEGORY_PRESETS.get(category)
    return reason if preset in ENABLED_PRESETS else None


def message_examples(limit: int) -> list[dict[str, str]]:
    contacts = mail.sent_contacts()
    examples: list[dict[str, str]] = []
    for item_id, uid, date, _size, reference in reversed(mail.message_rows(INBOX)):
        if len(examples) >= limit:
            break
        msg = mail.load_headers(reference)
        if msg is None:
            continue
        from_header = mail.clean_header(msg.get("from"))
        sender = parseaddr(from_header)[1].lower()
        category, generic_reason = mail.classify(msg, contacts)
        configured_reason = classify(msg, contacts)
        examples.append(
            {
                "akonadi_id": item_id,
                "imap_uid": uid,
                "date": date,
                "sender": sender or from_header,
                "from": from_header,
                "subject": mail.clean_header(msg.get("subject")),
                "classification": "remove" if configured_reason else "keep",
                "reason": configured_reason or generic_reason,
                "generic_category": category,
            }
        )
    return examples


def write_report(rows: list[dict[str, str]], inspected: int, skipped: int) -> Path:
    run_dir = HERE / "runs" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    run_dir.mkdir(parents=True, exist_ok=False)
    path = run_dir / "candidates.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["akonadi_id", "imap_uid", "reason", "sender", "subject"])
        writer.writeheader()
        writer.writerows(rows)
    counts = Counter(row["reason"] for row in rows)
    summary = [f"Inspected: {inspected}", f"Candidates: {len(rows)}", f"Skipped uncached/unreadable: {skipped}"]
    summary += [f"{reason}: {count}" for reason, count in counts.most_common()]
    (run_dir / "summary.txt").write_text("\n".join(summary) + "\n", encoding="utf-8")
    print("\n".join(summary))
    print(f"Review the exact list: {path}")
    return path


def assert_current_batch(batch: list[dict[str, str]]) -> None:
    ids = ",".join(row["akonadi_id"] for row in batch)
    current = {
        item_id: (uid, dirty)
        for item_id, uid, dirty in db(
            "SELECT id,CONVERT(remoteId USING utf8mb4),dirty FROM pimitemtable "
            f"WHERE collectionId={INBOX} AND id IN ({ids})"
        )
    }
    for row in batch:
        if current.get(row["akonadi_id"]) != (row["imap_uid"], "0"):
            raise RuntimeError(f"Inbox changed since preview at item {row['akonadi_id']}; stopped")


def wait_for_ack(batch: list[dict[str, str]], timeout: int) -> None:
    ids = ",".join(row["akonadi_id"] for row in batch)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rows = db(
            "SELECT id,dirty,remoteId IS NOT NULL FROM pimitemtable "
            f"WHERE collectionId={REVIEW} AND id IN ({ids})"
        )
        if len(rows) == len(batch) and all(dirty == "0" and has_uid == "1" for _, dirty, has_uid in rows):
            return
        time.sleep(2)
    raise RuntimeError("Outlook did not acknowledge this batch in time; stopped. Do not rerun blindly.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="move matches from the most recent preview into the review folder")
    parser.add_argument("--report", type=Path, help="with --apply, use this preview CSV instead of the most recent one")
    parser.add_argument("--batch-size", type=int, default=100, help="messages per acknowledged batch (default: 100)")
    parser.add_argument("--timeout", type=int, default=120, help="seconds to wait for each batch (default: 120)")
    parser.add_argument("--examples", action="store_true", help="print recent Inbox headers as JSON for the desktop app")
    parser.add_argument("--limit", type=int, default=100, help="maximum examples returned with --examples (default: 100)")
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 250 or args.timeout < 10:
        parser.error("batch size must be 1–250 and timeout at least 10 seconds")
    if args.report and not args.apply:
        parser.error("--report requires --apply")
    if args.examples and args.apply:
        parser.error("--examples cannot be combined with --apply")
    if not 1 <= args.limit <= 500:
        parser.error("limit must be 1–500")

    validate_account()
    if args.examples:
        print(json.dumps(message_examples(args.limit), ensure_ascii=False))
        return 0
    if not args.apply:
        contacts = mail.sent_contacts()
        rows = []
        skipped = 0
        source = mail.message_rows(INBOX)
        for item_id, uid, _date, _size, reference in source:
            if not uid or uid == "NULL":
                skipped += 1
                continue
            msg = mail.load_headers(reference)
            if msg is None:
                skipped += 1
                continue
            reason = classify(msg, contacts)
            if reason:
                rows.append({"akonadi_id": item_id, "imap_uid": uid, "reason": reason,
                             "sender": mail.clean_header(msg.get("from")),
                             "subject": mail.clean_header(msg.get("subject"))})
        report = write_report(rows, len(source), skipped)
        print("Dry run: no mail moved. Rerun with --apply after reviewing the CSV.")
        return 0

    if args.report:
        report = args.report.resolve()
    else:
        reports = sorted((HERE / "runs").glob("*/candidates.csv"))
        if not reports:
            raise RuntimeError("No preview found; run without --apply first")
        report = reports[-1]
    if report.name != "candidates.csv" or report.parent.parent != (HERE / "runs").resolve():
        raise RuntimeError("Report must be a candidates.csv from this script's runs directory")
    if not (report.parent / "summary.txt").is_file():
        raise RuntimeError("Preview summary is missing; refusing to apply")
    with report.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if any(set(row) != {"akonadi_id", "imap_uid", "reason", "sender", "subject"} for row in rows):
        raise RuntimeError("Preview CSV has unexpected columns")
    if any(not row["akonadi_id"].isdigit() or not row["imap_uid"].isdigit() for row in rows):
        raise RuntimeError("Preview CSV has an invalid item ID or IMAP UID")
    if len({row["akonadi_id"] for row in rows}) != len(rows):
        raise RuntimeError("Preview CSV has duplicate item IDs")
    print(f"Applying reviewed report: {report} ({len(rows)} messages)", flush=True)
    if not rows:
        print("Nothing to move.")
        return 0
    if one(f"SELECT COUNT(*) FROM pimitemtable WHERE collectionId={REVIEW} AND dirty=1") != "0":
        raise RuntimeError("Review folder already has unacknowledged changes; resolve those first")
    for start in range(0, len(rows), args.batch_size):
        assert_current_batch(rows[start:start + args.batch_size])

    for start in range(0, len(rows), args.batch_size):
        batch = rows[start:start + args.batch_size]
        assert_current_batch(batch)
        batch_path = report.parent / f"batch_{start // args.batch_size + 1:03d}.csv"
        with batch_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(batch[0]))
            writer.writeheader()
            writer.writerows(batch)
        subprocess.run(
            [str(MOVER), str(batch_path), "--apply",
             "--account-root", str(ACCOUNT_ROOT), "--inbox", str(INBOX),
             "--review-name", REVIEW_NAME],
            check=True,
        )
        wait_for_ack(batch, args.timeout)
        print(f"Outlook acknowledged {min(start + len(batch), len(rows))}/{len(rows)}", flush=True)
    print("Done. No mail was permanently deleted.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, subprocess.CalledProcessError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
