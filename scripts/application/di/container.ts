/**
 * Tiny DI container used as a composition root primitive.
 *
 * We keep this intentionally small so service boundaries remain explicit
 * and dependency flow stays easy to follow in code review.
 */

export type ServiceToken<T> = symbol & { readonly __type?: T };
type ServiceFactory<T> = (container: ServiceContainer) => T;

interface ServiceRegistration<T> {
  factory: ServiceFactory<T>;
  singleton: boolean;
}

export class ServiceContainer {
  private readonly registrations = new Map<
    ServiceToken<unknown>,
    ServiceRegistration<unknown>
  >();
  private readonly singletons = new Map<ServiceToken<unknown>, unknown>();

  registerSingleton<T>(token: ServiceToken<T>, factory: ServiceFactory<T>): void {
    this.registrations.set(token, {
      factory: factory as ServiceFactory<unknown>,
      singleton: true,
    });
  }

  registerTransient<T>(token: ServiceToken<T>, factory: ServiceFactory<T>): void {
    this.registrations.set(token, {
      factory: factory as ServiceFactory<unknown>,
      singleton: false,
    });
  }

  registerValue<T>(token: ServiceToken<T>, value: T): void {
    this.singletons.set(token, value);
    this.registerSingleton(token, () => value);
  }

  resolve<T>(token: ServiceToken<T>): T {
    if (this.singletons.has(token)) {
      return this.singletons.get(token) as T;
    }

    const registration = this.registrations.get(token);
    if (!registration) {
      throw new Error('Service token is not registered in container');
    }

    const instance = registration.factory(this);
    if (registration.singleton) {
      this.singletons.set(token, instance);
    }

    return instance as T;
  }
}
