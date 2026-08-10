import { describe, expect, it } from 'vitest';
import type { ContextMenuParams } from 'electron';
import { createContextMenuTemplate } from './context-menu';

const allEditFlags: ContextMenuParams['editFlags'] = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: false
};

describe('desktop context menu', () => {
  it('offers standard text editing actions for the chat composer', () => {
    const template = createContextMenuTemplate({
      editFlags: { ...allEditFlags, canUndo: false, canCut: false },
      isEditable: true,
      selectionText: ''
    });

    expect(template).toEqual([
      { role: 'undo', enabled: false },
      { role: 'redo', enabled: true },
      { type: 'separator' },
      { role: 'cut', enabled: false },
      { role: 'copy', enabled: true },
      { role: 'paste', enabled: true },
      { type: 'separator' },
      { role: 'selectAll', enabled: true }
    ]);
  });

  it('offers copy for selected assistant output without editable actions', () => {
    const template = createContextMenuTemplate({
      editFlags: allEditFlags,
      isEditable: false,
      selectionText: 'Selected assistant text'
    });

    expect(template).toEqual([
      { role: 'copy', enabled: true },
      { type: 'separator' },
      { role: 'selectAll' }
    ]);
  });

  it('does not open a menu when no text action is available', () => {
    const template = createContextMenuTemplate({
      editFlags: {
        ...allEditFlags,
        canCopy: false,
        canSelectAll: false
      },
      isEditable: false,
      selectionText: ''
    });

    expect(template).toEqual([]);
  });
});
