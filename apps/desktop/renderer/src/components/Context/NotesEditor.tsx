export interface NotesEditorProps {
  id: string;
  title: string;
  eyebrow: string;
  value: string;
  placeholder: string;
  dirty: boolean;
  saving: boolean;
  onChange(value: string): void;
  onSave(): void;
}

export function NotesEditor({
  id,
  title,
  eyebrow,
  value,
  placeholder,
  dirty,
  saving,
  onChange,
  onSave
}: NotesEditorProps) {
  return (
    <section className="notes-card">
      <div className="notes-heading">
        <div><span className="eyebrow">{eyebrow}</span><h3>{title}</h3></div>
        <div className="notes-actions">
          <span className={dirty ? 'notes-dirty' : 'notes-saved'}>{dirty ? '• Unsaved' : '✓ Saved'}</span>
          <button onClick={onSave} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
      <textarea
        id={id}
        aria-label={title}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey) && dirty && !saving) {
            event.preventDefault();
            onSave();
          }
        }}
        placeholder={placeholder}
      />
      <p className="notes-hint">Ctrl/⌘ + S</p>
    </section>
  );
}
