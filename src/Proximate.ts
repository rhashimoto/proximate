interface Endpoint {
  addEventListener(type: string, handler: (event: MessageEvent) => void): void;
  removeEventListener(type: string, handler: (event: MessageEvent) => void): void;
  postMessage(data: any, transferables?: Transferable[]): void;
  start?(): void;
  close?(): void;
}

interface Options {
  receiver?: any,
  debug?: string
}

type RequestSettler = {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
};

// Extensible object serialization.
export interface Protocol<T> {
  canHandle(data: unknown): data is T;
  serialize(data: T, registerReceiver: (receiver: any) => string): [any, Transferable[]];
  deserialize(data: any, createProxy: (id: string) => any): T;
}

// Convenience base class for passing objects by proxy.
export abstract class ProxyProtocol<T> implements Protocol<T> {
  abstract canHandle(data: any): data is T;

  serialize(data: any, registerReceiver: (receiver: any) => string): [any, Transferable[]] {
    return [registerReceiver(data), []];
  }

  deserialize(data: any, createProxy: (id: string) => any): T {
    return createProxy(data);
  }
}

const errorProtocol: Protocol<Error> = {
  canHandle(data: any): data is Error {
    return data instanceof Error;
  },

  serialize(data): [any, Transferable[]] {
    return [{
      message: data.message,
      stack: data.stack
    }, []];
  },

  deserialize(data: any, createProxy: (id: string) => any): any {
    return Object.assign(new Error(), data);
  }
};

function nonce(length = 24): string {
  let value = '';
  while (value.length < length) {
    value += Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
  }
  return value.substring(0, length);
}

// Two-way mapping between objects and proxy ids. Reference counting
// is used to remove associations when all remote proxies have been
// released.
const mapObjectToId = new WeakMap<any, string>();
const mapIdToObject = new Map<string, { receiver: any, count: number }>();

function incReceiverRef(receiver: any) {
  let id = mapObjectToId.get(receiver);
  if (!id) {
    id = nonce();
    mapObjectToId.set(receiver, id);
    mapIdToObject.set(id, { receiver, count: 0 });
  }
  mapIdToObject.get(id).count++;
  return id;
}

function decReceiverRef(receiver: any) {
  const id = mapObjectToId.get(receiver);
  if (id) {
    if (--mapIdToObject.get(id).count === 0) {
      clearReceiverRefs(receiver);
    }
  }
}

function clearReceiverRefs(receiver: any) {
  const id = mapObjectToId.get(receiver);
  mapObjectToId.delete(receiver);
  mapIdToObject.delete(id);
}

const release = Symbol('release');
const close = Symbol('close');

export class Proximate {
  private static endpoints = new WeakMap<Endpoint, Proximate>();

  private debug: string;
  private defaultId: string;
  private requests = new Map<string,  RequestSettler>();
  private proxies = new Map<string, number>();
  private close: () => void;

  private async handleMessage(event: MessageEvent) {
    const message = event.data;
    if (this.debug) console.debug(this.debug, message);

    const endpoint = (event.source || event.target) as unknown as Endpoint;
    if (message.id && message.path) {
      // Handle request (build response).
      const response: any = { id: message.id };
      let transferables = [];
      try {
        const proxyId = message.path.shift() || this.defaultId;
        const [tail] = message.path.slice(-1);
        if (!mapIdToObject.get(proxyId)) throw new Error(`invalid proxy '${proxyId}`);
        let { receiver } = mapIdToObject.get(proxyId);

        let parent;
        for (const property of message.path) {
          parent = receiver;
          receiver = await receiver[property];
        }

        let result;
        if (message.args) {
          // Function call.
          const args = message.args.map(arg => this.deserialize(endpoint, arg));
          result = await receiver.apply(parent, args);
        } else if (message.release) {
          decReceiverRef(receiver);
        } else if (message.close) {
          const remoteProxies = message.close as Map<string, number>;
          remoteProxies.forEach((count, id) => {
            for (let i = 0; i < count; ++i) {
              decReceiverRef(mapIdToObject.get(id || this.defaultId)?.receiver);
            }
          });
          result = this.proxies;
        } else {
          // Member access.
          if (message.hasOwnProperty('value')) {
            parent[tail] = this.deserialize(endpoint, message.value);
          } else {
            result = receiver;
          }
        }
        [response.result, transferables] = this.serialize(result);
      } catch(e) {
        [response.error, transferables] = this.serialize(e);
      }
      endpoint.postMessage(response, transferables);
      if (message.close) this.close?.();
    } else if (message.id && this.requests.has(message.id)) {
      // Handle response.
      const request = this.requests.get(message.id);
      if (message.hasOwnProperty('result')) {
        const result = this.deserialize(endpoint, message.result);
        request.resolve(result);
      } else {
        const error = this.deserialize(endpoint, message.error);
        request.reject(error);
      }
    } else {
      console.debug('ignored message', message);
    }
  }

