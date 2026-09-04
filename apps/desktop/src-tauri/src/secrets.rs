//! API key / token storage in the OS keychain, plus a guarded env-var reader for dev.
use keyring::Entry;

const SERVICE: &str = "com.thewater.desktop";

fn entry(name: &str) -> Result<Entry, String> {
    if name.is_empty() || name.len() > 200 {
        return Err("invalid secret name".into());
    }
    Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    entry(&name)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Read an API key from the process environment. Only names that look like
/// `SOMETHING_API_KEY` are allowed so the webview cannot enumerate arbitrary env.
#[tauri::command]
pub fn read_env_api_key(name: String) -> Result<Option<String>, String> {
    let ok = name.len() <= 64
        && name.ends_with("_API_KEY")
        && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if !ok {
        return Err("env name not allowed".into());
    }
    Ok(std::env::var(&name).ok().filter(|v| !v.is_empty()))
}
