# Application Layer Pattern

This folder introduces a framework-style architecture for hook orchestration:

1. **Use-case classes** (`use-cases/`)
   - Pure orchestration.
   - No direct file/process/global calls.
2. **Contracts** (`contracts/`)
   - Interfaces describing what a use-case needs.
3. **Adapters** (`adapters/`)
   - Real implementations that call existing modules (for example `conversation_utils`).
4. **Composition roots** (`composition/`)
   - The only place where concrete classes are wired together.
5. **DI primitives** (`di/`)
   - Tiny container used to resolve dependencies from typed tokens.

Current migrated slice:

- `SessionStart` now runs through a class-based use-case and injected dependencies.

Migration rule for new hooks:

1. Move script logic into a `*.use-case.ts` class.
2. Add interfaces under `contracts/`.
3. Implement adapters around existing helper modules.
4. Wire in `composition/`.
5. Keep script entrypoint thin (resolve use-case + execute + exit handling).
