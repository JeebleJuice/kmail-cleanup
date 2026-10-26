use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone)]
struct AppState { root: PathBuf }

#[derive(Serialize)]
struct ToolResult { ok: bool, stdout: String, stderr: String }

#[derive(Serialize)]
struct RunSummary { id: String, path: String, summary: String, candidates: usize }

#[derive(Serialize, Deserialize)]
struct CandidateRow { akonadi_id: String, imap_uid: String, reason: String, sender: String, subject: String }

#[derive(Serialize)]
struct RunDetail { id: String, path: String, summary: String, candidates: usize, rows: Vec<CandidateRow> }

#[derive(Serialize)]
struct CollectionInfo { id: i64, name: String, parent_id: Option<i64>, resource: String }

#[derive(Deserialize)]
struct RequiredConfig {
    resource: String,
    account_root_id: i64,
    account_root_name: String,
    inbox_id: i64,
    sent_id: i64,
    review_id: i64,
    review_name: String,
    cleanup_rules: Vec<Value>,
    enabled_presets: Vec<String>,
}

fn project_root() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("KMAIL_CLEANUP_HOME") {
        let root = PathBuf::from(path);
        if root.join("sort_inbox.py").is_file() { return Ok(root); }
    }
    if let Ok(current) = std::env::current_dir() {
        if current.join("sort_inbox.py").is_file() { return Ok(current); }
        if current.parent().is_some_and(|parent| parent.join("sort_inbox.py").is_file()) {
            return Ok(current.parent().unwrap().to_path_buf());
        }
    }
    let root = dirs::home_dir().ok_or("Home directory is unavailable")?.join("Dev/kmail-cleanup");
    root.join("sort_inbox.py").is_file().then_some(root)
        .ok_or_else(|| "KMail Cleanup project was not found. Set KMAIL_CLEANUP_HOME to its directory.".into())
}

fn validate_config(value: &Value) -> Result<(), String> {
    let config: RequiredConfig = serde_json::from_value(value.clone())
        .map_err(|error| format!("Invalid configuration: {error}"))?;
    if config.resource.trim().is_empty() || config.account_root_name.trim().is_empty() || config.review_name.trim().is_empty() {
        return Err("Resource, account name, and review folder name are required".into());
    }
    if [config.account_root_id, config.inbox_id, config.sent_id, config.review_id].iter().any(|id| *id <= 0) {
        return Err("All collection IDs must be positive numbers".into());
    }
    if config.cleanup_rules.len() > 2_000 { return Err("Too many cleanup rules".into()); }
    let allowed = ["newsletters", "promotions", "notifications"];
    if config.enabled_presets.iter().any(|preset| !allowed.contains(&preset.as_str())) {
        return Err("Configuration contains an unknown preset".into());
    }
    Ok(())
}

#[tauri::command]
fn load_config(state: tauri::State<AppState>) -> Result<Value, String> {
    let text = fs::read_to_string(state.root.join("config.json"))
        .map_err(|error| format!("Cannot open config.json: {error}"))?;
    let value = serde_json::from_str(&text).map_err(|error| format!("Cannot parse config.json: {error}"))?;
    validate_config(&value)?;
    Ok(value)
}

#[tauri::command]
fn save_config(config: Value, state: tauri::State<AppState>) -> Result<(), String> {
    validate_config(&config)?;
    let destination = state.root.join("config.json");
    let temporary = state.root.join("config.json.tmp");
    let bytes = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new().create(true).truncate(true).write(true).mode(0o600)
        .open(&temporary).map_err(|error| format!("Cannot write configuration: {error}"))?;
    file.write_all(&bytes).and_then(|_| file.write_all(b"\n")).and_then(|_| file.sync_all())
        .map_err(|error| format!("Cannot finish configuration: {error}"))?;
    fs::rename(&temporary, &destination).map_err(|error| format!("Cannot replace configuration: {error}"))
}

fn run_python(root: &Path, arguments: &[&str]) -> Result<ToolResult, String> {
    let script = root.join("sort_inbox.py").canonicalize()
        .map_err(|error| format!("Cleanup script is unavailable: {error}"))?;
    if script.parent() != root.canonicalize().ok().as_deref() {
        return Err("Cleanup script resolved outside the project".into());
    }
    let output = Command::new("python3").arg(script).args(arguments).current_dir(root).output()
        .map_err(|error| format!("Cannot start cleanup tool: {error}"))?;
    let result = ToolResult {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    };
    if result.ok { Ok(result) } else { Err(if result.stderr.is_empty() { result.stdout } else { result.stderr }) }
}

#[tauri::command]
fn load_examples(limit: usize, state: tauri::State<AppState>) -> Result<Value, String> {
    let safe_limit = limit.clamp(1, 500).to_string();
    let result = run_python(&state.root, &["--examples", "--limit", &safe_limit])?;
    serde_json::from_str(&result.stdout).map_err(|error| format!("Cleanup tool returned invalid example data: {error}"))
}

#[tauri::command]
fn run_preview(state: tauri::State<AppState>) -> Result<ToolResult, String> {
    run_python(&state.root, &[])
}

