import type { LogFn } from '../../framework/hook-io.js';
import { ServiceContainer, type ServiceToken } from '../di/container.js';
import type {
  SyncLocalMemoryInputReader,
  SyncLocalMemoryStateGateway,
} from '../contracts/sync-local-memory.js';
import { StdinSyncLocalMemoryInputReader } from '../adapters/sync-local-memory-input-reader.js';
import { DefaultSyncLocalMemoryStateGateway } from '../adapters/sync-local-memory-state-gateway.js';
import { SyncLocalMemoryUseCase } from '../use-cases/sync-local-memory.use-case.js';

const TOKENS = {
  log: Symbol('sync-local-memory.log') as ServiceToken<LogFn>,
  inputReader: Symbol(
    'sync-local-memory.input-reader',
  ) as ServiceToken<SyncLocalMemoryInputReader>,
  stateGateway: Symbol(
    'sync-local-memory.state-gateway',
  ) as ServiceToken<SyncLocalMemoryStateGateway>,
  useCase: Symbol(
    'sync-local-memory.use-case',
  ) as ServiceToken<SyncLocalMemoryUseCase>,
};

export function createSyncLocalMemoryUseCase(log: LogFn): SyncLocalMemoryUseCase {
  const container = new ServiceContainer();
  container.registerValue(TOKENS.log, log);

  container.registerSingleton(
    TOKENS.inputReader,
    () => new StdinSyncLocalMemoryInputReader(),
  );
  container.registerSingleton(
    TOKENS.stateGateway,
    () => new DefaultSyncLocalMemoryStateGateway(),
  );
  container.registerSingleton(TOKENS.useCase, (c) => new SyncLocalMemoryUseCase({
    inputReader: c.resolve(TOKENS.inputReader),
    stateGateway: c.resolve(TOKENS.stateGateway),
    log: c.resolve(TOKENS.log),
  }));

  return container.resolve(TOKENS.useCase);
}
