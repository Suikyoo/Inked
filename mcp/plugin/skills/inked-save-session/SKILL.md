---
name: inked-save-session
description: Use when the user asks to save, note down or log what happened in the current conversation to Inked, such as decisions, findings, gotchas or open TODOs from a work session.
---

# Saving a session to Inked

The user wants the useful part of this conversation in their Inked vault, where they will find it again later. Write it as lasting notes, not as a transcript.

Load `inked-note-style` first and follow it. If the inked tools are missing, use `inked-setup`.

## 1. Pick what is worth keeping

Keep:
- decisions, each with its reason and the alternatives that were rejected;
- findings: how something works, what caused a bug, measurements;
- gotchas: what surprised you or would trip someone up next time;
- open TODOs and questions, phrased so they make sense without this chat.

Drop:
- back-and-forth, false starts and debugging steps that led nowhere;
- anything that only mattered during this session;
- secrets, tokens, credentials and personal data.

If nothing is worth saving, say so instead of writing a thin note.

## 2. Find where it goes

1. `list_vaults`, then `get_tree` for the likely vault.
2. Choose the vault and folder from what exists. If it is unclear, ask the user once, offering the two or three likeliest places.
3. For each topic, `search` for an existing note.

## 3. Write

- An existing note on the topic: `append_to_note` with a section headed `## <YYYY-MM-DD>: <short context>`, for example `## 2026-10-13: Auth refactor`.
- No note yet: `create_note` in the chosen folder, linking related notes with `[[Exact Title]]`.
- Several new notes in one folder: `create_notes` in one batch.
- When a note is about code, name the repository and use repository-relative paths.

## 4. Check with the user when it is big

- Up to three notes: write them directly.
- More than three: show the planned titles, the vault and folder, and whether each note is new or appended, then wait for an OK.

## 5. Report

List the titles you created or appended to, with their folders, in a few lines. Do not repeat the content.
