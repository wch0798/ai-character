# 2026-09-15 modification notes

Implemented directly in the uploaded AI-Character source tree.

## Chat history / management
- Persistent browser-local chat history across app restarts.
- New chat.
- Conversation list.
- Restore last active conversation.
- Search by conversation title/message text.
- Automatic title from the first user message.
- Rename conversation.
- Delete one conversation with confirmation.
- Delete all chat history with confirmation.
- Reload stored messages when reopening a conversation.
- Reuse up to the latest 40 stored messages as Claude context for the next request.

## Compile fix
- Fixed nullable `modelYBeforeChat` flow in `src/main.ts` by narrowing it before passing it to `getModelYFromBounds`.

## Added files
- `src/chat-history.ts`
- `src/chat-history-ui.ts`
- `src/tests/chat-history.test.ts`

## Verification performed in this environment
- `src/chat-history.ts` + `src/chat-history-ui.ts`: strict TypeScript check passed.
- Full project TypeScript syntax/no-check pass completed.
- Chat history runtime smoke test passed for create, append, context, search, rename, delete-one, delete-all.

Full `npm test`, `npm run build`, and Rust `cargo test/check` could not be executed here because the uploaded archive intentionally excluded `node_modules`, npm dependency retrieval is unavailable in this environment, and Rust/Cargo is not installed in this container. Run those commands on the Mac after replacing/extracting the source.
