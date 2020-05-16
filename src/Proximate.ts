// Proximate will wrap any endpoint that looks like a MessagePort.
interface Endpoint {
  addEventListener(type: string, handler: (event: MessageEvent) => void): void;
  removeEventListener(type: string, handler: (event: MessageEvent) => void): void;
  postMessage(data: any, transferables?: Transferable[]): void;
  start?(): void;
  close?(): void;
}

interface Options {
  receiver?: any,
  debug?: (message: MessageEvent) => void
}

type PromiseCallbacks = {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
};

// Extensible object serialization. Custom instances of Protocol can be
// registered in Proximate.protocols with a string key. The typical use
// is either to pass by proxy or to specify transferables.
export interface Protocol<T> {
  canHandle(data: unknown): data is T;
  serialize(data: T, registerReceiver: (receiver: any) => string): [any, Transferable[]];
  deserialize(data: any, createProxy: (id: string) => any): T;
}

// Convenience base class for passing objects by proxy. Just override
// canHandle().
export abstract class ProxyProtocol<T> implements Protocol<T> {
  abstract canHandle(data: any): data is T;

  serialize(data: any, registerReceiver: (receiver: any) => string): [any, Transferable[]] {
    return [registerReceiver(data), []];
  }

  deserialize(data: any, createProxy: (id: string) => any): T {
    return createProxy(data);
  }
}

// Protocol to serialize Error instances.
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

// Generate a random string id for proxies and requests.
function nonce(length = 24): string {
  let value = '';
  while (value.length < length) {
    value += Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
  }
  return value.substring(0, length);
}

// Two-way mapping between objects and proxy ids. This is for looking
// up local objects that are passed by proxy to remote endpoints.
// Reference counting is used to remove associations when all remote
// proxies have been released.
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
      mapObjectToId.delete(receiver);
      mapIdToObject.delete(id);
    }
  }
}

// These symbols are used to key special functions on Proxy instances.
const RELEASE = Symbol('release');
const CLOSE = Symbol('close');
const PROXIES = Symbol('proxies');

export class Proximate {
  private debug: (message) => void;

  // The receiver passed as an option to wrap() is not sent by proxy,
  // i.e. its id is not passed over the wire. Instead the remote endpoint
  // accesses it by convention with the empty string which is converted
  // locally to this valid id.
  private defaultId: string;

  // Each request has a nonce id. When a response from the remote endpoint
  // arrives, this map uses the id to get the request's Promise callbacks.
  private requests = new Map<string,  PromiseCallbacks>();

  // This map holds a one-to-many mapping from ids to Proxy instances.
  // When the connection is closed, reference counts derived from this
  // data is sent to the remote endpoint to reclaim resources. It may
  // also be accessed via the proxies() static member function for
  // debugging leaks.
  proxies = new Map<string, Set<any>>();

  // Clean up and close endpoint (assigned in wrap).
  private close: () => void;

  private async handleMessage(endpoint: Endpoint, message: any) {
    this.debug?.(message);
    if (message.id && message.path) {
      // Handle request (build response).
      const response: any = { id: message.id };
      let transferables = [];
      try {
        const proxyId = message.path.shift() || this.defaultId;
        const [tail] = message.path.slice(-1);
        let { receiver } = mapIdToObject.get(proxyId) || { receiver: undefined };

        let parent;
        for (const property of message.path) {
          parent = receiver;
          receiver = receiver[property];
        }

        let result;
        if (message.args) {
          // Function call.
          const args = message.args.map(arg => this.deserialize(endpoint, arg));
          result = await receiver.apply(parent, args);
        } else if (message.release) {
          // Remote proxy is released.
          decReceiverRef(receiver);
        } else if (message.close) {
          // Close endpoint.
          const remoteProxies = message.close as Map<string, number>;
          remoteProxies.forEach((count, id) => {
            for (let i = 0; i < count; ++i) {
              decReceiverRef(mapIdToObject.get(id || this.defaultId)?.receiver);
            }
          });
          result = this.proxyCounts();
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
      this.requests.delete(message.id);
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
    // Check for custom serialization.
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
        // Custom serialization.
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
    const proxy = new Proxy(() => {}, {
      get: (_target, property) => {
        if (path.length === 1) {
          if (property === RELEASE) {
            return () => {
              const proxiesForId = this.proxies.get(id);
              proxiesForId.delete(proxy);
              if (proxiesForId.size === 0) {
                this.proxies.delete(id);
              }
              return this.sendRequest(endpoint, { path, release: true });
            }
          }
          if (id === '') {
            // Only available on Proxy returned from wrap().
            if (property === CLOSE) {
              return async () => {
                const remoteProxies = await this.sendRequest(endpoint, {
                  path,
                  close: this.proxyCounts()
                }) as Map<string, number>;
                remoteProxies.forEach((count, id) => {
                  for (let i = 0; i < count; ++i) {
                    decReceiverRef(mapIdToObject.get(id || this.defaultId)?.receiver);
                  }
                });
                this.proxies.clear();
                this.close?.();
              }
            }
            if (property === PROXIES) {
              return () => this.proxies;
            }
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
    
    if (!this.proxies.has(id)) {
      this.proxies.set(id, new Set());
    }
    const proxiesForId = this.proxies.get(id);
    proxiesForId.add(proxy);
    this.proxies.set(id, proxiesForId);
    return proxy;
  }

  // Convert the one-to-many mapping of ids to proxies into a
  // map of reference counts for the remote endpoint to reclaim
  // resources on close.
  private proxyCounts() {
    const result = new Map<string, number>();
    for (const [key, value] of this.proxies.entries()) {
      result.set(key, value.size);
    }
    return result;
  }

  // Add entries to this map to customize serialization, generally
  // either to pass by proxy or to specify transferables.
  static protocols = new Map<string, Protocol<unknown>>([['_error', errorProtocol]]);

  // Wrap a MessagePort-like endpoint with a proxy.
  // Valid options:
  //  receiver  The object that the remote endpoint proxy accesses.
  //  debug     A function passed incoming MessageEvent instances.
  static wrap(endpoint: Endpoint, options: Options = {}) {
    const instance = new Proximate();
    const listener = (event: MessageEvent) => instance.handleMessage(endpoint, event.data);
    endpoint.addEventListener('message', listener);
    endpoint.start?.();
    instance.close = () => {
      endpoint.removeEventListener('message', listener);
      endpoint.close?.();
      instance.close = undefined;
    }

    instance.debug = options.debug;
    if (options.receiver) {
      instance.defaultId = incReceiverRef(options.receiver);
    }
    return instance.createLocalProxy(endpoint, ['']);
  }

  // Release remote resources. No further calls to proxy methods should
  // be made.
  static release(proxy: any) {
    return proxy[RELEASE]();
  }

  // Close the endpoint the proxy argument is on. All proxies on the
  // same endpoint will be released.
  static close(proxy: any) {
    return proxy[CLOSE]?.();
  }

  // Get the one-to-many mapping of ids to Proxy instances for debugging
  // leaks. Must be called with proxy returned directly by wrap().
  static proxies(primary) {
    return primary[PROXIES]();
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