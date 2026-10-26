#!/usr/bin/env python3
"""Conservatively classify cached KMail messages using RFC822 headers only."""

from __future__ import annotations

import csv
import email
import email.parser
import email.policy
import json
import os
import re
import subprocess
from collections import Counter
from email.header import decode_header, make_header
from email.utils import getaddresses, parseaddr
from pathlib import Path


HERE = Path(__file__).resolve().parent


def load_config() -> dict:
    path = Path(os.environ.get("KMAIL_CLEANUP_CONFIG", HERE / "config.json")).expanduser()
    try:
        with path.open(encoding="utf-8") as handle:
            config = json.load(handle)
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"Configuration is missing: {path}. Copy config.example.json to config.json and customize it."
        ) from exc
    if not isinstance(config, dict):
        raise RuntimeError(f"Configuration must contain a JSON object: {path}")
    return config


CONFIG = load_config()
ROOT = Path(CONFIG.get("payload_root", "~/.local/share/akonadi/file_db_data")).expanduser()
OUT = Path(CONFIG.get("inventory_output", "~/mail_cleanup")).expanduser()
SOCKET = os.path.expandvars(CONFIG.get("akonadi_socket", "$XDG_RUNTIME_DIR/akonadi/mysql.socket"))
DB = str(CONFIG.get("database", "akonadi"))
INBOX_ID = int(CONFIG["inbox_id"])
SENT_ID = int(CONFIG["sent_id"])


PROTECTED = re.compile(
    r"\b(invoice|receipt|payment|paid|refund|charge|transaction|bank|statement|tax|"
    r"security|password|verification|verify|login|sign[ -]?in|two.factor|2fa|otp|"
    r"order|booking|reservation|ticket|flight|train|hotel|rental|delivery|shipped|"
    r"appointment|doctor|hospital|health|insurance|pension|government|municipality|"
    r"legal|contract|agreement|application|interview|employment|salary|university|"
    r"exam|grade|course|deadline|registration|renewal|domain|hosting|certificate|"
    r"account (?:closed|suspended|locked)|action required|urgent)\b",
    re.I,
)

LOW_VALUE = re.compile(
    r"\b(digest|newsletter|weekly|monthly|roundup|what(?:'s| is) new|new post|"
    r"new article|new video|new follower|started following|suggested for you|"
    r"people you may know|recommend(?:ed|ations?)|trending|community update|"
    r"activity update|notification|notifications|unread updates?|"
    r"someone (?:liked|commented|posted)|your .* recap|job alert|price drop|"
    r"back in stock|survey|please rate|tell us what you think)\b",
    re.I,
)

PROMO = re.compile(
    r"\b(sale|save \d|% off|discount|offer|deal|shop now|buy now|last chance|"
    r"limited time|clearance|free shipping|coupon|promo(?:tion| code)?|"
    r"black friday|cyber monday|new arrivals?|exclusive|member price|"
    r"book now|upgrade now|subscribe|subscription offer|win a|giveaway)\b",
    re.I,
)

AUTOMATED = re.compile(
    r"(?:^|[._+-])(no-?reply|do-?not-?reply|notifications?|alerts?|updates?|news|"
    r"newsletter|mailer|marketing|campaign|digest)(?:[._+-]|@|$)",
    re.I,
)


def query(sql: str) -> list[list[str]]:
    result = subprocess.run(
        ["mariadb", "--protocol=socket", f"--socket={SOCKET}", DB, "-N", "-B", "-e", sql],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return [line.split("\t") for line in result.stdout.splitlines() if line]


def message_rows(collection_id: int) -> list[list[str]]:
    return query(
        "SELECT i.id,CONVERT(i.remoteId USING utf8mb4),DATE_FORMAT(i.datetime,'%Y-%m-%d %H:%i:%s'),"
        "i.size,CONVERT(p.data USING utf8mb4) "
        "FROM pimitemtable i JOIN parttable p ON p.pimItemId=i.id "
        "JOIN parttypetable pt ON pt.id=p.partTypeId "
        f"WHERE i.collectionId={collection_id} AND pt.name='RFC822' AND p.storage=1 ORDER BY i.id"
    )


def payload_path(reference: str) -> Path:
    number = int(reference.split("_", 1)[0])
    return ROOT / f"{number % 100:02d}" / reference


def clean_header(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value))).replace("\r", " ").replace("\n", " ").strip()
    except Exception:
        return value.replace("\r", " ").replace("\n", " ").strip()


