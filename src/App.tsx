import { useEffect, useMemo, useState } from "react";
import {
  Archive, Check, ChevronRight, CircleAlert, Database, Inbox,
  LoaderCircle, Mail, MailCheck, Play, Plus, RefreshCw, Save, Search,
  Settings, ShieldCheck, SlidersHorizontal, Sparkles, Tag, Trash2, X,
} from "lucide-react";
import { api } from "./api";
import { learnedRules } from "./rules";
import type { CollectionInfo, Config, MailExample, PreviewStatus, Rule, Run, RunDetail, ToolResult } from "./types";

type View = "rules" | "teach" | "runs" | "settings";

const PRESETS = [
  { id: "newsletters", title: "Newsletters", description: "Mailing lists, digests and recurring editorial mail", icon: Mail },
  { id: "promotions", title: "Promotions", description: "Sales, offers, product announcements and campaigns", icon: Tag },
  { id: "notifications", title: "Low-value notifications", description: "Automated activity updates that are safe to review", icon: Sparkles },
];

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ruleLabel(rule: Rule) {
  if (rule.senders?.length) return rule.senders.join(", ");
  if (rule.domains?.length) return rule.domains.join(", ");
  if (rule.domain_suffixes?.length) return rule.domain_suffixes.map((d) => `*.${d}`).join(", ");
  if (rule.subject_pattern) return `Subject: ${rule.subject_pattern}`;
  return "Configured rule";
}

