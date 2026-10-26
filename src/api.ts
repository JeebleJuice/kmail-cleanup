import { invoke } from "@tauri-apps/api/core";
import type { CollectionInfo, Config, MailExample, Run, RunDetail, ToolResult } from "./types";

export const api = {
  loadConfig: () => invoke<Config>("load_config"),
  saveConfig: (config: Config) => invoke<void>("save_config", { config }),
  loadExamples: (limit = 150) => invoke<MailExample[]>("load_examples", { limit }),
  preview: () => invoke<ToolResult>("run_preview"),
  applyLatest: () => invoke<ToolResult>("apply_latest"),
  listRuns: () => invoke<Run[]>("list_runs"),
  loadRun: (id: string) => invoke<RunDetail>("load_run", { id }),
  discoverCollections: () => invoke<CollectionInfo[]>("discover_collections"),
};
