; Custom NSIS cleanup for the installed launcher.  The prompt is deliberate:
; users may keep their encrypted configuration and installed Skills when
; removing only the program files.  Silent uninstall is the KEEP-DATA path so
; automated lifecycle checks never make an irreversible data choice.
!macro harnessRemoveLongPathPayload
  ; The archive extractor supports long dependency paths, but NSIS 3.04's
  ; plain RMDir does not. Use the native extended path form only for the
  ; bundled runtime tree; the builder retains ownership of the install root.
  Push $R0
  Push $R1
  StrCpy $R0 "$INSTDIR\resources\harness"
  ; Add the prefix to drive-letter paths. Preserve UNC and already-prefixed
  ; paths so this does not change their existing NSIS interpretation.
  StrCpy $R1 $INSTDIR 1 1
  ${If} $R1 == ":"
    StrCpy $R0 "\\?\$R0"
  ${EndIf}
  RMDir /r "$R0"
  Pop $R1
  Pop $R0
!macroend

!macro customDeleteAppData
  ; Electron may use any of these names for app.getPath("userData") depending
  ; on the product/package metadata.  Keep the list in sync with the builder
  ; template instead of hard-coding a developer machine directory.
  RMDir /r "$APPDATA\${APP_FILENAME}"
  !ifdef APP_PRODUCT_FILENAME
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
  !endif
  !ifdef APP_PACKAGE_NAME
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
  !endif
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "ChatGPT Web Harness.exe"'
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "tunnel-client.exe"'
  IfSilent keep_data
  MessageBox MB_YESNO|MB_ICONQUESTION "同时删除配置、日志和已安装 Skill？\r\n\r\n这会删除当前用户的 ChatGPT Web Harness 配置目录。" IDYES delete_data
  Goto keep_data
delete_data:
  !insertmacro customDeleteAppData
keep_data:
  ; Upgrade removal must retain electron-builder's atomic move/restore path.
  ${IfNot} ${isUpdated}
    !insertmacro harnessRemoveLongPathPayload
  ${EndIf}
!macroend
