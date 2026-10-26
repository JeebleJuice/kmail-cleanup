import os
import sys
import unittest
from email.parser import Parser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
os.environ["KMAIL_CLEANUP_CONFIG"] = str(ROOT / "config.example.json")
sys.path.insert(0, str(ROOT))

import sort_inbox  # noqa: E402


class PreferenceLearningTests(unittest.TestCase):
    def setUp(self):
        self.original_settings = sort_inbox.AI_SETTINGS
        self.original_examples = sort_inbox.TRAINING_EXAMPLES
        sort_inbox.AI_SETTINGS = {
            "enabled": True,
            "confidence_threshold": 0.8,
            "min_examples_per_class": 3,
        }
        sort_inbox.TRAINING_EXAMPLES = [
            {"sender": f"sale{i}@shops.example", "subject": "Weekly sale discount offer", "label": "clean"}
            for i in range(4)
        ] + [
            {"sender": f"person{i}@work.example", "subject": "Project meeting notes attached", "label": "keep"}
            for i in range(4)
        ] + [
            {"sender": f"billing{i}@vendors.example", "subject": "Purchase completed card transaction", "label": "receipt"}
            for i in range(4)
        ]

    def tearDown(self):
        sort_inbox.AI_SETTINGS = self.original_settings
        sort_inbox.TRAINING_EXAMPLES = self.original_examples

    def test_learns_clean_subject_patterns(self):
        prediction = sort_inbox.learned_prediction("news@another.example", "Exclusive weekly discount offer")
        self.assertIsNotNone(prediction)
        self.assertEqual(prediction[0], "clean")

    def test_learns_keep_subject_patterns(self):
        prediction = sort_inbox.learned_prediction("colleague@elsewhere.example", "Project meeting notes")
        self.assertIsNotNone(prediction)
        self.assertEqual(prediction[0], "keep")

    def test_learns_receipt_patterns(self):
        prediction = sort_inbox.learned_prediction("billing@different.example", "Completed card transaction")
        self.assertIsNotNone(prediction)
        self.assertEqual(prediction[0], "receipt")

    def test_completed_receipt_is_routed(self):
        message = Parser().parsestr("From: billing@shop.example\nSubject: Kvittering for dit køb\n\n")
        self.assertEqual(sort_inbox.classify_receipt(message), "receipt or completed purchase")

    def test_payment_problem_is_not_routed_as_receipt(self):
        message = Parser().parsestr("From: billing@shop.example\nSubject: Payment failed - action required\n\n")
        self.assertIsNone(sort_inbox.classify_receipt(message))

    def test_reconcile_skips_messages_already_moved_from_inbox(self):
        rows = [
            {"akonadi_id": "1", "imap_uid": "101"},
            {"akonadi_id": "2", "imap_uid": "102"},
            {"akonadi_id": "3", "imap_uid": "103"},
        ]
        original_db = sort_inbox.db
        sort_inbox.db = lambda _sql: [["1", "101", "0"], ["3", "999", "0"]]
        try:
            pending, moved, changed = sort_inbox.reconcile_report(rows)
        finally:
            sort_inbox.db = original_db
        self.assertEqual([row["akonadi_id"] for row in pending], ["1"])
        self.assertEqual([row["akonadi_id"] for row in moved], ["2"])
        self.assertEqual([row["akonadi_id"] for row in changed], ["3"])


if __name__ == "__main__":
    unittest.main()