fn run_directories(root: &Path) -> Vec<PathBuf> {
    let mut directories = fs::read_dir(root.join("runs")).into_iter().flatten().filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path()).collect::<Vec<_>>();
    directories.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    directories
}

#[tauri::command]
fn list_runs(state: tauri::State<AppState>) -> Result<Vec<RunSummary>, String> {
    Ok(run_directories(&state.root).into_iter().filter_map(|path| {
        let report = path.join("candidates.csv");
        let summary_path = path.join("summary.txt");
        if !report.is_file() || !summary_path.is_file() { return None; }
        let summary = fs::read_to_string(summary_path).ok()?;
        let candidates = summary.lines().find_map(|line| line.strip_prefix("Candidates: "))?.parse().ok()?;
        Some(RunSummary {
            id: path.file_name()?.to_string_lossy().to_string(),
            path: report.to_string_lossy().to_string(),
            summary,
            candidates,
        })
    }).take(30).collect())
}

#[tauri::command]
fn load_run(id: String, state: tauri::State<AppState>) -> Result<RunDetail, String> {
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit() || byte == b'-') {
        return Err("Invalid preview identifier".into());
    }
    let runs = state.root.join("runs").canonicalize().map_err(|error| format!("Runs directory is unavailable: {error}"))?;
    let directory = runs.join(&id).canonicalize().map_err(|error| format!("Preview is unavailable: {error}"))?;
    if directory.parent() != Some(runs.as_path()) { return Err("Preview resolved outside the runs directory".into()); }
    let report = directory.join("candidates.csv");
    let summary = fs::read_to_string(directory.join("summary.txt")).map_err(|error| format!("Cannot read preview summary: {error}"))?;
    let mut reader = csv::Reader::from_path(&report).map_err(|error| format!("Cannot read preview candidates: {error}"))?;
    let rows = reader.deserialize::<CandidateRow>().collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot parse preview candidates: {error}"))?;
    Ok(RunDetail { id, path: report.to_string_lossy().to_string(), candidates: rows.len(), summary, rows })
}

#[tauri::command]
fn apply_latest(state: tauri::State<AppState>) -> Result<ToolResult, String> {
    let report = run_directories(&state.root).into_iter().find_map(|path| {
        let report = path.join("candidates.csv");
        (report.is_file() && path.join("summary.txt").is_file()).then_some(report)
    }).ok_or("No complete preview is available")?;
    let report = report.to_str().ok_or("Preview path is not valid UTF-8")?;
    run_python(&state.root, &["--apply", "--report", report])
}

#[tauri::command]
fn discover_collections(state: tauri::State<AppState>) -> Result<Vec<CollectionInfo>, String> {
    let config = load_config(state.clone())?;
    let raw_socket = config.get("akonadi_socket").and_then(Value::as_str)
        .unwrap_or("$XDG_RUNTIME_DIR/akonadi/mysql.socket");
    let socket = if let Some(rest) = raw_socket.strip_prefix("$XDG_RUNTIME_DIR/") {
        let runtime = std::env::var("XDG_RUNTIME_DIR").map_err(|_| "XDG_RUNTIME_DIR is unavailable")?;
        Path::new(&runtime).join(rest).to_string_lossy().to_string()
    } else { raw_socket.to_string() };
    let database = config.get("database").and_then(Value::as_str).unwrap_or("akonadi");
    let output = Command::new("mariadb")
        .args(["--protocol=socket", &format!("--socket={socket}"), database, "-N", "-B", "-e",
            "SELECT c.id,CONVERT(c.name USING utf8mb4),IFNULL(c.parentId,''),r.name FROM collectiontable c JOIN resourcetable r ON r.id=c.resourceId ORDER BY r.name,c.id"])
        .output().map_err(|error| format!("Cannot inspect Akonadi: {error}"))?;
    if !output.status.success() {
        return Err(format!("Cannot inspect Akonadi: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    String::from_utf8_lossy(&output.stdout).lines().map(|line| {
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() != 4 { return Err("Akonadi returned an unexpected collection row".into()); }
        Ok(CollectionInfo {
            id: fields[0].parse().map_err(|_| "Akonadi returned an invalid collection ID")?,
            name: fields[1].to_string(),
            parent_id: if fields[2].is_empty() { None } else { Some(fields[2].parse().map_err(|_| "Akonadi returned an invalid parent ID")?) },
            resource: fields[3].to_string(),
        })
    }).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let root = project_root().expect("KMail Cleanup project directory is unavailable");
    tauri::Builder::default()
        .manage(AppState { root })
        .invoke_handler(tauri::generate_handler![load_config, save_config, load_examples, run_preview, list_runs, load_run, apply_latest, discover_collections])
        .run(tauri::generate_context!())
        .expect("error while running KMail Cleanup");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_presets() {
        let value = serde_json::json!({
            "resource":"resource", "account_root_id":1, "account_root_name":"Account",
            "inbox_id":2, "sent_id":3, "review_id":4, "review_name":"Review",
            "cleanup_rules":[], "enabled_presets":["delete-everything"]
        });
        assert!(validate_config(&value).is_err());
    }
}
