# Clone Hero error report cleanup

The Companion local library includes **Charts reported by Clone Hero**. Run **Scan Songs** in Clone Hero, then import its `badsongs.txt`. Typical Windows installations create the report in `Documents/Clone Hero`; portable installations use the game's `PlayerData` directory. [Official scanning instructions](https://wiki.clonehero.net/books/clone-hero-manual/page/scanning-songs).

The report also contains warnings for playable charts. ChartsHub preserves those warnings and displays the original reason, severity and report modification time. [Official troubleshooting documentation](https://wiki.clonehero.net/books/clone-hero-manual/page/common-issues).

Supported fatal report sections identify invalid song metadata/name and corrupt or broken `notes.mid` / `notes.chart` files. Unknown error formats remain visible and cannot authorize deletion. The imported report is evidence of Clone Hero's previous scan; ChartsHub does not claim to reproduce Clone Hero's note parser.

Only ordinary leaf song folders or individual `.sng` files within the selected Songs directory can be selected. Shared or nested charts, links, hardlinks, root folders and ChartsHub's data directory are protected. No chart is preselected. Select individual errors, review the native dialog showing full paths and reasons, then send the selected items to the Windows Recycle Bin. Batches contain at most 200 explicit selections; there is no permanent-delete fallback.

ChartsHub hashes every target file during import and again before recycling. A changed report, filesystem identity, content, Songs root or library revision invalidates the operation. A batch stops at its first changed or failed target; earlier confirmed successes are removed from the local index and remaining targets stay in place. Remaining unchanged report entries can be selected in a fresh batch without rescanning. Use **Refresh when finished** for one final library refresh. Run **Scan Songs** in Clone Hero to update its own cache.

Validation uses synthetic directories, mocked file pickers and native dialogs, and a fake bin within the disposable fixture. No test calls the real operating-system bin, an external provider or a real Songs library.