def load_headers(reference: str) -> email.message.Message | None:
    path = payload_path(reference)
    try:
        with path.open("rb") as handle:
            return email.parser.BytesHeaderParser(policy=email.policy.default).parse(handle)
    except (OSError, ValueError, email.errors.MessageError):
        return None


def addresses(msg: email.message.Message, fields: tuple[str, ...]) -> set[str]:
    values: list[str] = []
    for field in fields:
        values.extend(msg.get_all(field, []))
    return {addr.lower() for _, addr in getaddresses(values) if "@" in addr}


def sent_contacts() -> set[str]:
    contacts: set[str] = set()
    for row in message_rows(SENT_ID):
        msg = load_headers(row[4])
        if msg:
            contacts.update(addresses(msg, ("to", "cc", "bcc")))
    return contacts


def classify(msg: email.message.Message, contacts: set[str]) -> tuple[str, str]:
    subject = clean_header(msg.get("subject"))
    sender = parseaddr(clean_header(msg.get("from")))[1].lower()
    joined = f"{subject} {sender} {clean_header(msg.get('from'))}"
    list_signal = bool(
        msg.get("list-unsubscribe")
        or msg.get("list-id")
        or re.search(r"\b(?:bulk|list|junk)\b", clean_header(msg.get("precedence")), re.I)
    )
    auto_signal = bool(
        AUTOMATED.search(sender)
        or (msg.get("auto-submitted") and clean_header(msg.get("auto-submitted")).lower() != "no")
        or re.search(r"\bauto(?:matic|mated)?.*(?:message|notification)\b", joined, re.I)
    )
    protected = bool(PROTECTED.search(joined))
    known_contact = sender in contacts

    if protected:
        return "keep", "protected-topic"
    if known_contact:
        return "keep", "prior-correspondent"
    if list_signal and PROMO.search(joined):
        return "advertisement", "bulk+promotion"
    if list_signal:
        return "bulk-mail", "mailing-list"
    if auto_signal and LOW_VALUE.search(joined):
        return "notification", "automated+low-value"
    if auto_signal and PROMO.search(joined):
        return "advertisement", "automated+promotion"
    return "keep", "personal-or-uncertain"


def main() -> None:
    contacts = sent_contacts()
    rows = message_rows(INBOX_ID)
    candidates: list[dict[str, str]] = []
    decisions = Counter()
    reasons = Counter()
    senders = Counter()
    missing = 0

    for item_id, remote_id, date, size, reference in rows:
        msg = load_headers(reference)
        if msg is None:
            missing += 1
            continue
        category, reason = classify(msg, contacts)
        decisions[category] += 1
        reasons[reason] += 1
        if category == "keep":
            continue
        from_header = clean_header(msg.get("from"))
        sender = parseaddr(from_header)[1].lower() or from_header
        senders[sender] += 1
        candidates.append(
            {
                "akonadi_id": item_id,
                "imap_uid": remote_id,
                "date": date,
                "category": category,
                "reason": reason,
                "sender": from_header,
                "subject": clean_header(msg.get("subject")),
                "size": size,
            }
        )

    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / "candidates.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(candidates[0]) if candidates else ["akonadi_id"])
        writer.writeheader()
        writer.writerows(candidates)

    lines = [
        "# Conservative KMail cleanup inventory",
        "",
        f"- Inbox messages inspected: {len(rows):,}",
        f"- Review candidates: {len(candidates):,}",
        f"- Preserved as personal, important, or uncertain: {decisions['keep']:,}",
        f"- Cached messages whose headers could not be read: {missing:,}",
        f"- Prior correspondents protected: {len(contacts):,}",
        "",
        "## Candidate categories",
        "",
    ]
    for category in ("advertisement", "bulk-mail", "notification"):
        lines.append(f"- {category}: {decisions[category]:,}")
    lines.extend(["", "## Most frequent candidate senders", ""])
    for sender, count in senders.most_common(30):
        lines.append(f"- {count:,} — {sender}")
    lines.extend(
        [
            "",
            "No message was moved or deleted by this inventory step. The CSV contains headers only, not message bodies.",
            "",
        ]
    )
    (OUT / "inventory.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines[:14]))


if __name__ == "__main__":
    main()
