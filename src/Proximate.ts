// Proximate will wrap any endpoint that looks like a MessagePort.
interface Endpoint {
  addEventListener(type: string, handler: (event: MessageEvent) => void): void;
  removeEventListener(type: string, handler: (event: MessageEvent) => void): void;
  postMessage(data: any, transferables?: Transferable[]): void;
  start?(): void;
  close?(): void;
}

// Extensible object serialization. Custom instances of Protocol can be
// registered in Proximate.protocols with a string key. The typical uses
// are either to pass by proxy or to specify transferables.
export interface Protocol<T> {
  canHandle(data: unknown): data is T;
  serialize(data: T, registerReceiver: (receiver: T) => string): [any, Transferable[]];
  deserialize(data: any, createProxy: (id: string) => any): T;
}

// Convenience base class for passing objects by proxy. Just override
// canHandle() to identify which objects to proxy.
export abstract class ProxyProtocol<T> implements Protocol<T> {
  abstract canHandle(data: any): data is T;

  serialize(data: T, registerReceiver: (receiver: T) => string): [any, Transferable[]] {
    return [registerReceiver(data), []];
  }

  deserialize(data: any, createProxy: (id: string) => any): T {
    return createProxy(data);
  }
}

// Generate a random string id for proxies and requests.
function nonce(length = 24): string {
  let value = '';
  while (value.length < length) {
    value += Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
  }
  return value.substring(0, length);
}

export class Proximate {
  // The receiver passed as an option to wrap() is not sent by proxy,
  // i.e. its id is not passed over the wire. Instead the remote endpoint
  // accesses it by convention with the empty string which is converted
  // locally to this valid id.
  defaultId: string;

  // Each request has a nonce id. When a response from the remote endpoint
  // arrives, this map is used to get the request's Promise callbacks.
  requests = new Map<string, { resolve, reject }>();

  // This map holds a one-to-many mapping from ids to Proxy instances.
  // When the connection is closed, reference counts derived from this
  // data is sent to the remote endpoint to reclaim resources. It may
  // also be accessed via the proxies() static member function for
  // debugging leaks.
  mapIdToProxies = new Map<string, Set<any>>();

  // This map tracks proxies created from a specific point in time.
  trackedProxies = new Set<any>();

  debug: (message) => void;
  listener: EventListener = event => this.handleMessage(event as MessageEvent);

  private constructor(private endpoint: Endpoint) {
    this.endpoint.addEventListener('message', this.listener);
    this.endpoint.start?.();
  }

