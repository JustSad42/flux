; Flux installer hooks.
; "Open with" support only: registers Flux as an application that can open these types. It never changes anyone's default player
; and never touches other programs' entries (the stock file-association feature rewrote defaults and deleted OpenWithProgids lists).
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe" "FriendlyAppName" "Flux"
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\DefaultIcon" "" "$INSTDIR\flux.exe,0"
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\shell\open\command" "" '"$INSTDIR\flux.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".mkv" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".mp4" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".avi" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".mov" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".wmv" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".webm" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".m4v" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".ts" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".m2ts" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".mpg" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".mpeg" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".flv" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".mp3" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".flac" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".wav" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".ogg" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".opus" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".m4a" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".aac" ""
  WriteRegStr HKCU "Software\Classes\Applications\flux.exe\SupportedTypes" ".wma" ""
  ; right-click a folder (or the empty space inside one) -> "Play with Flux" plays the whole folder
  WriteRegStr HKCU "Software\Classes\Directory\shell\Flux" "" "Play with Flux"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Flux" "Icon" "$INSTDIR\flux.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Flux\command" "" '"$INSTDIR\flux.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Flux" "" "Play with Flux"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Flux" "Icon" "$INSTDIR\flux.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Flux\command" "" '"$INSTDIR\flux.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; "Start with Windows" (the app writes it back on its next start if the setting is on, e.g. after an update)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Flux"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Flux"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Flux"
  DeleteRegKey HKCU "Software\Classes\Applications\flux.exe"
  DeleteRegKey HKCU "Software\Flux"
!macroend
