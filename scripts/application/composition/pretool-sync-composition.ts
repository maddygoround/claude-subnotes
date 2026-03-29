import type { LogFn } from '../../framework/hook-io.js';
import { ServiceContainer, type ServiceToken } from '../di/container.js';
import type {
  PreToolAutonomicGateway,
  PreToolInputReader,
  PreToolStateGateway,
} from '../contracts/pretool-sync.js';
import { StdinPreToolInputReader } from '../adapters/pretool-input-reader.js';
import { ConversationPreToolStateGateway } from '../adapters/pretool-state-gateway.js';
import { DefaultPreToolAutonomicGateway } from '../adapters/pretool-autonomic-gateway.js';
import { PreToolSyncUseCase } from '../use-cases/pretool-sync.use-case.js';

const TOKENS = {
  log: Symbol('pretool-sync.log') as ServiceToken<LogFn>,
  inputReader: Symbol('pretool-sync.input-reader') as ServiceToken<PreToolInputReader>,
  stateGateway: Symbol('pretool-sync.state-gateway') as ServiceToken<PreToolStateGateway>,
  autonomicGateway: Symbol(
    'pretool-sync.autonomic-gateway',
  ) as ServiceToken<PreToolAutonomicGateway>,
  useCase: Symbol('pretool-sync.use-case') as ServiceToken<PreToolSyncUseCase>,
};

export function createPreToolSyncUseCase(log: LogFn): PreToolSyncUseCase {
  const container = new ServiceContainer();
  container.registerValue(TOKENS.log, log);

  container.registerSingleton(
    TOKENS.inputReader,
    () => new StdinPreToolInputReader(),
  );
  container.registerSingleton(
    TOKENS.stateGateway,
    () => new ConversationPreToolStateGateway(),
  );
  container.registerSingleton(
    TOKENS.autonomicGateway,
    () => new DefaultPreToolAutonomicGateway(),
  );
  container.registerSingleton(TOKENS.useCase, (c) => new PreToolSyncUseCase({
    inputReader: c.resolve(TOKENS.inputReader),
    stateGateway: c.resolve(TOKENS.stateGateway),
    autonomicGateway: c.resolve(TOKENS.autonomicGateway),
    log: c.resolve(TOKENS.log),
  }));

  return container.resolve(TOKENS.useCase);
}