export default function App() {
  const [view, setView] = useState<View>("rules");
  const [config, setConfig] = useState<Config | null>(null);
  const [savedConfig, setSavedConfig] = useState("");
  const [examples, setExamples] = useState<MailExample[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<Run[]>([]);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ToolResult | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  const dirty = config ? JSON.stringify(config) !== savedConfig : false;
  const filteredExamples = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return examples;
    return examples.filter((mail) => `${mail.from} ${mail.subject} ${mail.reason}`.toLowerCase().includes(needle));
  }, [examples, query]);

  useEffect(() => {
    Promise.all([api.loadConfig(), api.listRuns(), api.latestPreviewStatus()])
      .then(([nextConfig, nextRuns, nextStatus]) => {
        nextConfig.enabled_presets ??= ["newsletters", "promotions", "notifications"];
        nextConfig.cleanup_rules ??= [];
        nextConfig.ai_settings ??= { enabled: false, confidence_threshold: 0.9, min_examples_per_class: 4 };
        nextConfig.training_examples ??= [];
        setConfig(nextConfig);
        setSavedConfig(JSON.stringify(nextConfig));
        setRuns(nextRuns);
        setPreviewStatus(nextStatus);
      })
      .catch((cause) => setError(errorText(cause)));
  }, []);

  useEffect(() => {
    const refreshStatus = () => {
      api.latestPreviewStatus().then(setPreviewStatus).catch(() => undefined);
    };
    const refreshWhenVisible = () => { if (!document.hidden) refreshStatus(); };
    window.addEventListener("focus", refreshStatus);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshStatus);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  async function save() {
    if (!config) return;
    setBusy("save"); setError("");
    try {
      await api.saveConfig(config);
      setSavedConfig(JSON.stringify(config));
      setNotice("Configuration saved");
      window.setTimeout(() => setNotice(""), 2400);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(""); }
  }

  async function loadExamples() {
    setBusy("examples"); setError("");
    try {
      if (dirty) await save();
      setExamples(await api.loadExamples());
      setSelected(new Set());
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(""); }
  }

  async function preview() {
    setBusy("preview"); setError(""); setResult(null);
    try {
      if (dirty) await save();
      const next = await api.preview();
      setResult(next);
      setRuns(await api.listRuns());
      setPreviewStatus(await api.latestPreviewStatus());
      setView("runs");
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(""); }
  }

  async function applyLatest() {
    setConfirmApply(false); setBusy("apply"); setError(""); setResult(null);
    try {
      const next = await api.applyLatest();
      setResult(next);
      setRuns(await api.listRuns());
      setPreviewStatus(await api.latestPreviewStatus());
    } catch (cause) {
      setError(errorText(cause));
      api.latestPreviewStatus().then(setPreviewStatus).catch(() => undefined);
    }
    finally { setBusy(""); }
  }

  function togglePreset(id: string) {
    if (!config) return;
    const enabled = new Set(config.enabled_presets);
    enabled.has(id) ? enabled.delete(id) : enabled.add(id);
    setConfig({ ...config, enabled_presets: [...enabled] });
  }

  function addRules(kind: "sender" | "domain") {
    if (!config) return;
    const existing = config.cleanup_rules;
    const additions = learnedRules(examples, selected, kind, existing);
    setConfig({ ...config, cleanup_rules: [...existing, ...additions] });
    setSelected(new Set());
    setNotice(`${additions.length} ${kind} rule${additions.length === 1 ? "" : "s"} added`);
    setView("rules");
  }

  async function teachAi(label: "keep" | "clean" | "receipt") {
    if (!config) return;
    const chosen = examples.filter((mail) => selected.has(mail.akonadi_id));
    const keys = new Set(chosen.map((mail) => `${mail.sender}\n${mail.subject}`));
    const retained = config.training_examples.filter((item) => !keys.has(`${item.sender}\n${item.subject}`));
    const training_examples = [...retained, ...chosen.map((mail) => ({ sender: mail.sender, subject: mail.subject, label }))];
    const next = { ...config, ai_settings: { ...config.ai_settings, enabled: true }, training_examples };
    setConfig(next); setSelected(new Set()); setBusy("teach-ai"); setError("");
    try {
      await api.saveConfig(next);
      setSavedConfig(JSON.stringify(next));
      setExamples(await api.loadExamples());
      setNotice(`Taught ${chosen.length} message${chosen.length === 1 ? "" : "s"} as ${label}`);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(""); }
  }

  if (!config) return <div className="splash"><LoaderCircle className="spin" /><span>Opening KMail Cleanup…</span>{error && <p>{error}</p>}</div>;

  const latest = runs[0];
  const liveStatus = previewStatus?.id === latest?.id ? previewStatus : null;
  const remaining = liveStatus?.pending ?? latest?.candidates;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><MailCheck size={22} /></div><div><strong>KMail Cleanup</strong><span>Local mail assistant</span></div></div>
        <nav>
          <Nav active={view === "rules"} icon={SlidersHorizontal} label="Rules & presets" onClick={() => setView("rules")} />
          <Nav active={view === "teach"} icon={Sparkles} label="Teach from mail" onClick={() => setView("teach")} />
          <Nav active={view === "runs"} icon={Archive} label="Preview & review" badge={remaining} onClick={() => setView("runs")} />
          <Nav active={view === "settings"} icon={Settings} label="Mail setup" onClick={() => setView("settings")} />
        </nav>
        <div className="safety-card"><ShieldCheck size={18} /><div><strong>Review-first</strong><span>Nothing is deleted. Mail moves only to {config.review_name} or {config.receipts_name}.</span></div></div>
        <div className="sidebar-footer"><span className="status-dot" />Akonadi · local only</div>
      </aside>

      <main>
        <header className="topbar">
          <div><span className="eyebrow">INBOX AUTOMATION</span><h1>{view === "rules" ? "Rules & presets" : view === "teach" ? "Teach from your mail" : view === "runs" ? "Preview & review" : "Mail setup"}</h1></div>
          <div className="header-actions">
            {dirty && <span className="unsaved">Unsaved changes</span>}
            <button className="button secondary" disabled={!dirty || !!busy} onClick={save}>{busy === "save" ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} Save</button>
            <button className="button primary" disabled={!!busy} onClick={preview}>{busy === "preview" ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />} Preview inbox</button>
          </div>
        </header>

        {error && <div className="banner error"><CircleAlert size={18} /><span>{error}</span><button onClick={() => setError("")}><X size={16} /></button></div>}
        {notice && <div className="toast"><Check size={16} />{notice}</div>}

        <div className="content">
          {view === "rules" && <RulesView config={config} onChange={setConfig} onTogglePreset={togglePreset} />}
          {view === "teach" && <TeachView examples={filteredExamples} allCount={examples.length} selected={selected} query={query} busy={busy} setQuery={setQuery} setSelected={setSelected} load={loadExamples} addRules={addRules} teachAi={teachAi} />}
          {view === "runs" && <RunsView runs={runs} status={liveStatus} result={result} busy={busy} preview={preview} requestApply={() => setConfirmApply(true)} />}
          {view === "settings" && <SettingsView config={config} onChange={setConfig} />}
        </div>
      </main>

      {confirmApply && <ConfirmModal run={latest} remaining={remaining ?? 0} close={() => setConfirmApply(false)} apply={applyLatest} reviewName={config.review_name} />}
    </div>
  );
}

