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

workspace = read('src-tauri/src/workspace_changes.rs')
commands = read('src-tauri/src/agent_commands.rs')
lib = read('src-tauri/src/lib.rs')
client = read('src/agent-client.ts')
settings = read('src/settings-ui.ts')
styles = read('src/styles.css')

check('checkpoint records are exposed', 'pub struct CheckpointRecord' in workspace and 'pub struct RestoreCheckpointResult' in workspace)
check('checkpoint ids are validated', 'fn validate_checkpoint_id' in workspace)
check('checkpoint manifests are validated', 'fn parse_checkpoint_manifest' in workspace and 'validate_relative_path' in workspace)
check('checkpoint listing exists', 'pub fn list_checkpoints' in workspace)
check('restore creates a safety checkpoint first', 'fn create_safety_checkpoint' in workspace and 'safety_checkpoint_id' in workspace)
check('restore rolls back from safety checkpoint on failure', 'restore_entries_from_checkpoint(project_root, &safety_root' in workspace)
check('checkpoint Tauri commands exist', 'pub fn list_checkpoints' in commands and 'pub fn restore_checkpoint' in commands)
check('Tauri handler exposes checkpoint commands', 'list_checkpoints' in lib and 'restore_checkpoint' in lib)
check('checkpoint imports are top-level Rust syntax', 'use agent_commands::{\nuse agent_commands::list_checkpoints;' not in lib and 'use agent_commands::{\nuse agent_commands::restore_checkpoint;' not in lib)
check('frontend checkpoint bridge exists', 'export type CheckpointRecord' in client and 'getProjectCheckpoints' in client and 'restoreProjectCheckpoint' in client)
check('settings UI exposes checkpoint restore', '체크포인트 복원' in settings and 'ai-checkpoint-history' in settings and 'restoreProjectCheckpoint' in settings)
check('settings UI warns about safety checkpoint', '안전 체크포인트' in settings)
check('checkpoint styles exist', 'AI-Character checkpoint restore' in styles)

print(f"\nRESULT: {'PASS' if failures == 0 else 'FAIL'}" + (f" ({failures} checks failed)" if failures else ''))
raise SystemExit(1 if failures else 0)
