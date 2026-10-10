//! Optional cloud-session persistence. Passwords and provider keys never enter this file.
//! Unlike the provider Keychain backend, this store is used only after explicit opt-in.
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("account-session"))
}

fn check_directory(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Session directory must not be a symbolic link".into());
    }
    Ok(())
}

fn read_token(dir: &Path) -> Result<Option<String>, String> {
    check_directory(dir)?;
    let path = dir.join("token");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !metadata.is_file() || metadata.len() > 8192 {
        return Err("Invalid session credential file".into());
    }
    let mut token = String::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(8193)
        .read_to_string(&mut token)
        .map_err(|e| e.to_string())?;
    if token.is_empty() || token.len() > 8192 {
        return Err("Invalid session credential".into());
    }
    Ok(Some(token))
}

fn write_token(dir: &Path, token: &str) -> Result<(), String> {
    if token.is_empty() || token.len() > 8192 {
        return Err("Invalid session credential".into());
    }
    check_directory(dir)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temp = dir.join(format!("token-{}-{nonce}.tmp", std::process::id()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|e| e.to_string())?;
        file.write_all(token.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temp, dir.join("token")).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn delete_token(dir: &Path) -> Result<(), String> {
    check_directory(dir)?;
    match fs::remove_file(dir.join("token")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn account_session_read(app: tauri::AppHandle) -> Result<Option<String>, String> {
    read_token(&directory(&app)?)
}
#[tauri::command]
pub fn account_session_write(app: tauri::AppHandle, token: String) -> Result<(), String> {
    write_token(&directory(&app)?, &token)
}
#[tauri::command]
pub fn account_session_delete(app: tauri::AppHandle) -> Result<(), String> {
    delete_token(&directory(&app)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_invalid_credentials_are_rejected_without_creating_files() {
        let dir = std::env::temp_dir().join(format!(
            "the-water-TEST-invalid-session-{}",
            std::process::id()
        ));
        assert!(write_token(&dir, "").is_err());
        assert!(write_token(&dir, &"X".repeat(8193)).is_err());
        assert!(!dir.exists());
    }
    #[cfg(unix)]
    #[test]
    fn test_symlinks_cannot_redirect_session_storage() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "the-water-TEST-symlink-session-{}",
            std::process::id()
        ));
        let actual = root.join("actual");
        let linked = root.join("linked");
        fs::create_dir_all(&actual).unwrap();
        symlink(&actual, &linked).unwrap();
        assert!(write_token(&linked, "TEST-token").is_err());
        assert!(read_token(&linked).is_err());
        assert!(delete_token(&linked).is_err());
        let target = root.join("TEST-target");
        fs::write(&target, "TEST-protected").unwrap();
        symlink(&target, actual.join("token")).unwrap();
        assert!(read_token(&actual).is_err());
        write_token(&actual, "TEST-session").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "TEST-protected");
        assert_eq!(
            read_token(&actual).unwrap().as_deref(),
            Some("TEST-session")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn test_session_file_lifecycle_and_private_permissions() {
        let dir =
            std::env::temp_dir().join(format!("the-water-TEST-session-{}", std::process::id()));
        assert_eq!(read_token(&dir).unwrap(), None);
        write_token(&dir, "TEST-session-token").unwrap();
        assert_eq!(
            read_token(&dir).unwrap().as_deref(),
            Some("TEST-session-token")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(dir.join("token"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        write_token(&dir, "TEST-replacement-token").unwrap();
        assert_eq!(
            read_token(&dir).unwrap().as_deref(),
            Some("TEST-replacement-token")
        );
        delete_token(&dir).unwrap();
        delete_token(&dir).unwrap();
        assert_eq!(read_token(&dir).unwrap(), None);
        fs::remove_dir(dir).unwrap();
    }
}
