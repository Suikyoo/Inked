// Openboard DTOs: published (plaintext) content shared through secret links.
// server/src/openboard/types.ts is a server-owned copy of this file; keep the two identical.

export interface ObVault { id: string; name: string; color: string; updatedAt: string }
export interface ObFolder { id: string; vaultId: string; parentId: string | null; name: string }
export interface ObNote { id: string; vaultId: string; folderId: string | null; title: string; body: string; createdAt: string; updatedAt: string }
export interface ObPayload { vaults: ObVault[]; folders: ObFolder[]; notes: ObNote[] }
export interface PublishRequest {
  kind: 'vault' | 'folder' | 'note';
  vaultName: string; color: string;
  destPath: string[];                       // folder names under the vault; [] = vault root. Ignored for kind 'vault'.
  rootName: string;                         // vault name for 'vault', folder name for 'folder', note title for 'note'
  folders: { key: string; parentKey: string | null; name: string }[];  // subtree below the root; empty for note
  notes: { folderKey: string | null; title: string; body: string }[];  // folderKey null = directly in the root
  overwrite: boolean;
}
export interface PublishResult { vaultId: string; imageRefs: string[] }   // image ids referenced by published bodies
export interface PublishConflict { error: 'conflict'; target: { kind: 'vault'|'folder'|'note'; name: string; path: string[] }; removes: { folders: number; notes: number } }
