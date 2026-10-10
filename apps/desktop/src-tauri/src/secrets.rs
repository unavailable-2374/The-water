//! API Key / 账号 token 的存储。
//!
//! v1 只发 macOS：密钥后端就是系统钥匙串（keyring 的 apple-native）。
//! 其它平台不链接 keyring，一律返回明确错误，绝不退化成明文存储 —— 与
//! `Cargo.toml` 里的平台条件依赖是同一个决定，详见 docs/RELEASE.md。

/// The bundle identifier is the credential namespace, just as it is for app data.
/// Never fall back to the production service: TEST builds must not read, overwrite,
/// or delete production credentials even when a backup contains the same secretRef.
fn credential_service(identifier: &str) -> Result<&str, String> {
    if identifier.is_empty() {
        return Err("missing application identifier for credential storage".into());
    }
    Ok(identifier)
}

/// 名字校验对所有平台一致：webview 不能借它去枚举钥匙串。
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 200 {
        return Err("invalid secret name".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod backend {
    use keyring::Entry;

    fn entry(service: &str, name: &str) -> Result<Entry, String> {
        Entry::new(service, name).map_err(|e| e.to_string())
    }

    pub fn set(service: &str, name: &str, value: &str) -> Result<(), String> {
        entry(service, name)?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    pub fn get(service: &str, name: &str) -> Result<Option<String>, String> {
        match entry(service, name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(service: &str, name: &str) -> Result<(), String> {
        match entry(service, name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod backend {
    const UNSUPPORTED: &str =
        "当前平台还没有密钥存储后端：The Water v1 只发布 macOS 版本。Windows / Linux 需要先接上对应的凭据后端（见 docs/RELEASE.md）。";

    pub fn set(_service: &str, _name: &str, _value: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn get(_service: &str, _name: &str) -> Result<Option<String>, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn delete(_service: &str, _name: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub fn secret_set(app: tauri::AppHandle, name: String, value: String) -> Result<(), String> {
    check_name(&name)?;
    backend::set(credential_service(&app.config().identifier)?, &name, &value)
}

#[tauri::command]
pub fn secret_get(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    check_name(&name)?;
    backend::get(credential_service(&app.config().identifier)?, &name)
}

#[tauri::command]
pub fn secret_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    check_name(&name)?;
    backend::delete(credential_service(&app.config().identifier)?, &name)
}

/// 从进程环境读 API Key（仅供开发期使用）。
/// 只允许 `SOMETHING_API_KEY` 形状的名字，webview 无法借此枚举任意环境变量。
#[tauri::command]
pub fn read_env_api_key(name: String) -> Result<Option<String>, String> {
    let ok = name.len() <= 64
        && name.ends_with("_API_KEY")
        && name
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if !ok {
        return Err("env name not allowed".into());
    }
    Ok(std::env::var(&name).ok().filter(|v| !v.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::credential_service;

    #[test]
    fn test_bundle_credentials_are_isolated_from_production() {
        // TEST namespace fixture; no actual keychain credentials are read or written.
        let production: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let production_id = production["identifier"].as_str().unwrap();
        assert_eq!(
            credential_service(production_id).unwrap(),
            "com.thewater.desktop"
        );
        let test_id = "com.thewater.finalacceptance20261008";
        assert_eq!(credential_service(test_id).unwrap(), test_id);
        assert_ne!(
            credential_service(test_id).unwrap(),
            credential_service(production_id).unwrap()
        );
    }

    #[test]
    fn missing_identifier_never_falls_back_to_production() {
        assert_eq!(
            credential_service("").unwrap_err(),
            "missing application identifier for credential storage"
        );
    }
}
