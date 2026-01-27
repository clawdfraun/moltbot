# feat: Non-image file attachment support for webchat

Closes #2109

## Summary

Extends the existing image paste/drag-drop feature (PR #1925) to support arbitrary file uploads (PDF, text, markdown, CSV, JSON, etc.) in the webchat UI.

## Changes

### Backend (`src/gateway/chat-attachments.ts`)
- **Instead of dropping non-image attachments**, saves them to `media/inbound/` in the agent workspace with unique prefixed filenames
- New `SavedFileAttachment` type with `filePath`, `fileName`, `mimeType`, `sizeBytes`
- `ParsedMessageWithImages` now includes a `files` array
- `parseMessageWithAttachments` accepts optional `workspacePath` parameter
- File references are appended to the message text so the agent knows about attached files:
  ```
  [Attached file: report.pdf (application/pdf, 24567 bytes) → /path/to/media/inbound/abc12345-report.pdf]
  ```

### Backend (`src/gateway/server-methods/chat.ts`)
- Imports `resolveAgentWorkspaceDir` and resolves workspace path before attachment parsing
- Moved `loadSessionEntry` call before attachment parsing (was after)
- Passes `workspacePath` to `parseMessageWithAttachments`

### UI (`ui/src/ui/views/chat.ts`)
- **Paperclip attach button** in compose area (uses existing `icons.paperclip`)
- **File picker** opens on button click, accepts all file types, multiple selection
- **Drag-and-drop** support for any file onto compose area
- **Paste handler** extended to accept non-image files
- **File preview** shows paperclip icon + filename (not image thumbnail) for non-image attachments
- Refactored `readFileAsAttachment` helper for shared file reading logic

### UI (`ui/src/ui/ui-types.ts`)
- `ChatAttachment` extended with optional `fileName` and `isFile` fields

### UI (`ui/src/ui/controllers/chat.ts`)
- API attachment serialization includes `fileName` and uses `type: "file"` for non-image attachments

### CSS (`ui/src/styles/chat/layout.css`)
- `.chat-attachment--file` variant styles
- `.chat-attachment__file-info`, `__file-icon`, `__file-name` styles
- `.chat-compose__attach` button styles

## How to test

1. Build: `pnpm install && pnpm ui:build && pnpm build`
2. Start gateway: `pnpm gateway:watch`
3. Open webchat UI
4. Test file upload via:
   - Click paperclip button → select files
   - Drag-and-drop files onto compose area
   - Paste files from clipboard
5. Verify:
   - Image files still show as image thumbnails
   - Non-image files show with paperclip icon + filename
   - Sending a message with file attachments saves files to `media/inbound/`
   - Agent receives message with file path references
   - Remove button works on both image and file attachments

## Files modified

- `src/gateway/chat-attachments.ts`
- `src/gateway/server-methods/chat.ts`
- `ui/src/ui/views/chat.ts`
- `ui/src/ui/controllers/chat.ts`
- `ui/src/ui/ui-types.ts`
- `ui/src/styles/chat/layout.css`
