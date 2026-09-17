#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else Path.cwd()
failures = 0


def check(label: str, ok: bool) -> None:
    global failures
    print(f"{'PASS' if ok else 'FAIL'}: {label}")
    if not ok:
        failures += 1


def read(relative: str) -> str:
    path = ROOT / relative
    return path.read_text(encoding='utf-8') if path.is_file() else ''


history = read('src-tauri/src/run_history.rs')
commands = read('src-tauri/src/agent_commands.rs')
lib = read('src-tauri/src/lib.rs')
client = read('src/agent-client.ts')
settings_ui = read('src/settings-ui.ts')
styles = read('src/styles.css')
core = read('src-tauri/src/agent_core.rs')

check('run history backend module exists', bool(history))
check('agent_runs SQLite table exists', 'CREATE TABLE IF NOT EXISTS agent_runs' in history)
check('run history is bounded', 'MAX_RUN_RECORDS' in history and 'DELETE FROM agent_runs' in history)
check('technical error detail is bounded', 'MAX_ERROR_DETAIL_CHARS' in history)
check('run start is recorded', 'record_run_start' in commands)
check('run finish is recorded', 'record_run_finish' in commands)
check('success/failure/cancel statuses recorded', all(token in commands for token in ['RunStatus::Completed', 'RunStatus::Failed', 'RunStatus::Cancelled']))
check('selected model is recorded', 'settings.agent_model(agent)' in commands)
check('list_agent_runs command exists', 'pub fn list_agent_runs' in commands)
check('Tauri handler exposes list_agent_runs', 'list_agent_runs' in lib)
check('run history import is top-level Rust syntax', 'use agent_commands::{\nuse agent_commands::list_agent_runs;' not in lib)
check('frontend AgentRunRecord bridge exists', 'export type AgentRunRecord' in client and 'getAgentRuns' in client)
check('settings UI renders recent Agent runs', '최근 Agent 실행' in settings_ui and 'ai-agent-run-history' in settings_ui)
check('run history styles exist', 'AI-Character Agent run history' in styles)
check('legacy args_for_with_extra dead wrapper removed', 'pub fn args_for_with_extra(' not in core)

print(f"\nRESULT: {'PASS' if failures == 0 else 'FAIL'}" + (f" ({failures} checks failed)" if failures else ''))
raise SystemExit(1 if failures else 0)
