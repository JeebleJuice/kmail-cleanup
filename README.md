# KMail cleanup

A conservative KMail/Akonadi cleanup tool. It previews matching messages into a
timestamped CSV, then can move exactly that reviewed set to a configured review
folder. It never permanently deletes messages.

## Setup

1. Copy `config.example.json` to `config.json` and fill in your Akonadi resource,
   collection IDs, folder names, and cleanup rules. `config.json` is ignored by
   Git because these values and rules can reveal details about a mail account.
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
