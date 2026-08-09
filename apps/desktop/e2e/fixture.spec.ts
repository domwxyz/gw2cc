import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

async function launch(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      GW2CC_FIXTURE_MODE: '1',
      GW2CC_E2E_USER_DATA: userData
    }
  });
}

test('fixture-mode desktop workflow performs mixed research and persists character and conversation-console state', async ({ browserName }, testInfo) => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'gw2cc-e2e-'));
  let desktop: ElectronApplication | undefined;
  try {
    desktop = await launch(userData);
    let window = await desktop.firstWindow();
    await expect(window.getByText('Fixture account')).toBeVisible();
    await expect(window.getByRole('combobox', { name: 'Character' })).toHaveValue('Aurelia Ward');
    await expect(window.getByRole('button', { name: /Head: Vigilant Dragon Helm/ })).toBeVisible();
    await expect.poll(() => window.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight
    }))).toEqual({ horizontal: 0, vertical: 0 });
    await expect.poll(() => window.locator('.character-stage').evaluate((element) => ({
      horizontal: element.scrollWidth - element.clientWidth,
      vertical: element.scrollHeight - element.clientHeight
    }))).toEqual({ horizontal: 0, vertical: 0 });

    await window.getByRole('button', { name: /Head: Vigilant Dragon Helm/ }).click();
    await expect(window.getByRole('heading', { name: 'Vigilant Dragon Helm' })).toBeVisible();
    await expect(window.getByText('Calculated baseline')).toBeVisible();

    await window.getByRole('combobox', { name: 'Character' }).selectOption('Sylvari Ranger');
    await expect(window.getByRole('button', { name: /Chest: Canopy Stalker Coat/ })).toBeVisible();
    await expect(window.getByLabel('Character lore & goals')).toHaveValue(/wandering scout/i);

    const loreCard = window.locator('.notes-card').filter({ hasText: 'Character lore & goals' });
    await window.getByLabel('Character lore & goals').fill('Persisted fixture-mode ranger lore.');
    await loreCard.getByRole('button', { name: 'Save' }).click();
    await expect(window.getByLabel('Character lore & goals')).toHaveValue('Persisted fixture-mode ranger lore.');
    await window.screenshot({ path: testInfo.outputPath(`${browserName}-character-workspace.png`), fullPage: true });

    await window.getByRole('tab', { name: 'Console' }).click();
    await expect(window.getByRole('tab', { name: 'Console' })).toHaveAttribute('aria-selected', 'true');
    await expect(window.getByRole('banner').first().getByText('gw2cc', { exact: true })).toBeVisible();
    await expect(window.getByRole('combobox', { name: 'Character' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Settings' })).toBeVisible();
    await window.getByRole('textbox', { name: 'Message', exact: true }).fill('Research what is in my bank and compare it with the Guild Wars 2 Wiki.');
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(window.locator('.tool-card strong').getByText('gw2_get_bank', { exact: true })).toBeVisible();
    await expect(window.locator('.tool-card strong').getByText('gw2_wiki_search', { exact: true })).toBeVisible();
    await expect(window.locator('.tool-card strong').getByText('fetch_url', { exact: true })).toBeVisible();
    await window.locator('.tool-card').first().locator('summary').click();
    await expect(window.locator('.tool-card').first().getByText('Arguments')).toBeVisible();
    const assistantAnswer = window.locator('.message-row-assistant').filter({ hasText: 'fixture-backed live ArenaNet account data' });
    await expect(assistantAnswer).toBeVisible();
    await expect(assistantAnswer).toContainText('untrusted external research');
    await expect.poll(() => window.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight
    }))).toEqual({ horizontal: 0, vertical: 0 });

    const conversationRail = window.getByRole('complementary', { name: 'Conversations' });
    await expect(conversationRail.getByText(/Research what is in my bank/)).toBeVisible();
    await conversationRail.getByRole('button', { name: 'New conversation' }).click();
    const newConversation = conversationRail.locator('.conversation-entry').filter({ hasText: 'New conversation' });
    await newConversation.getByRole('button', { name: 'Rename conversation' }).click();
    await conversationRail.getByLabel('Conversation title').fill('Fractal build lab');
    await conversationRail.getByRole('button', { name: 'Save' }).click();
    const fractalConversation = conversationRail.locator('.conversation-entry').filter({ hasText: 'Fractal build lab' });
    await expect(fractalConversation).toBeVisible();
    await fractalConversation.getByRole('button', { name: 'Pin conversation' }).click();
    await conversationRail.getByLabel('Search conversations').fill('Fractal');
    await expect(conversationRail.getByText('Fractal build lab')).toBeVisible();
    await conversationRail.getByRole('button', { name: 'Clear conversation search' }).click();
    await conversationRail.locator('.conversation-entry').filter({ hasText: /Research what is in my bank/ }).locator('.conversation-select').click();
    await expect(window.getByText(/fixture-backed live ArenaNet account data/)).toBeVisible();
    await expect(window.getByRole('banner').first().getByText('gw2cc', { exact: true })).toBeVisible();
    await expect(window.getByRole('combobox', { name: 'Character' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Settings' })).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath(`${browserName}-conversation-console.png`), fullPage: true });

    await desktop.close();
    desktop = await launch(userData);
    window = await desktop.firstWindow();
    await expect(window.getByRole('combobox', { name: 'Character' })).toHaveValue('Sylvari Ranger');
    await expect(window.getByLabel('Character lore & goals')).toHaveValue('Persisted fixture-mode ranger lore.');
    await window.getByRole('tab', { name: 'Console' }).click();
    await expect(window.getByText('Research what is in my bank and compare it with the Guild Wars 2 Wiki.')).toBeVisible();
    await expect(window.getByText(/fixture-backed live ArenaNet account data/)).toBeVisible();
    await expect(window.locator('.tool-card strong').getByText('gw2_get_bank', { exact: true })).toBeVisible();
    await expect(window.locator('.tool-card strong').getByText('gw2_wiki_search', { exact: true })).toBeVisible();
    await expect(window.locator('.tool-card strong').getByText('fetch_url', { exact: true })).toBeVisible();
    await expect(window.getByRole('complementary', { name: 'Conversations' }).getByText('Fractal build lab')).toBeVisible();
  } finally {
    await desktop?.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true });
  }
});
