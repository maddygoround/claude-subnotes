import type { LogFn } from '../../framework/hook-io.js';
import { ServiceContainer, type ServiceToken } from '../di/container.js';
import type {
  StopSyncInputReader,
  StopSyncStateGateway,
} from '../contracts/stop-sync.js';
import { StdinStopSyncInputReader } from '../adapters/stop-sync-input-reader.js';
import { DefaultStopSyncStateGateway } from '../adapters/stop-sync-state-gateway.js';
import { StopSyncUseCase } from '../use-cases/stop-sync.use-case.js';

const TOKENS = {
  log: Symbol('stop-sync.log') as ServiceToken<LogFn>,
  inputReader: Symbol('stop-sync.input-reader') as ServiceToken<StopSyncInputReader>,
  stateGateway: Symbol('stop-sync.state-gateway') as ServiceToken<StopSyncStateGateway>,
  useCase: Symbol('stop-sync.use-case') as ServiceToken<StopSyncUseCase>,
};

export function createStopSyncUseCase(log: LogFn): StopSyncUseCase {
  const container = new ServiceContainer();
  container.registerValue(TOKENS.log, log);

  container.registerSingleton(
    TOKENS.inputReader,
    () => new StdinStopSyncInputReader(),
  );
  container.registerSingleton(
    TOKENS.stateGateway,
    () => new DefaultStopSyncStateGateway(),
  );
  container.registerSingleton(TOKENS.useCase, (c) => new StopSyncUseCase({
    inputReader: c.resolve(TOKENS.inputReader),
    stateGateway: c.resolve(TOKENS.stateGateway),
    log: c.resolve(TOKENS.log),
  }));

  return container.resolve(TOKENS.useCase);
}
