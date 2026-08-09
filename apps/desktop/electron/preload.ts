import { contextBridge, ipcRenderer } from 'electron';
import { createGw2ccClient } from '@gw2cc/protocol';

const client = createGw2ccClient({
  invoke: (request) => ipcRenderer.invoke('gw2cc:request', request) as Promise<unknown>,
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on('gw2cc:event', handler);
    return () => ipcRenderer.removeListener('gw2cc:event', handler);
  }
});

contextBridge.exposeInMainWorld('gw2cc', {
  request: client.request.bind(client),
  subscribe: client.subscribe.bind(client)
});