  private async handleMessage(event: MessageEvent) {
    const message = event.data;
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
          const args = message.args.map(arg => this.deserialize(this.endpoint, arg));
          result = await receiver.apply(parent, args);
        } else if (message.release) {
          // Remote proxy is released.
          this.decReceiverRef(message.release);
        } else if (message.close) {
          // Close endpoint.
          this.decReceiverRef(message.close);
          result = this.proxyCounts();
        } else {
          // Member access.
          if (message.hasOwnProperty('value')) {
            // Set member.
            parent[tail] = this.deserialize(this.endpoint, message.value);
          } else {
            // Get member.
            result = receiver;
          }
        }
        [response.result, transferables] = this.serialize(result);
      } catch(e) {
        [response.error, transferables] = this.serialize(e);
      }
      this.endpoint.postMessage(response, transferables);
      if (message.close) this.close();
    } else if (message.id && this.requests.has(message.id)) {
      // Match the response with its request.
      const request = this.requests.get(message.id);
      this.requests.delete(message.id);
      if (message.hasOwnProperty('result')) {
        const result = this.deserialize(this.endpoint, message.result);
        request.resolve(result);
      } else {
        const error = this.deserialize(this.endpoint, message.error);
        request.reject(error);
      }
    } else {
      console.debug('ignored message', message);
    }
  }

  private serialize(data: any): [typeof data, Transferable[]] {
    // Check for custom serialization.
    for (const [key, handler] of this.protocols.entries()) {
      if (handler.canHandle(data)) {
        const [wireValue, transferables] = handler.serialize(data, this.incReceiverRef);
        return [{ type: key, data: wireValue }, transferables]
      }
    }
    for (const [key, handler] of Proximate.protocols.entries()) {
      if (handler.canHandle(data)) {
        const [wireValue, transferables] = handler.serialize(data, this.incReceiverRef);
        return [{ type: key, data: wireValue }, transferables]
      }
    }
    if (data instanceof Error) {
      return [{ error: { message: data.message, stack: data.stack }}, []];
    }
    if (data === Object(data)) {
      return [{ data }, []];
    }
    return [data, []];
  }

  private deserialize(endpoint: Endpoint, data: any) {
    if (data === Object(data)) {
      if (data.hasOwnProperty('type')) {
        // This object had custom serialization.
        const handler = this.protocols.get(data.type) || Proximate.protocols.get(data.type);
        if (!handler) throw new Error(`unexpected protocol ${data.type}`);
        return handler.deserialize(data.data, id => this.createLocalProxy(endpoint, [id]));
      }
      if (data.error) {
        return Object.assign(new Error(), data.error);
      }
      return data.data;
    }
    return data;
  }

  private sendRequest(endpoint: Endpoint, request, transferables: Transferable[] = []) {
    return new Promise((resolve, reject) => {
      try {
        request.id = nonce();
        this.requests.set(request.id, { resolve, reject });
        endpoint.postMessage(request, transferables);
      } catch(e) {
        this.requests.delete(request.id);
        reject(e);
      }
    });
  }

  private createLocalProxy(endpoint: Endpoint, path: (string | number)[] = [nonce()]) {
    // Set up local (non-proxied) symbol methods.
    let proxy;
    const id = path[0] as string;
    const target = () => {};
    if (path.length === 1) {
      target[Proximate.RELEASE] = () => {
        // Remove the entry for this proxy.
        this.trackedProxies.delete(proxy);
        const proxiesForId = this.mapIdToProxies.get(id);
        const deleted = proxiesForId?.delete(proxy);
        if (proxiesForId?.size === 0) {
          this.mapIdToProxies.delete(id);
        }

        // Tell the remote endpoint to update the receiver ref count.
        return deleted ?
          this.sendRequest(endpoint, { path, release: new Map([[id, 1]]) }) :
          Promise.resolve();
      };
      target[Proximate.LINK] = this;
    }

    proxy = new Proxy(target, {
      get: (target, property) => {
        if (typeof property === 'symbol') return target[property];
        if (!this.mapIdToProxies.get(id)?.has(proxy)) return Promise.reject(Error('invalid proxy'));
        if (property === 'then') {
          if (path.length === 1) return { then: (f) => f(proxy) };
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
        if (!this.mapIdToProxies.get(id)?.has(proxy)) throw Error('invalid proxy');
        const [wireValue, transferables] = this.serialize(value);
        this.sendRequest(endpoint, {
          path: [...path, property],
          value: wireValue
        }, transferables);
        return true;
      },

      apply: (_target, _, args: any[]) => {
        if (!this.mapIdToProxies.get(id)?.has(proxy)) return Promise.reject(Error('invalid proxy'));
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
    if (!this.mapIdToProxies.has(id)) {
      this.mapIdToProxies.set(id, new Set());
    }
    const proxiesForId = this.mapIdToProxies.get(id);
    proxiesForId.add(proxy);
    this.mapIdToProxies.set(id, proxiesForId);

    // Add created proxies in another container to track from a
    // specific point in time. The primary proxy is not included.
    id && this.trackedProxies.add(proxy);
    return proxy;
  }

  // Helper function to convert the one-to-many mapping of ids to proxies
  // into a map of reference counts for the remote endpoint to reclaim
  // resources on close.
  private proxyCounts() {
    const result = new Map<string, number>();
    for (const [key, value] of this.mapIdToProxies.entries()) {
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

  // Initiate release of all local and remote proxies.
  public async close() {
    const listener = this.listener;
    this.listener = null;
    if (!listener) return;

    // Send a close request with the unreleased proxy counts.
    const remoteProxies = await this.sendRequest(this.endpoint, {
      path: [''],
      close: this.proxyCounts()
    }) as Map<string, number>;
    this.mapIdToProxies.clear();
    this.trackedProxies.clear();

    // We get back the unreleased proxy counts from the other
    // endpoint.
    this.decReceiverRef(remoteProxies);

    // Close the connection.
    this.endpoint.removeEventListener('message', listener);
    this.endpoint.close?.();
  }

  // Release proxies from a specific point in time. The beginning point
  // is marked with track() and proxies are released with releaseTracked().
  public track() {
    this.trackedProxies.clear();
  };
  public async releaseTracked() {
    const releases = [];
    for (const trackedProxy of this.trackedProxies.values()) {
      releases.push(trackedProxy[Proximate.RELEASE]());
    };
    this.trackedProxies.clear();
    await Promise.all(releases);
  };

  // Add entries to these maps to customize serialization, generally
  // either to pass by proxy or to specify transferables. Registered
  // protocols must have the same key at both endpoints of a connection.
  // Both per-connection and global specification are available.
  public protocols = new Map<string, Protocol<unknown>>();
  public static protocols = new Map<string, Protocol<unknown>>();

  // Wrap a MessagePort-like endpoint with a proxy.
  public static wrap(endpoint: Endpoint, receiver?: any) {
    const instance = new Proximate(endpoint);
    if (receiver) {
      // Operations on the remote endpoint's primary proxy will
      // be passed to this receiver object.
      instance.defaultId = instance.incReceiverRef(receiver);
    }

    // Create the primary proxy.
    return instance.createLocalProxy(endpoint, ['']);
  }

  // This key accesses a proxy member function that releases the
  // resources used by the proxy. The proxy subsequently should not
  // be used, except for LINK access.
  public static RELEASE = Symbol('release');

  // The key accesses the Proximate instance for a proxy.
  public static LINK = Symbol('link');

  // Wrap a Window with the MessagePort interface. To listen to
  // an iframe element, use portify(element.contentWindow).
  // Inside the iframe, use portify(window.parent).
  public static portify(window: any, eventSource: any = self, targetOrigin = '*') {
    return {
      postMessage(message: object, transferables: Transferable[]) {
        window.postMessage(message, targetOrigin, transferables);
      },
      
      addEventListener: eventSource.addEventListener.bind(eventSource),
      removeEventListener: eventSource.removeEventListener.bind(eventSource)
    };
  }
}