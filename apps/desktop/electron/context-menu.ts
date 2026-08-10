import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';

type ContextMenuState = Pick<ContextMenuParams, 'editFlags' | 'isEditable' | 'selectionText'>;

export function createContextMenuTemplate({
  editFlags,
  isEditable,
  selectionText
}: ContextMenuState): MenuItemConstructorOptions[] {
  if (isEditable) {
    return [
      { role: 'undo', enabled: editFlags.canUndo },
      { role: 'redo', enabled: editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags.canSelectAll }
    ];
  }

  const template: MenuItemConstructorOptions[] = [];
  if (selectionText.length > 0) template.push({ role: 'copy', enabled: editFlags.canCopy });
  if (editFlags.canSelectAll) {
    if (template.length > 0) template.push({ type: 'separator' });
    template.push({ role: 'selectAll' });
  }
  return template;
}

export function installContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const template = createContextMenuTemplate(params);
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window });
  });
}