  private serialize(data: any): [typeof data, Transferable[]] {
    for (const [key, handler] of Proximate.protocols.entries()) {
      if (handler.canHandle(data)) {
        const serialized = handler.serialize(data, incReceiverRef);
        return [{
          type: key,
          data: serialized[0]
        }, serialized[1]]
      }
    }
    if (data === Object(data)) {
      return [{ data }, []];
    }
    return [data, []];
  }

  private deserialize(endpoint: Endpoint, data: any) {
    if (data === Object(data)) {
      if (data.type) {
        const handler = Proximate.protocols.get(data.type);
        if (!handler) throw new Error(`unexpected protocol ${data.type}`);
        return handler.deserialize(data.data, id => this.createLocalProxy(endpoint, [id]));
      }
      return data.data;
    }
    return data;
  }

  private sendRequest(endpoint: Endpoint, request, transferables: Transferable[] = []) {
    return new Promise((resolve, reject) => {
      request.id = nonce();
      this.requests.set(request.id, { resolve, reject });
      endpoint.postMessage(request, transferables);
    });
  }

  private createLocalProxy(endpoint: Endpoint, path: (string | number)[] = [nonce()]) {
    const id = path[0] as string;
    const { proxy, revoke } = Proxy.revocable(() => {}, {
      get: (_target, property) => {
        if (property === release && path.length === 1) {
          return () => {
            revoke();
            if (this.proxies.get(id) > 1) {
              this.proxies.set(id, this.proxies.get(id) - 1);
            } else {
              this.proxies.delete(id);
            }
            return this.sendRequest(endpoint, { path, release: true });
          }
        }
        if (property === close && path.length === 1) {
          return async () => {
            const remoteProxies = await this.sendRequest(endpoint, {
              path,
              close: this.proxies
            }) as Map<string, number>;
            remoteProxies.forEach((count, id) => {
              for (let i = 0; i < count; ++i) {
                decReceiverRef(mapIdToObject.get(id || this.defaultId)?.receiver);
              }
            });
            this.close?.();
          }
        }
        if (typeof property === 'symbol') return undefined;
        if (property === 'then') {
          if (path.length === 1) return { then: () => proxy };
          const p = this.sendRequest(endpoint, { path });
          return p.then.bind(p);
        }
        return this.createLocalProxy(endpoint, [...path, property]);
      },

      set: (_target, property, value) => {
        if (typeof property === 'symbol') return false;
        const [wireValue, transferables] = this.serialize(value);
        this.sendRequest(endpoint, {
          path: [...path, property],
          value: wireValue
        }, transferables);
        return true;
      },

      apply: (_target, _, args: any[]) => {
        const serialized = args.map(arg => this.serialize(arg));
        return this.sendRequest(endpoint, {
          path,
          args: serialized.map(value => value[0])
        }, serialized.map(value => value[1]).flat());
      }
    });
    
    this.proxies.set(id, (this.proxies.get(id) || 0) + 1);
    return proxy;
  }

  static protocols = new Map<string, Protocol<unknown>>([['_error', errorProtocol]]);

  static wrap(endpoint: Endpoint, options: Options = {}) {
    if (Proximate.endpoints.has(endpoint)) throw new Error('endpoint already wrapped');
    const instance = new Proximate();
    const listener = (event: MessageEvent) => instance.handleMessage(event);
    instance.close = () => {
      endpoint.removeEventListener('message', listener);
      endpoint.close?.();
    }
    endpoint.addEventListener('message', listener);
    endpoint.start?.();
    Proximate.endpoints.set(endpoint, instance);

    instance.debug = options.debug;
    if (options.receiver) {
      instance.defaultId = incReceiverRef(options.receiver);
    }
    return instance.createLocalProxy(endpoint, ['']);
  }

  static release(proxy: any) {
    return proxy[release]?.();
  }

  static close(proxy: any) {
    return proxy[close]?.();
  }

  static revokeProxies(receiver: any) {
    clearReceiverRefs(receiver);
  }

  // Wrap a Window with the MessagePort interface. To listen to
  // an iframe element, use portify(element.contentWindow).
  // Inside the iframe, use portify(window.parent).
  static portify(window: any, eventSource: any = self, targetOrigin = '*') {
    return {
      postMessage(message: object, transferables: Transferable[]) {
        window.postMessage(message, targetOrigin, transferables);
      },
      
      addEventListener: eventSource.addEventListener.bind(eventSource),
      removeEventListener: eventSource.removeEventListener.bind(eventSource)
    };
  }
}