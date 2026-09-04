//! API Key / 账号 token 的存储。
//!
//! v1 只发 macOS：密钥后端就是系统钥匙串（keyring 的 apple-native）。
//! 其它平台不链接 keyring，一律返回明确错误，绝不退化成明文存储 —— 与
//! `Cargo.toml` 里的平台条件依赖是同一个决定，详见 docs/RELEASE.md。

#[allow(dead_code)] // 非 macOS 构建不链接 keyring，这个常量用不到
const SERVICE: &str = "com.thewater.desktop";

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

    fn entry(name: &str) -> Result<Entry, String> {
        Entry::new(super::SERVICE, name).map_err(|e| e.to_string())
    }

    pub fn set(name: &str, value: &str) -> Result<(), String> {
        entry(name)?.set_password(value).map_err(|e| e.to_string())
    }

    pub fn get(name: &str) -> Result<Option<String>, String> {
        match entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(name: &str) -> Result<(), String> {
        match entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod backend {
    const UNSUPPORTED: &str =
        "当前平台还没有密钥存储后端：The Water v1 只发布 macOS 版本。Windows / Linux 需要先接上对应的凭据后端（见 docs/RELEASE.md）。";

    pub fn set(_name: &str, _value: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn get(_name: &str) -> Result<Option<String>, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn delete(_name: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    check_name(&name)?;
    backend::set(&name, &value)
}

#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    check_name(&name)?;
    backend::get(&name)
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    check_name(&name)?;
    backend::delete(&name)
}

/// 从进程环境读 API Key（仅供开发期使用）。
/// 只允许 `SOMETHING_API_KEY` 形状的名字，webview 无法借此枚举任意环境变量。
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
