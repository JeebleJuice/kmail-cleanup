import os
import sys
import unittest
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


if __name__ == "__main__":
    unittest.main()
