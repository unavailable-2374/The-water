use sqlx::Connection;
use tauri::Manager;
use tauri_plugin_sql::{DbInstances, DbPool};
use std::path::Path;

/// Validate the actual database, not a table-name substring in its file header.
#[tauri::command]
pub async fn db_validate_backup(path: String) -> Result<i64, String> {
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).read_only(true);
    let mut connection = sqlx::SqliteConnection::connect_with(&options).await.map_err(|e| e.to_string())?;
    let result = validate(&mut connection).await;
    connection.close().await.map_err(|e| e.to_string())?;
    result
}

/// Close the existing pool under its exclusive registry lock. Loading a new pool
/// just to close it leaves the old pool's WAL cleanup racing with replacement.
#[tauri::command]
pub async fn db_install_backup(app: tauri::AppHandle, databases: tauri::State<'_, DbInstances>, staged: String) -> Result<(), String> {
    if !staged.starts_with("the-water.db.restore-staged-") || staged.contains('/') || staged.contains('\\') || staged.contains("..") { return Err("Invalid staged backup name".into()); }
    let directory=app.path().app_data_dir().map_err(|e|e.to_string())?;
    let source=directory.join(staged);
    let target=directory.join("the-water.db");
    let mut instances=databases.0.write().await;
    let Some(DbPool::Sqlite(pool))=instances.remove(crate::DB_URL) else { return Err("Database is not open; restart before restoring".into()); };
    pool.close().await;
    install_staged(&source,&target)
}

fn install_staged(source:&Path,target:&Path)->Result<(),String> {
    std::fs::File::open(source).and_then(|f|f.sync_all()).map_err(|e|e.to_string())?;
    for suffix in ["-wal","-shm"] {
        let stale=std::path::PathBuf::from(format!("{}{suffix}",target.display()));
        match std::fs::remove_file(stale) {
            Ok(())=>(),
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>(),
            Err(error)=>return Err(error.to_string()),
        }
    }
    std::fs::rename(source,target).map_err(|e|e.to_string())
}

async fn validate(connection: &mut sqlx::SqliteConnection) -> Result<i64, String> {
    let integrity: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check").fetch_all(&mut *connection).await.map_err(|e| e.to_string())?;
    if integrity != ["ok"] { return Err(format!("Backup integrity check failed: {}", integrity.join("; "))); }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('novels','documents','chapters')").fetch_one(&mut *connection).await.map_err(|e| e.to_string())?;
    if count != 3 { return Err("Backup is missing required application tables".into()); }
    if sqlx::query("PRAGMA foreign_key_check").fetch_optional(&mut *connection).await.map_err(|e| e.to_string())?.is_some() { return Err("Backup contains broken foreign keys".into()); }
    let version:i64=sqlx::query_scalar("PRAGMA user_version").fetch_one(&mut *connection).await.map_err(|e| e.to_string())?;
    let supported = crate::migrations().iter().map(|migration| migration.version).max().unwrap_or(0);
    if version > supported { return Err("Backup comes from a newer schema version".into()); }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_restore_accepts_sqlite_removed_sidecars_and_keeps_old_file_on_missing_stage() {
        let directory=std::env::temp_dir().join(format!("TEST-water-restore-{}",std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let source=directory.join("TEST-stage");
        let target=directory.join("TEST-db");
        std::fs::write(&target,b"TEST old").unwrap();
        assert!(install_staged(&source,&target).is_err());
        assert_eq!(std::fs::read(&target).unwrap(),b"TEST old");
        std::fs::write(&source,b"TEST restored").unwrap();
        install_staged(&source,&target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(),b"TEST restored");
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn test_backup_requires_integrity_and_application_schema() {
        tauri::async_runtime::block_on(async {
            let mut connection=sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
            assert!(validate(&mut connection).await.is_err());
            sqlx::raw_sql("CREATE TABLE novels(id TEXT PRIMARY KEY); CREATE TABLE documents(id TEXT); CREATE TABLE chapters(id TEXT); PRAGMA user_version=10;").execute(&mut connection).await.unwrap();
            assert_eq!(validate(&mut connection).await.unwrap(),10);
            let future = crate::migrations().iter().map(|migration| migration.version).max().unwrap() + 1;
            sqlx::query(&format!("PRAGMA user_version={future}")).execute(&mut connection).await.unwrap();
            assert!(validate(&mut connection).await.is_err());
            connection.close().await.unwrap();
        });
    }
}
