# KMail cleanup

A local-first desktop app and CLI for conservative KMail/Akonadi cleanup. Choose
presets, teach it from recent KMail headers, preview the exact matches, and move
only that reviewed set to a configured review folder. It never permanently
deletes messages.

## Desktop app

The Tauri app provides:

- toggles for newsletters, promotions, and low-value notification presets;
- editable sender, domain, subject, and exclusion rules;
- a **Teach from mail** view that reads recent sender/subject headers directly
  from KMail and turns selected examples into explicit rules or private AI
  training examples;
- browsable preview history with exact sender, subject, and reason details,
  plus a confirmation step before moving anything; and
- an Akonadi folder scanner so account and collection IDs do not need to be
  discovered by hand.

Message bodies are never loaded into the UI. All processing stays on the local
machine, the window has a network-blocking content security policy, and the
review-first checks used by the CLI also protect actions started from the app.

### Exact rules and local learning

An **exact sender** rule matches one complete address, such as
`updates@example.com`. A **whole domain** rule matches every sender at that
domain and is therefore broader. Both are deterministic and take priority over
presets and learned preferences.

The optional preference learner is a small, on-device text classifier with no
API, subscription, network request, or model download. In **Teach from mail**,
select messages and label them **Teach: keep** or **Teach: clean**. It learns
from sender, domain, and subject words, requires examples from both classes,
and only acts above the configured confidence threshold. High-confidence keep
labels can protect mail from broad presets. Protected-topic safeguards are
checked before the learned model, and every clean prediction still goes through
the normal preview and review workflow.

Training subjects and senders stay in the ignored `config.json`; they are never
part of the public repository. Exact rules remain useful for deterministic
exceptions, while learning is better for patterns that span changing senders.

Install the JavaScript dependencies and start the desktop app:

```bash
npm install
npm run desktop
```

Build an installable RPM package with:

```bash
npm run desktop:build
```

## Setup

1. Copy `config.example.json` to `config.json` and fill in your Akonadi resource,
   collection IDs, folder names, and cleanup rules—or use **Mail setup → Scan
   Akonadi** in the desktop app. `config.json` is ignored by Git because these
   values and rules can reveal details about a mail account.
2. Build the local Akonadi helper:

   ```bash
   cmake -S . -B build
   cmake --build build
   ```

   The build places `kmail_cleanup_move` in the project root, where the Python
   script and Conduit expect it. The binary is also ignored by Git.

## Usage

Run a preview:

```bash
./sort_inbox.py
```

The command prints a summary and writes `candidates.csv` plus `summary.txt` to a
new timestamped directory under `runs/`. Review the sender and subject columns,
then move exactly those previewed messages:

```bash
./sort_inbox.py --apply
```

To apply a particular preview, use:

```bash
./sort_inbox.py --apply --report /path/to/runs/TIMESTAMP/candidates.csv
```

Before moving anything, the tool verifies the configured Akonadi account and
folder identities, the message IDs and IMAP UIDs, and the synchronization state.
Each batch waits for server acknowledgement. If a run stops with an error,
inspect the report and Akonadi state before trying again.

## Conduit compatibility

Conduit can continue to invoke `sort_inbox.py` with no arguments. Configuration
is loaded from the ignored `config.json`, reports stay under `runs/`, and the
line `Review the exact list: ...` remains unchanged for Conduit's report parser.
The optional `KMAIL_CLEANUP_CONFIG` environment variable can point to a config
file elsewhere without changing the command-line interface.

Run this as the desktop user that owns the KMail/Akonadi session, without
`sudo`. The scripts require `mariadb`, a running Akonadi service, Qt 6, and
KPim6 Akonadi development files.
