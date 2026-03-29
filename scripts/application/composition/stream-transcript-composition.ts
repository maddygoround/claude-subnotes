import { ServiceContainer, type ServiceToken } from '../di/container.js';
import type {
  StreamTranscriptInputReader,
  StreamTranscriptSentinelGateway,
  StreamTranscriptStateGateway,
} from '../contracts/stream-transcript.js';
import { StdinStreamTranscriptInputReader } from '../adapters/stream-transcript-input-reader.js';
import { ConversationStreamTranscriptStateGateway } from '../adapters/stream-transcript-state-gateway.js';
import { DefaultStreamTranscriptSentinelGateway } from '../adapters/stream-transcript-sentinel-gateway.js';
import { StreamTranscriptUseCase } from '../use-cases/stream-transcript.use-case.js';

const TOKENS = {
  inputReader: Symbol(
    'stream-transcript.input-reader',
  ) as ServiceToken<StreamTranscriptInputReader>,
  stateGateway: Symbol(
    'stream-transcript.state-gateway',
  ) as ServiceToken<StreamTranscriptStateGateway>,
  sentinelGateway: Symbol(
    'stream-transcript.sentinel-gateway',
  ) as ServiceToken<StreamTranscriptSentinelGateway>,
  useCase: Symbol(
    'stream-transcript.use-case',
  ) as ServiceToken<StreamTranscriptUseCase>,
};

export function createStreamTranscriptUseCase(): StreamTranscriptUseCase {
  const container = new ServiceContainer();

  container.registerSingleton(
    TOKENS.inputReader,
    () => new StdinStreamTranscriptInputReader(),
  );
  container.registerSingleton(
    TOKENS.stateGateway,
    () => new ConversationStreamTranscriptStateGateway(),
  );
  container.registerSingleton(
    TOKENS.sentinelGateway,
    () => new DefaultStreamTranscriptSentinelGateway(),
  );
  container.registerSingleton(TOKENS.useCase, (c) => new StreamTranscriptUseCase({
    inputReader: c.resolve(TOKENS.inputReader),
    stateGateway: c.resolve(TOKENS.stateGateway),
    sentinelGateway: c.resolve(TOKENS.sentinelGateway),
  }));

  return container.resolve(TOKENS.useCase);
}
