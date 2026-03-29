import type { LogFn } from '../../framework/hook-io.js';
import { ServiceContainer, type ServiceToken } from '../di/container.js';
import type {
  HomeDirectoryProvider,
  SessionStartInputReader,
  SessionStartStateGateway,
} from '../contracts/session-start.js';
import { StdinSessionStartInputReader } from '../adapters/session-start-input-reader.js';
import { ConversationUtilsSessionStartStateGateway } from '../adapters/session-start-state-gateway.js';
import { ProcessHomeDirectoryProvider } from '../adapters/home-directory-provider.js';
import { SessionStartUseCase } from '../use-cases/session-start.use-case.js';

const TOKENS = {
  log: Symbol('session-start.log') as ServiceToken<LogFn>,
  inputReader: Symbol('session-start.input-reader') as ServiceToken<SessionStartInputReader>,
  stateGateway: Symbol('session-start.state-gateway') as ServiceToken<SessionStartStateGateway>,
  homeDirectoryProvider: Symbol(
    'session-start.home-directory-provider',
  ) as ServiceToken<HomeDirectoryProvider>,
  useCase: Symbol('session-start.use-case') as ServiceToken<SessionStartUseCase>,
};

export function createSessionStartUseCase(log: LogFn): SessionStartUseCase {
  const container = new ServiceContainer();
  container.registerValue(TOKENS.log, log);

  container.registerSingleton(
    TOKENS.inputReader,
    () => new StdinSessionStartInputReader(),
  );
  container.registerSingleton(
    TOKENS.stateGateway,
    () => new ConversationUtilsSessionStartStateGateway(),
  );
  container.registerSingleton(
    TOKENS.homeDirectoryProvider,
    () => new ProcessHomeDirectoryProvider(),
  );
  container.registerSingleton(TOKENS.useCase, (c) => new SessionStartUseCase({
    inputReader: c.resolve(TOKENS.inputReader),
    stateGateway: c.resolve(TOKENS.stateGateway),
    homeDirectoryProvider: c.resolve(TOKENS.homeDirectoryProvider),
    log: c.resolve(TOKENS.log),
  }));

  return container.resolve(TOKENS.useCase);
}
