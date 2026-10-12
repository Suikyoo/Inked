import { Link, useParams } from 'react-router-dom';
import { useAppState } from '../state/StoreContext';
import { HomePage } from './HomePage';
import { NotePane } from './NotePane';

export function VaultPage() {
  const { vaultId = '', noteId } = useParams();
  const state = useAppState();
  const vault = state.vaults[vaultId];

  // Home and every vault render the same HomePage here, so switching between them keeps the map mounted.
  if (!vaultId) return <HomePage />;
  if (!vault) {
    if (state.vaultsStatus !== 'ready') {
      return <div className="doc-loading">Decrypting vaults…</div>;
    }
    return (
      <div className="doc-empty">
        <p>This vault doesn’t exist, or it isn’t yours.</p>
        <Link to="/">Go home</Link>
      </div>
    );
  }
  if (vault.broken) {
    return (
      <div className="doc-empty">
        <p>This vault couldn’t be decrypted with your keys.</p>
        <Link to="/">Go home</Link>
      </div>
    );
  }
  if (noteId) return <NotePane key={noteId} vault={vault} noteId={noteId} />;
  // A vault opens Home with the map framed on it and its hub in the preview.
  return <HomePage focusVault={vaultId} />;
}