function Nav({ active, icon: Icon, label, badge, onClick }: { active: boolean; icon: typeof Mail; label: string; badge?: number; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}><Icon size={18} /><span>{label}</span>{badge !== undefined && <b>{badge}</b>}<ChevronRight className="nav-chevron" size={15} /></button>;
}

function RulesView({ config, onChange, onTogglePreset }: { config: Config; onChange: (c: Config) => void; onTogglePreset: (id: string) => void }) {
  const [manualSender, setManualSender] = useState("");
  function addSender() {
    const value = manualSender.trim().toLowerCase();
    if (!value || !value.includes("@")) return;
    onChange({ ...config, cleanup_rules: [...config.cleanup_rules, { senders: [value], reason: "manual sender rule" }] });
    setManualSender("");
  }
  const keepCount = config.training_examples.filter((item) => item.label === "keep").length;
  const cleanCount = config.training_examples.filter((item) => item.label === "clean").length;
  const receiptCount = config.training_examples.filter((item) => item.label === "receipt").length;
  return <div className="stack">
    <section><div className="section-heading"><div><h2>Learned preferences</h2><p>A private, on-device model learns subject wording and sender patterns from your labels.</p></div></div>
      <div className="learning-card"><div className="learning-icon"><Sparkles size={21} /></div><div className="learning-copy"><strong>Local preference learning</strong><span>{keepCount} keep · {cleanCount} clean · {receiptCount} receipt examples · needs {config.ai_settings.min_examples_per_class} per learned category</span></div><label className="confidence"><span>Confidence {Math.round(config.ai_settings.confidence_threshold * 100)}%</span><input type="range" min="80" max="99" value={Math.round(config.ai_settings.confidence_threshold * 100)} onChange={(e) => onChange({ ...config, ai_settings: { ...config.ai_settings, confidence_threshold: Number(e.target.value) / 100 } })} /></label><button className={`switch ${config.ai_settings.enabled ? "on" : ""}`} aria-label="Toggle local preference learning" onClick={() => onChange({ ...config, ai_settings: { ...config.ai_settings, enabled: !config.ai_settings.enabled } })}><i /></button></div>
    </section>
    <section><div className="section-heading"><div><h2>Quick presets</h2><p>Start broad, then refine with learned rules. Protected topics still win.</p></div><span className="count-pill">{config.enabled_presets.length} active</span></div>
      <div className="preset-grid">{PRESETS.map(({ id, title, description, icon: Icon }) => {
        const enabled = config.enabled_presets.includes(id);
        return <button key={id} className={`preset-card ${enabled ? "enabled" : ""}`} onClick={() => onTogglePreset(id)}><div className="preset-icon"><Icon size={20} /></div><div><strong>{title}</strong><span>{description}</span></div><span className={`switch ${enabled ? "on" : ""}`}><i /></span></button>;
      })}</div>
    </section>
    <section><div className="section-heading"><div><h2>Your rules</h2><p>Specific rules are checked before presets.</p></div><span className="count-pill">{config.cleanup_rules.length} rules</span></div>
      <div className="quick-add"><Mail size={17} /><input value={manualSender} onChange={(e) => setManualSender(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addSender()} placeholder="Add an exact sender, e.g. updates@example.com" /><button className="button secondary" onClick={addSender}><Plus size={16} />Add sender</button></div>
      <div className="rule-list">{config.cleanup_rules.map((rule, index) => <div className="rule-row" key={`${ruleLabel(rule)}-${index}`}><div className="rule-kind">{rule.senders ? <Mail size={16} /> : rule.subject_pattern ? <Search size={16} /> : <Database size={16} />}</div><div><strong>{ruleLabel(rule)}</strong><span>{rule.reason || "configured cleanup rule"}{rule.subject_pattern && (rule.senders || rule.domains) ? ` · subject matches “${rule.subject_pattern}”` : ""}</span></div><button className="icon-button danger" title="Remove rule" onClick={() => onChange({ ...config, cleanup_rules: config.cleanup_rules.filter((_, i) => i !== index) })}><Trash2 size={16} /></button></div>)}</div>
    </section>
  </div>;
}

function TeachView({ examples, allCount, selected, query, busy, setQuery, setSelected, load, addRules, teachAi }: { examples: MailExample[]; allCount: number; selected: Set<string>; query: string; busy: string; setQuery: (s: string) => void; setSelected: (s: Set<string>) => void; load: () => void; addRules: (kind: "sender" | "domain") => void; teachAi: (label: "keep" | "clean" | "receipt") => void }) {
  function toggle(id: string) { const next = new Set(selected); next.has(id) ? next.delete(id) : next.add(id); setSelected(next); }
  return <div className="stack">
    <div className="teach-hero"><div className="hero-icon"><Inbox size={26} /></div><div><h2>Learn from real messages</h2><p>Load recent KMail headers, select mail you consider low-value, then create transparent sender or domain rules. Message bodies never leave KMail.</p></div><button className="button primary" disabled={!!busy} onClick={load}>{busy === "examples" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{allCount ? "Refresh inbox" : "Load inbox examples"}</button></div>
    {allCount > 0 && <><div className="mail-toolbar"><label><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sender, subject or reason" /></label><span>{examples.length} of {allCount} messages</span></div>
      <div className="mail-list">{examples.map((mail) => <button className={`mail-row ${selected.has(mail.akonadi_id) ? "selected" : ""}`} key={mail.akonadi_id} onClick={() => toggle(mail.akonadi_id)}><span className="checkbox">{selected.has(mail.akonadi_id) && <Check size={13} />}</span><div className="mail-sender"><strong>{mail.from || mail.sender}</strong><span>{mail.date}</span></div><div className="mail-subject"><strong>{mail.subject || "(No subject)"}</strong><span>{mail.reason}</span></div><span className={`decision ${mail.destination}`}>{mail.destination === "keep" ? "keep" : mail.destination}</span></button>)}</div>
      {selected.size > 0 && <div className="selection-bar"><span><b>{selected.size}</b> selected</span><button className="button keep-button" onClick={() => teachAi("keep")}>Teach: keep</button><button className="button clean-button" onClick={() => teachAi("clean")}>Teach: clean</button><button className="button receipt-button" onClick={() => teachAi("receipt")}>Teach: receipt</button><span className="bar-divider" /><button className="button secondary compact" title="Create exact sender rules" onClick={() => addRules("sender")}>Exact sender</button><button className="button secondary compact" title="Create broader domain rules" onClick={() => addRules("domain")}>Whole domain</button></div>}
    </>}
  </div>;
}

function RunsView({ runs, status, result, busy, preview, requestApply }: { runs: Run[]; status: PreviewStatus | null; result: ToolResult | null; busy: string; preview: () => void; requestApply: () => void }) {
  const latest = runs[0];
  const [selectedId, setSelectedId] = useState(latest?.id ?? "");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  useEffect(() => {
    if (!selectedId && latest) setSelectedId(latest.id);
    if (!selectedId) return;
    setDetail(null); setDetailError("");
    api.loadRun(selectedId).then(setDetail).catch((cause) => setDetailError(errorText(cause)));
  }, [selectedId, latest?.id]);
  const selectedRun = runs.find((run) => run.id === selectedId) ?? latest;
  const isLatest = selectedRun?.id === latest?.id;
  const remaining = isLatest && status ? status.pending : selectedRun?.candidates ?? 0;
  const stale = isLatest && status ? status.no_longer_in_inbox : 0;
  const changed = isLatest && status ? status.changed : 0;
  return <div className="runs-layout"><section className="run-focus"><div className="section-heading"><div><h2>{selectedId === latest?.id ? "Latest preview" : "Preview details"}</h2><p>A frozen list of messages that can be safely reviewed before moving.</p></div></div>
    {selectedRun ? <><div className="preview-card"><div className="score"><strong>{remaining}</strong><span>{isLatest ? "remaining" : "candidates"}</span></div><div className="preview-copy"><strong>{selectedRun.id}</strong><pre>{selectedRun.summary}</pre>{isLatest && status && <div className={`live-preview ${changed ? "warning" : ""}`}>{changed ? `${changed} message${changed === 1 ? " has" : "s have"} changed or are syncing — run again before filing.` : stale ? `${stale} message${stale === 1 ? " is" : "s are"} already out of Inbox; the list updated automatically.` : "Up to date with Inbox."}</div>}</div><div className="preview-actions"><button className="button secondary" disabled={!!busy} onClick={preview}><RefreshCw size={16} />Run again</button>{isLatest && remaining > 0 && <button className="button primary" disabled={!!busy || changed > 0} onClick={requestApply}><Archive size={16} />File {remaining} remaining</button>}{isLatest && remaining === 0 && <span className="up-to-date"><Check size={14} />Nothing left to file</span>}</div></div>
      <div className="candidate-panel"><div className="candidate-heading"><strong>Matched messages</strong><span>{detail ? `${detail.rows.length} rows` : "Loading…"}</span></div>{detailError && <div className="inline-error">{detailError}</div>}{detail && (detail.rows.length ? <div className="candidate-list">{detail.rows.map((row) => <div className="candidate-row" key={row.akonadi_id}><div><strong>{row.sender}</strong><span>{row.reason}</span></div><p>{row.subject || "(No subject)"}</p><b className={`route-tag ${row.destination || "review"}`}>{row.destination || "review"}</b></div>)}</div> : <div className="candidate-empty">This preview did not match any messages.</div>)}</div>
    </> : <div className="empty"><Archive size={30} /><h3>No preview yet</h3><p>Run a preview to see exactly what your rules match.</p><button className="button primary" onClick={preview}>Preview inbox</button></div>}
    {result && <div className={`result-panel ${result.ok ? "success" : "error"}`}><strong>{result.ok ? "Completed" : "Stopped safely"}</strong><pre>{result.stdout || result.stderr}</pre></div>}</section>
    <aside className="history"><h3>Recent previews</h3>{runs.map((run, index) => <button className={`history-row ${run.id === selectedId ? "current" : ""}`} key={run.id} onClick={() => setSelectedId(run.id)}><div><strong>{run.id}</strong><span>{run.candidates} candidates</span></div>{index === 0 && <span className="latest-tag">Latest</span>}</button>)}</aside></div>;
}

function SettingsView({ config, onChange }: { config: Config; onChange: (c: Config) => void }) {
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const numberField = (key: keyof Config, label: string) => <label className="field"><span>{label}</span><input type="number" value={String(config[key])} onChange={(e) => onChange({ ...config, [key]: Number(e.target.value) })} /></label>;
  const textField = (key: keyof Config, label: string) => <label className="field"><span>{label}</span><input value={String(config[key])} onChange={(e) => onChange({ ...config, [key]: e.target.value })} /></label>;
  async function scan() {
    setScanning(true); setScanError("");
    try { setCollections(await api.discoverCollections()); }
    catch (cause) { setScanError(errorText(cause)); }
    finally { setScanning(false); }
  }
  function selectCollection(kind: "account" | "inbox" | "sent" | "review" | "receipts", id: number) {
    const collection = collections.find((item) => item.id === id);
    if (!collection) return;
    if (kind === "account") onChange({ ...config, account_root_id: id, account_root_name: collection.name, resource: collection.resource });
    if (kind === "sent") onChange({ ...config, sent_id: id });
    if (kind === "review") onChange({ ...config, review_id: id, review_name: collection.name });
    if (kind === "receipts") onChange({ ...config, receipts_id: id, receipts_name: collection.name });
    if (kind === "inbox") {
      const account = collections.find((item) => item.id === collection.parent_id);
      onChange({ ...config, inbox_id: id, inbox_name: collection.name, resource: collection.resource,
        ...(account ? { account_root_id: account.id, account_root_name: account.name } : {}) });
    }
  }
  const picker = (kind: "account" | "inbox" | "sent" | "review" | "receipts", label: string, value: number) => <label className="field"><span>{label}</span><select value={value} onChange={(e) => selectCollection(kind, Number(e.target.value))}><option value={value}>#{value} · {kind === "account" ? config.account_root_name : kind === "inbox" ? config.inbox_name : kind === "review" ? config.review_name : kind === "receipts" ? config.receipts_name : "Current sent folder"}</option>{collections.filter((item) => item.id !== value).map((item) => <option key={item.id} value={item.id}>#{item.id} · {item.name} · {item.resource}</option>)}</select></label>;
  return <div className="settings-grid"><section><div className="section-heading"><div><h2>Mailbox identity</h2><p>These checks prevent the tool from touching the wrong account.</p></div><button className="button secondary" onClick={scan} disabled={scanning}>{scanning ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{collections.length ? "Scan again" : "Scan Akonadi"}</button></div>{scanError && <div className="inline-error">{scanError}</div>}{collections.length > 0 && <div className="scan-note"><Check size={15} />Found {collections.length} folders. Choosing an Inbox also fills its account and resource.</div>}<div className="form-grid">{collections.length ? <>{picker("account", "Account", config.account_root_id)}{picker("inbox", "Inbox", config.inbox_id)}{picker("sent", "Sent folder", config.sent_id)}{picker("review", "Review folder", config.review_id)}{picker("receipts", "Receipts folder", config.receipts_id)}</> : <>{textField("resource", "Akonadi resource")}{textField("account_root_name", "Account name")}{numberField("account_root_id", "Account collection ID")}{numberField("inbox_id", "Inbox collection ID")}{numberField("sent_id", "Sent collection ID")}{numberField("review_id", "Review collection ID")}{numberField("receipts_id", "Receipts collection ID")}{textField("inbox_name", "Inbox name")}{textField("review_name", "Review folder name")}{textField("receipts_name", "Receipts folder name")}</>}</div></section>
    <section><div className="section-heading"><div><h2>Advanced</h2><p>Defaults normally work for a standard Akonadi installation.</p></div></div><div className="form-grid one">{textField("akonadi_socket", "MariaDB socket")}{textField("payload_root", "Akonadi payload directory")}{textField("database", "Database")}</div></section></div>;
}

function ConfirmModal({ run, remaining, close, apply, reviewName }: { run?: Run; remaining: number; close: () => void; apply: () => void; reviewName: string }) {
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}><div className="modal"><div className="modal-icon"><Archive size={22} /></div><h2>File {remaining} messages?</h2><p>Only messages from preview <strong>{run?.id}</strong> that are still unchanged in Inbox will move to their displayed destination: <strong>{reviewName}</strong> or <strong>Receipts</strong>. Messages you already moved are skipped. Nothing is deleted.</p><div className="modal-actions"><button className="button secondary" onClick={close}>Cancel</button><button className="button primary" onClick={apply}>File reviewed messages</button></div></div></div>;
}
