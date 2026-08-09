type ActionIcon = 'copy' | 'check' | 'retry' | 'edit' | 'fork';

export interface MessageAction {
  key: string;
  label: string;
  icon: ActionIcon;
  onClick(): void;
  disabled?: boolean;
}

function ActionGlyph({ icon }: { icon: ActionIcon }) {
  const paths: Record<ActionIcon, React.ReactNode> = {
    copy: <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M5 13H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" /></>,
    check: <path d="m3 10 4 4L17 4" />,
    retry: <><path d="M4 4v5h5" /><path d="M5.4 15a7 7 0 1 0-.7-7.5L4 9" /></>,
    edit: <><path d="M12.5 3.5 16.5 7.5" /><path d="m4 16 3.5-.8 9-9a1.4 1.4 0 0 0-2-2l-9 9L4 16Z" /></>,
    fork: <><circle cx="5" cy="4" r="2" /><circle cx="15" cy="5" r="2" /><circle cx="10" cy="16" r="2" /><path d="M5 6v2c0 2 2 3 5 3s5-1 5-4" /><path d="M10 11v3" /></>
  };
  return <svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[icon]}</svg>;
}

export function MessageActions({ actions, align }: { actions: MessageAction[]; align: 'left' | 'right' }) {
  return (
    <div className={`message-actions ${align === 'right' ? 'align-right' : ''}`}>
      {actions.map((action) => (
        <button key={action.key} type="button" aria-label={action.label} title={action.label} onClick={action.onClick} disabled={action.disabled}>
          <ActionGlyph icon={action.icon} />
        </button>
      ))}
    </div>
  );
}
