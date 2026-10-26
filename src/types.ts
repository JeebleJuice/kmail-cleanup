export type Rule = {
  senders?: string[];
  domains?: string[];
  domain_suffixes?: string[];
  subject_pattern?: string;
  exclude_subject_pattern?: string;
  exclude_subject_exact?: string;
  reason?: string;
};

export type Config = {
  resource: string;
  account_root_id: number;
  account_root_name: string;
  inbox_id: number;
  inbox_name: string;
  sent_id: number;
  review_id: number;
  review_name: string;
  database: string;
  akonadi_socket: string;
  payload_root: string;
  inventory_output: string;
  protected_subject_pattern: string;
  enabled_presets: string[];
  cleanup_rules: Rule[];
};

export type MailExample = {
  akonadi_id: string;
  imap_uid: string;
  date: string;
  sender: string;
  from: string;
  subject: string;
  classification: "remove" | "keep";
  reason: string;
  generic_category: string;
};

export type Run = { id: string; path: string; summary: string; candidates: number };
export type Candidate = { akonadi_id: string; imap_uid: string; reason: string; sender: string; subject: string };
export type RunDetail = Run & { rows: Candidate[] };
export type ToolResult = { ok: boolean; stdout: string; stderr: string };
export type CollectionInfo = { id: number; name: string; parent_id: number | null; resource: string };
