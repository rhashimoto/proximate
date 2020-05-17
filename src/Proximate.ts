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

// These symbols are used to key special functions on Proxy instances.
const RELEASE = Symbol('release');
const CLOSE = Symbol('close');
const DEBUG = Symbol('debug');

export class Proximate {
  private debug: (message) => void;

  // The receiver passed as an option to wrap() is not sent by proxy,
  // i.e. its id is not passed over the wire. Instead the remote endpoint
  // accesses it by convention with the empty string which is converted
  // locally to this valid id.
  defaultId: string;

  // Each request has a nonce id. When a response from the remote endpoint
  // arrives, this map uses the id to get the request's Promise callbacks.
  requests = new Map<string,  PromiseCallbacks>();

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
      // Handle incoming request (build response).
      const response: any = { id: message.id };
      let transferables = [];
      try {
        // The head of the path is the receiver id. The empty string is
        // a special key for the primary proxy.
        const proxyId = message.path.shift() || this.defaultId;
        const [tail] = message.path.slice(-1);
        let { receiver } = Proximate.mapIdToObject.get(proxyId) || { receiver: undefined };

        let parent;
        for (const property of message.path) {
          parent = receiver;
          receiver = receiver[property];
        }

        // The message doesn't have an explicit type property. We deduce
        // the type of message from which properties it has.
        let result;
        if (message.args) {
          // Function call.
          const args = message.args.map(arg => this.deserialize(endpoint, arg));
          result = await receiver.apply(parent, args);
        } else if (message.release) {
          // Remote proxy is released.
          this.decReceiverRef(new Map([[proxyId, 1]]));
        } else if (message.close) {
          // Close endpoint.
          const remoteProxies = message.close as Map<string, number>;
          this.decReceiverRef(remoteProxies);
          result = this.proxyCounts();
        } else {
          // Member access.
          if (message.hasOwnProperty('value')) {
            // Set member.
            parent[tail] = this.deserialize(endpoint, message.value);
          } else {
            // Get member.
            result = receiver;
          }
        }
        [response.result, transferables] = this.serialize(result);
      } catch(e) {
        [response.error, transferables] = this.serialize(e);
      }
      endpoint.postMessage(response, transferables);
      if (message.close) this.close();
    } else if (message.id && this.requests.has(message.id)) {
      // Match the response with its request.
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
        const [wireValue, transferables] = handler.serialize(data, this.incReceiverRef);
        return [{ type: key, data: wireValue }, transferables]
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
        // This object had custom serialization.
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
    // Set up local (non-proxied) symbol methods.
    let proxy;
    const id = path[0] as string;
    const target = () => {};
    if (path.length === 1) {
      target[RELEASE] = () => {
        // Remove the entry for this proxy.
        const proxiesForId = this.proxies.get(id);
        proxiesForId.delete(proxy);
        if (proxiesForId.size === 0) {
          this.proxies.delete(id);
        }

        // Tell the remote endpoint to update the receiver ref count.
        return this.sendRequest(endpoint, { path, release: true });
      };
    }

    proxy = new Proxy(target, {
      get: (target, property) => {
        if (typeof property === 'symbol') return target[property];
        if (property === 'then') {
          if (path.length === 1) return { then: () => proxy };
          const promise = this.sendRequest(endpoint, { path });
          return promise.then.bind(promise);
        }
        return this.createLocalProxy(endpoint, [...path, property]);
      },

      set: (target, property, value) => {
        if (typeof property === 'symbol') {
          target[property] = value;
          return true;
        }
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
    
    // Track the created proxies by recording them in a Map. There
    // may be multiple proxies for the same remote object, in which
    // case all the proxies use the same id.
    if (!this.proxies.has(id)) {
      this.proxies.set(id, new Set());
    }
    const proxiesForId = this.proxies.get(id);
    proxiesForId.add(proxy);
    this.proxies.set(id, proxiesForId);
    return proxy;
  }

  // Helper function to convert the one-to-many mapping of ids to proxies
  // into a map of reference counts for the remote endpoint to reclaim
  // resources on close.
  private proxyCounts() {
    const result = new Map<string, number>();
    for (const [key, value] of this.proxies.entries()) {
      result.set(key, value.size);
    }
    return result;
  }

  // Two-way mapping between objects and proxy ids. This is for looking
  // up local objects that are passed by proxy to remote endpoints.
  // Reference counting is used to remove associations when all remote
  // proxies have been released.
  static mapObjectToId = new WeakMap<any, string>();
  static mapIdToObject = new Map<string, { receiver: any, count: number }>();

  private incReceiverRef(receiver: any) {
    let id = Proximate.mapObjectToId.get(receiver);
    if (!id) {
      id = nonce();
      Proximate.mapObjectToId.set(receiver, id);
      Proximate.mapIdToObject.set(id, { receiver, count: 0 });
    }
    Proximate.mapIdToObject.get(id).count++;
    return id;
  }

  // As part of the connection closing process, each endpoint sends the
  // other all its unreleased proxy references to be released en masse.
  private decReceiverRef(remoteProxies: Map<string, number>) {
    remoteProxies.forEach((count, id) => {
      const localId = id || this.defaultId;
      const entry = Proximate.mapIdToObject.get(localId);
      if (entry) {
        if ((entry.count -= count) > 0) {
          Proximate.mapIdToObject.set(localId, entry);
        } else {
          Proximate.mapObjectToId.delete(entry.receiver);
          Proximate.mapIdToObject.delete(localId);
        }
      }
    });
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
    instance.debug = options.debug;
    if (options.receiver) {
      // Operations on the remote endpoint's primary proxy will
      // be passed to this receiver object.
      instance.defaultId = instance.incReceiverRef(options.receiver);
    }

    // Hook up the message passing.
    const listener = (event: MessageEvent) => instance.handleMessage(endpoint, event.data);
    endpoint.addEventListener('message', listener);
    endpoint.start?.();
    instance.close = () => {
      endpoint.removeEventListener('message', listener);
      endpoint.close?.();
    }

    // Create the primary proxy.
    const proxy = instance.createLocalProxy(endpoint, ['']);
    proxy[DEBUG] = () => instance;
    proxy[CLOSE] = async () => {
      // Send a close request with the unreleased proxy counts.
      const remoteProxies = await instance.sendRequest(endpoint, {
        path: [''],
        close: instance.proxyCounts()
      }) as Map<string, number>;
      instance.proxies.clear();

      // We get back the unreleased proxy counts from the other
      // endpoint.
      instance.decReceiverRef(remoteProxies);

      // Close our endpoint.
      instance.close();
    };
    return proxy;
  }

  // Release remote resources for this proxy. No further method calls
  // on this proxy should be invoked, results are undefined.
  static release(proxy: any) {
    return proxy[RELEASE]();
  }

  // Close the endpoint the proxy argument was created with. All proxies
  // on the same endpoint will be released. Must be called with the proxy
  // returned directly by wrap(), i.e. not a proxy received via an
  // argument or function call result.
  static close(primary: any) {
    return primary[CLOSE]?.();
  }

  // Get access to Proximate instance internals for debugging. Must be
  // called with proxy returned directly by wrap(), i.e. not a proxy
  // received via an argument or function call result.
  static debug(primary) {
    return primary[DEBUG]();
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