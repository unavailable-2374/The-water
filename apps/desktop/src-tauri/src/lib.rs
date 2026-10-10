mod secrets;
mod account_session;
mod atomic;
mod backup;

use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// 单个日志文件的上限，超过就轮转。
const LOG_MAX_FILE_SIZE: u128 = 2 * 1024 * 1024;
/// 保留多少个历史日志文件（不含当前这个）。够覆盖几次会话，又不至于占满磁盘。
const LOG_KEEP_FILES: usize = 5;

/// 日志插件：写到系统日志目录（macOS 是 ~/Library/Logs/com.thewater.desktop），
/// 按大小轮转、只留最近几份；开发态额外打到 stdout。
/// 「导出诊断包」直接打包这个目录里的文件。
fn log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir { file_name: Some("the-water".into()) }))
        .rotation_strategy(RotationStrategy::KeepSome(LOG_KEEP_FILES))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .max_file_size(LOG_MAX_FILE_SIZE)
        .level(tauri_plugin_log::log::LevelFilter::Info);
    if cfg!(debug_assertions) {
        builder = builder.target(Target::new(TargetKind::Stdout));
    }
    builder.build()
}

/// 把主窗口从隐藏 / 最小化状态拉回前台。
/// 单实例回调与 macOS 的 Dock 点击都走它。
fn focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub const DB_URL: &str = "sqlite:the-water.db";

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "init",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "writing_framework",
            sql: include_str!("../migrations/0002_writing_framework.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "community",
            sql: include_str!("../migrations/0003_community.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "provider_runtime",
            sql: include_str!("../migrations/0004_provider_runtime.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "soft_delete",
            sql: include_str!("../migrations/0005_soft_delete.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "reader_fts",
            sql: include_str!("../migrations/0006_reader_fts.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "usage_pricing",
            sql: include_str!("../migrations/0007_usage_pricing.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "pending_versions",
            sql: include_str!("../migrations/0008_pending_versions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "writing_workbench",
            sql: include_str!("../migrations/0009_writing_workbench.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "reasoning_effort",
            sql: include_str!("../migrations/0010_reasoning_effort.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "story_graph",
            sql: include_str!("../migrations/0011_story_graph.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "unified_assistant",
            sql: include_str!("../migrations/0012_assistant.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "story_options",
            sql: include_str!("../migrations/0013_story_options.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // 单实例保护必须最先注册：第二个实例一启动就把已有窗口唤到前台然后自己退出，
    // 否则两个进程会同时写同一个 SQLite 文件。
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                focus_main_window(app);
            }))
            // 记住窗口位置 / 尺寸 / 最大化状态，下次启动照原样恢复。
            .plugin(tauri_plugin_window_state::Builder::default().build())
            // 自动更新：端点与签名公钥在 tauri.conf.json 的 plugins.updater 里。
            .plugin(tauri_plugin_updater::Builder::new().build())
            // 装完更新要重启，重启走 process 插件。
            .plugin(tauri_plugin_process::init());
    }

    let app = builder
        .plugin(log_plugin())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DB_URL, migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            account_session::account_session_read,
            account_session::account_session_write,
            account_session::account_session_delete,
            atomic::db_atomic,
            backup::db_validate_backup,
            backup::db_install_backup,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            secrets::read_env_api_key
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // macOS：窗口被「关到 Dock」（有任务在跑时的行为）之后点 Dock 图标要能回来
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            focus_main_window(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
