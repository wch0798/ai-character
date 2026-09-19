; Do not spawn winget/cmd during install.
; Runtime/agent install is handled inside the app (hidden console).

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Start menu shortcut is created by Tauri. Add a desktop shortcut too.
  SetOutPath "$INSTDIR"
  CreateShortCut "$DESKTOP\AI Character.lnk" "$INSTDIR\ai-character.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$DESKTOP\AI Character.lnk"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
