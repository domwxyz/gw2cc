import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { createGw2ccApplication, InMemorySecretStore, ResearchService, type Gw2ccApplication } from '@gw2cc/core';
import { FixtureGw2Gateway, Gw2HttpClient, LiveGw2Gateway } from '@gw2cc/gw2';
import {
  AnthropicProvider,
  FixtureLlmProvider,
  OllamaProvider,
  OpenAiCompatibleProvider,
  StaticLlmProviderRegistry
} from '@gw2cc/llm';
import { handleProtocolRequest } from '@gw2cc/protocol';
import { openSqlite, type OpenSqliteResult } from '@gw2cc/storage';
import { CompositeToolExecutor, Gw2ToolExecutor, WebResearchToolExecutor } from '@gw2cc/tools';
import { FixtureResearchGateway, LiveResearchGateway, SafePageFetcher, TavilyClient } from '@gw2cc/web';
import { ElectronSecretStore } from './secret-store';
import { createPinnedWebNetworking, type PinnedWebNetworking } from './pinned-web-fetch';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationId = 'com.gw2cc.desktop';
const fixtureMode = process.env.GW2CC_FIXTURE_MODE === '1';
const e2eUserData = process.env.GW2CC_E2E_USER_DATA;
if (e2eUserData) app.setPath('userData', e2eUserData);
if (process.platform === 'win32') app.setAppUserModelId(applicationId);

let storage: OpenSqliteResult | undefined;
let application: Gw2ccApplication | undefined;
let unsubscribeEvents: (() => void) | undefined;
let pinnedWebNetworking: PinnedWebNetworking | undefined;

async function buildApplication(): Promise<Gw2ccApplication> {
  const databasePath = path.join(app.getPath('userData'), 'gw2cc.db');
  storage = openSqlite(databasePath);
  const gateway = fixtureMode
    ? new FixtureGw2Gateway()
    : new LiveGw2Gateway(new Gw2HttpClient({ fetch: globalThis.fetch }), storage.repositories.cache);
  const secrets = fixtureMode
    ? new InMemorySecretStore('fixture-key', true)
    : new ElectronSecretStore(storage.secretBlobs);
  if (!fixtureMode) pinnedWebNetworking = createPinnedWebNetworking();
  const researchGateway = fixtureMode
    ? new FixtureResearchGateway()
    : new LiveResearchGateway(
        new TavilyClient(globalThis.fetch),
        new SafePageFetcher({
          fetch: pinnedWebNetworking!.fetch,
          resolve: pinnedWebNetworking!.resolve
        })
      );
  const research = new ResearchService(researchGateway, secrets);
  const llmProviders = new StaticLlmProviderRegistry([
    new OpenAiCompatibleProvider('openrouter', globalThis.fetch, 'https://openrouter.ai/api/v1'),
    new OpenAiCompatibleProvider('openai-compatible', globalThis.fetch),
    new AnthropicProvider(globalThis.fetch),
    new OllamaProvider(globalThis.fetch),
    new FixtureLlmProvider()
  ]);
  const tools = new CompositeToolExecutor([
    new Gw2ToolExecutor(gateway, secrets, storage.repositories.account),
    new WebResearchToolExecutor(research)
  ]);
  if (fixtureMode) {
    const currentInstructions = await storage.repositories.settings.get<string>('global-instructions');
    if (currentInstructions === null) {
      await storage.repositories.settings.set(
        'global-instructions',
        'Explain GW2 mechanics clearly, identify assumptions, and keep recommendations practical.'
      );
    }
    const firstLore = await storage.repositories.contexts.getLore('fixture-account-001', 'Aurelia Ward');
    if (!firstLore) {
      await storage.repositories.contexts.setLore(
        'fixture-account-001',
        'Aurelia Ward',
        'Aurelia is a field commander who prefers resilient open-world support builds.'
      );
    }
    const secondLore = await storage.repositories.contexts.getLore('fixture-account-001', 'Sylvari Ranger');
    if (!secondLore) {
      await storage.repositories.contexts.setLore(
        'fixture-account-001',
        'Sylvari Ranger',
        'A wandering scout focused on condition damage and solo exploration.'
      );
    }
  }
  return createGw2ccApplication({
    gw2: gateway,
    repositories: storage.repositories,
    secrets,
    llmProviders,
    tools,
    research
  });
}

function getWindowIconPath(): string | undefined {
  if (process.platform === 'darwin') return undefined;
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app-icons', iconName)
    : path.resolve(currentDirectory, '../../build', iconName);
}

function createWindow(): BrowserWindow {
  const icon = getWindowIconPath();
  const window = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 980,
    minHeight: 720,
    backgroundColor: '#0c1214',
    show: false,
    title: 'GW2CC — Guild Wars 2 Character Console',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(currentDirectory, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(currentDirectory, '../renderer/index.html'));
  }
  return window;
}

app.whenReady().then(async () => {
  application = await buildApplication();
  unsubscribeEvents = application.chat.subscribe((event) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('gw2cc:event', event);
  });
  ipcMain.handle('gw2cc:request', async (_event, request: unknown) => {
    if (!application) throw new Error('GW2CC is not initialized.');
    return handleProtocolRequest(application, request, {
      openExternal: async (url) => {
        await shell.openExternal(url);
      }
    });
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ipcMain.removeHandler('gw2cc:request');
  unsubscribeEvents?.();
  unsubscribeEvents = undefined;
  storage?.close();
  storage = undefined;
  pinnedWebNetworking?.destroy();
  pinnedWebNetworking = undefined;
});
