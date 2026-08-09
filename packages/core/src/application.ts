import type {
  Clock,
  Gw2Gateway,
  Gw2ccRepositories,
  LlmProviderRegistry,
  SecretStore,
  ToolExecutor
} from './ports';
import { ChatService, ConversationService, ProviderSettingsService } from './chat-services';
import {
  CharacterService,
  ConnectionService,
  ContextService,
  Gw2ccApplication
} from './services';
import type { ResearchService } from './research';

export function createGw2ccApplication(dependencies: {
  gw2: Gw2Gateway;
  repositories: Gw2ccRepositories;
  secrets: SecretStore;
  llmProviders: LlmProviderRegistry;
  tools: ToolExecutor;
  clock?: Clock;
  createId?: () => string;
  research: ResearchService;
}): Gw2ccApplication {
  const clock = dependencies.clock ?? { now: () => Date.now() };
  const createId = dependencies.createId ?? (() => globalThis.crypto.randomUUID());
  const connection = new ConnectionService(
    dependencies.gw2,
    dependencies.secrets,
    dependencies.repositories.account,
    clock
  );
  const characters = new CharacterService(
    dependencies.gw2,
    dependencies.secrets,
    dependencies.repositories.account
  );
  const context = new ContextService(
    dependencies.repositories.settings,
    dependencies.repositories.contexts,
    dependencies.repositories.account
  );
  const providers = new ProviderSettingsService(
    dependencies.repositories.settings,
    dependencies.secrets,
    dependencies.llmProviders,
    dependencies.gw2.fixtureMode
  );
  const conversations = new ConversationService(
    dependencies.repositories.conversations,
    dependencies.repositories.settings,
    clock,
    createId
  );
  const chat = new ChatService(
    conversations,
    dependencies.repositories.conversations,
    providers,
    dependencies.tools,
    characters,
    context,
    dependencies.repositories.account,
    clock,
    createId
  );
  return new Gw2ccApplication({
    connection,
    characters,
    context,
    providers,
    conversations,
    chat,
    research: dependencies.research
  });
}
