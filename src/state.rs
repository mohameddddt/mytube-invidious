//! Subscriptions, history, watch later, likes, settings and feed cache, shared by every window (userdata.json).
use crate::config::CONFIG;
use serde_json::{Map, Value};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;

const LISTS: [&str; 4] = ["subscriptions", "history", "watchLater", "likes"]; // JSON arrays
const KEYS: [&str; 6] = ["subscriptions", "history", "watchLater", "likes", "settings", "feedCache"];
static LOCK: Mutex<()> = Mutex::new(());

fn file() -> PathBuf {
    CONFIG.data_dir.join("userdata.json")
}

pub fn load() -> Map<String, Value> {
    match fs::read_to_string(file()).ok().and_then(|t| serde_json::from_str(&t).ok()) {
        Some(Value::Object(m)) => m.into_iter().filter(|(k, _)| KEYS.contains(&k.as_str())).collect(),
        _ => Map::new(),
    }
}

pub fn valid(key: &str, value: &Value) -> bool {
    if LISTS.contains(&key) {
        return value.as_array().is_some_and(|a| a.len() <= 5000);
    }
    match key {
        "settings" => value.is_object(),
        "feedCache" => value.is_null() || value.is_object(),
        _ => false,
    }
}

/// Replace one key and write the file atomically, so a crash can never leave half a file.
pub fn save(key: &str, value: Value) -> io::Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = load();
    state.insert(key.to_string(), value);
    fs::create_dir_all(&CONFIG.data_dir)?;
    let tmp = file().with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec(&state)?)?;
    fs::rename(tmp, file())
}
