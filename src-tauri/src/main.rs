// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = ai_character_lib::run_cli_hook() {
        std::process::exit(code);
    }
    ai_character_lib::run()
}
