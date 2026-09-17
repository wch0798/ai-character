; Windows NSIS post-install hooks for AI Character
; Installs Git + Node via winget when available (silent best-effort).

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing Git and Node.js if missing (winget)..."
  nsExec::ExecToLog 'cmd /C where winget >nul 2>&1 && winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements --disable-interactivity'
  nsExec::ExecToLog 'cmd /C where winget >nul 2>&1 && winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements --disable-interactivity'
!macroend
