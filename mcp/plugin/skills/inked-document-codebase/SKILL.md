---
name: inked-document-codebase
description: Use when the user asks to document the current repository or codebase in Inked, turning its architecture, modules, data flow and decisions into a linked set of notes.
---

# Documenting a codebase in Inked

Turn the repository in front of you into a set of linked notes the user can browse in Inked's tree and concept map. The goal is understanding: what the parts are, how they connect, and why they are built that way. It is not a copy of the code.

Load `inked-note-style` first and follow it. Build in the order described under "Research builds" in `inked-notes`. If the inked tools are missing, use `inked-setup`.

## 1. Explore, read only

Read in this order, and stop once you understand the shape:
1. README files and any docs folder.
2. Package manifests and build files, for languages, dependencies and entry points.
3. The directory layout, two or three levels deep.
4. Entry points and the main modules' public interfaces.
5. Existing design notes, ADRs or decision records.

Do not open `.env` files, key files or anything that looks like credentials.

## 2. Plan the outline

Propose this structure, adapted to the repository:

- `Overview`: what the project does, who uses it, how to run it.
- `Architecture`: the main parts and how they talk to each other.
- `Modules/<name>`: one note per module or package.
- `Data flow`: how a typical request or job moves through the system.
- `Decisions`: one note per significant design decision, with its reason.
- `Glossary`: one note per domain term that is not obvious.

Each folder gets its `Index` note as a hub. Plan the note titles up front so links can point to them.

## 3. Ask before building

Ask whether to use a new vault or a folder in an existing vault. For a new vault, call `create_vault` with the repository's name; the user confirms it in the browser.

Then show the outline (folders and note titles, with the total count) and wait for an OK. Aim for about 60 notes at most; if the repository needs more, say so and ask before going over.

## 4. Build

1. `create_folder` for each folder, then fill its `Index` note with `append_to_note`.
2. `create_notes`, one folder at a time.
3. A module note holds its purpose in one or two sentences, its key files (repository-relative paths), its public interface, and `[[links]]` to the modules it depends on and the ones that depend on it.
4. Keep code snippets short, and only where they explain something prose cannot.
5. Finish with a linking pass so every note links to at least two others.

## 5. Running it again

If the vault or folder already documents this repository, update instead of duplicating:
1. `search` for each planned title.
2. Existing note: append a `## Changes since <YYYY-MM-DD>` section with what changed.
3. New module or decision: create its note and link it from its folder's `Index`.

## 6. Report

Tell the user how many notes you created or updated, in which vault and folder, and which note to open first (usually `Overview`).
