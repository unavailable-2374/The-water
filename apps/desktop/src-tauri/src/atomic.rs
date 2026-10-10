use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri_plugin_sql::{DbInstances, DbPool};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    sql: String,
    #[serde(default)]
    params: Vec<Value>,
    expected_rows: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultRow {
    rows_affected: u64,
    last_insert_id: i64,
}

/// Use the SQL plugin's existing pool; BEGIN/COMMIT via separate IPC calls is unsafe.
#[tauri::command]
pub async fn db_atomic(
    databases: tauri::State<'_, DbInstances>,
    operations: Vec<Operation>,
) -> Result<Vec<ResultRow>, String> {
    let instances = databases.0.read().await;
    let Some(DbPool::Sqlite(pool)) = instances.get(crate::DB_URL) else {
        return Err("Database is not open".into());
    };
    execute_atomic(pool, operations).await
}

async fn execute_atomic(pool: &sqlx::SqlitePool, operations: Vec<Operation>) -> Result<Vec<ResultRow>, String> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(|e| e.to_string())?;
    let mut results = Vec::with_capacity(operations.len());
    for operation in operations {
        let mut q = sqlx::query(&operation.sql);
        for value in operation.params {
            q = match value {
                Value::Null => q.bind(None::<String>),
                Value::String(s) => q.bind(s),
                Value::Number(n) if n.is_i64() => q.bind(n.as_i64().unwrap()),
                Value::Number(n) => q.bind(n.as_f64().ok_or("Invalid number")?),
                Value::Bool(b) => q.bind(b),
                _ => return Err("Atomic parameters must be scalar JSON values".into()),
            };
        }
        let result = q.execute(&mut *tx).await.map_err(|e| e.to_string())?;
        if operation.expected_rows.is_some_and(|n| n != result.rows_affected()) {
            tx.rollback().await.map_err(|e| e.to_string())?;
            return Err("Concurrent modification: atomic precondition failed".into());
        }
        results.push(ResultRow { rows_affected: result.rows_affected(), last_insert_id: result.last_insert_rowid() });
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_same_pool_commit_and_rollback() {
        tauri::async_runtime::block_on(async {
            let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
            sqlx::query("CREATE TABLE test_records(id INTEGER PRIMARY KEY, value TEXT)").execute(&pool).await.unwrap();
            let op = |sql: &str, rows| Operation { sql: sql.into(), params:vec![], expected_rows:rows };
            execute_atomic(&pool,vec![op("INSERT INTO test_records VALUES (1,'TEST committed')",Some(1))]).await.unwrap();
            let failure = execute_atomic(&pool,vec![op("UPDATE test_records SET value='TEST must rollback' WHERE id=1",Some(1)),op("UPDATE test_records SET value='TEST absent' WHERE id=2",Some(1))]).await;
            assert!(matches!(failure,Err(ref error) if error=="Concurrent modification: atomic precondition failed"));
            let value:String = sqlx::query_scalar("SELECT value FROM test_records WHERE id=1").fetch_one(&pool).await.unwrap();
            assert_eq!(value,"TEST committed");
            assert!(execute_atomic(&pool,vec![op("INSERT INTO test_records VALUES (2,'TEST rolled back')",None),op("INVALID TEST SQL",None)]).await.is_err());
            let count:i64 = sqlx::query_scalar("SELECT COUNT(*) FROM test_records").fetch_one(&pool).await.unwrap();
            assert_eq!(count,1);
            pool.close().await;
        });
    }
}
