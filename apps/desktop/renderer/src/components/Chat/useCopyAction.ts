import { useCallback, useState } from 'react';
import type { MessageAction } from './MessageActions';

export function useCopyAction(text: string): MessageAction {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(() => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }).catch(() => {});
  }, [text]);
  return { key: 'copy', label: copied ? 'Copied' : 'Copy', icon: copied ? 'check' : 'copy', onClick };
}
