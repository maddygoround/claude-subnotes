import type { LogFn } from '../../framework/hook-io.js';
import { ServiceContainer, type ServiceToken } from '../di/container.js';
import type {
  StopContinuousWorkerGateway,
  StopContinuousWorkerInputReader,
} from '../contracts/stop-continuous-worker.js';
import { StdinStopContinuousWorkerInputReader } from '../adapters/stop-continuous-worker-input-reader.js';
import { DefaultStopContinuousWorkerGateway } from '../adapters/stop-continuous-worker-gateway.js';
import { StopContinuousWorkerUseCase } from '../use-cases/stop-continuous-worker.use-case.js';

const TOKENS = {
  log: Symbol('stop-continuous-worker.log') as ServiceToken<LogFn>,
  inputReader: Symbol(
    'stop-continuous-worker.input-reader',
  ) as ServiceToken<StopContinuousWorkerInputReader>,
  gateway: Symbol(
    'stop-continuous-worker.gateway',
  ) as ServiceToken<StopContinuousWorkerGateway>,
  useCase: Symbol(
    'stop-continuous-worker.use-case',
  ) as ServiceToken<StopContinuousWorkerUseCase>,
};

export function createStopContinuousWorkerUseCase(
  log: LogFn,
): StopContinuousWorkerUseCase {
  const container = new ServiceContainer();
  container.registerValue(TOKENS.log, log);

  container.registerSingleton(
    TOKENS.inputReader,
    () => new StdinStopContinuousWorkerInputReader(),
  );
  container.registerSingleton(
    TOKENS.gateway,
    () => new DefaultStopContinuousWorkerGateway(),
  );
  container.registerSingleton(TOKENS.useCase, (c) => new StopContinuousWorkerUseCase({
    inputReader: c.resolve(TOKENS.inputReader),
    gateway: c.resolve(TOKENS.gateway),
    log: c.resolve(TOKENS.log),
  }));

  return container.resolve(TOKENS.useCase);
}
