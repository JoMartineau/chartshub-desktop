'use strict';

/** Install native text editing without exposing the clipboard to page scripts. */
function attachEditContextMenu({ contents, ownerWindow, buildMenu, language = () => 'en', isAllowed = () => true }) {
  let disposed = false, generation = 0, activeMenu = null;
  const alive = () => {
    try { return !disposed && !contents.isDestroyed() && !ownerWindow.isDestroyed() && isAllowed() === true; }
    catch { return false; }
  };
  const close = () => {
    generation++;
    const menu = activeMenu; activeMenu = null;
    try { menu?.closePopup(ownerWindow); } catch { /* The native window may already be gone. */ }
  };
  const navigation = (_event, _url, _inPlace, mainFrame) => { if (mainFrame !== false) close(); };
  const contextMenu = (_event, params) => {
    if (!alive() || !params || !params.frame || params.frame !== contents.mainFrame) return;
    const editable = params.isEditable === true, flags = params.editFlags || {};
    if (!editable && !(flags.canCopy === true && typeof params.selectionText === 'string' && params.selectionText.length)) return;
    close();
    const revision = generation, frame = contents.mainFrame;
    const fr = language() === 'fr', t = (french, english) => fr ? french : english;
    const command = (method, flag, french, english) => ({
      label: t(french, english), enabled: flags[flag] === true,
      click: () => {
        if (!alive() || revision !== generation || contents.mainFrame !== frame || flags[flag] !== true) return;
        // In tabbed mode ownerWindow.webContents is the shell, not this field.
        contents[method]();
      }
    });
    const template = editable ? [
      command('undo', 'canUndo', 'Annuler', 'Undo'), command('redo', 'canRedo', 'Rétablir', 'Redo'),
      { type: 'separator' },
      command('cut', 'canCut', 'Couper', 'Cut'), command('copy', 'canCopy', 'Copier', 'Copy'),
      command('paste', 'canPaste', 'Coller', 'Paste'),
      { type: 'separator' }, command('selectAll', 'canSelectAll', 'Tout sélectionner', 'Select all')
    ] : [command('copy', 'canCopy', 'Copier', 'Copy')];
    const menu = buildMenu(template);
    activeMenu = menu;
    try {
      menu.popup({ window: ownerWindow, frame: params.frame, sourceType: params.menuSourceType,
        callback: () => { if (activeMenu === menu) activeMenu = null; } });
    } catch { if (activeMenu === menu) activeMenu = null; }
  };
  const dispose = () => {
    if (disposed) return;
    close(); disposed = true;
    contents.removeListener('context-menu', contextMenu);
    contents.removeListener('did-start-navigation', navigation);
    contents.removeListener('destroyed', dispose);
    ownerWindow.removeListener('closed', dispose);
  };
  contents.on('context-menu', contextMenu);
  contents.on('did-start-navigation', navigation);
  contents.once('destroyed', dispose);
  ownerWindow.once('closed', dispose);
  return dispose;
}

module.exports = { attachEditContextMenu };
