const RELAY_MARKER = Symbol('relay');
const PROXY_MARKER = Symbol('proxy');
const CLOSE_METHOD = Symbol('close');
const DEBUG_METHOD = Symbol('debug');

// Message object keys. We make the keys as short as possible to
// minimize message size.
const NONCE = 'n'; // Unique identifier to match requests and responses.
const ARGS = 'a';  // Array of serialized function arguments.
const RESULT = 'r';// Serialized result.
const ERROR = 'e'; // Serialized Error instance.
const PROXY = 'p'; // Array of strings at top level. Also used for serialization.
const DATA = 'd';  // Not a top-level key, only used for serialization.

// Global mapping of proxy id to local object. When a proxy for an
// object is sent to another endpoint, we give it an id (a nonce) and
// send that over the wire. When the other endpoint uses the proxy, it
// sends the id back and we use this map to retrieve the object.
const proxies = new Map<string, any>();

// Object to transferables mapping from Proximate.transfer().
const transfers = new Map<any, Transferable[]>();

// Request nonce to Promise resolve/reject mapping. When an outgoing
// request is made, resolve/reject from its Promise are stored here
// so they can be found when the response arrives.
const requests = new Map<string, { resolve: (x: any) => void, reject: (x: Error) => void }>();

// Generate a string "nonce". Each character has slightly more than 5
// bits of entropy so 24 characters is about 124 bits. Not absolutely
// guaranteed unique, but good enough.
function nonce(length = 24): string {
  let value = '';
  while (value.length < length) {
    value += Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
  }
  return value.substring(0, length);
}

// MessageChannel communications wrapper. Only the static functions on
// this class are used for the public API. Class instances are only
// used internally.
export default class Proximate {
  static close = CLOSE_METHOD;
  static debug = DEBUG_METHOD;

  private messagePort: MessagePort;
  private defaultProxyId: string = nonce();
  private debug: any;

  private constructor(messagePort: MessagePort) {
    if (messagePort[RELAY_MARKER]) throw new Error('MessagePort in use');
    messagePort[RELAY_MARKER] = this.handleMessage.bind(this);
    messagePort.addEventListener('message', messagePort[RELAY_MARKER]);
    messagePort.start && messagePort.start();
    this.messagePort = messagePort;
  }

  private handleMessage(event: MessageEvent): void {
    if (this.debug) console.debug(this.debug, event.data);
    
    const message = event.data;
    if (this.isRequest(message)) {
      this.handleRequest(message);
    } else if (this.isResponse(message)) {
      this.handleResponse(message);
    } else {
      console.debug('ignored message', message);
    }
  }

  private isRequest(message: object) {
    return message.hasOwnProperty(NONCE) && message.hasOwnProperty(PROXY);
  }

  private async handleRequest(message: object): Promise<void> {
    const response = { [NONCE]: message[NONCE] };
    let transferList = [];
    try {
      // The target is an array of strings where the first element is
      // the proxy id and the last element (if any) is the method
      // name. An empty string proxy id maps to the default proxy.
      const path = message[PROXY].slice();
      let receiver = proxies.get(path.shift() || this.defaultProxyId);
      if (!receiver) throw new Error(`no proxy '${message[PROXY][0]}' (revoked?)`);
      const member = path.pop();

      // Dereference any remaining elements of the path to get the
      // direct receiver.
      receiver = path.reduce((obj, property) => obj[property], receiver);

      let result: any;
      if (message.hasOwnProperty(ARGS)) {
        // Function call.
        const f = member ? receiver[member] : receiver;
        const args = message[ARGS].map(arg => this.deserialize(arg));
        result = await f.apply(receiver, args);
      } else {
        // Member access.
        if (message.hasOwnProperty(DATA)) {
          // Setter disabled for security reasons. Setters can
          // be dangerous when communicating with untrusted code.
          throw new Error('Proximate setter intentionally unsupported');
          
          // receiver[member] = this._deserialize(message[DATA]);
        } else {
          result = await receiver[member];
        }
      }

      // Collect any associated Transferable objects.
      transferList = transfers.get(result) || [];
      transfers.delete(result);
      response[RESULT] = this.serialize(result);
    } catch (e) {
      transferList = transfers.get(e) || [];
      transfers.delete(e);
      response[ERROR] = this.serialize(e);
    }

    this.messagePort.postMessage(response, transferList);
  }
  
  private isResponse(message: object) {
    return message.hasOwnProperty(NONCE) &&
      (message.hasOwnProperty(RESULT) || message.hasOwnProperty(ERROR));
  }

  private handleResponse(message: object): void {
    // Use the nonce to look up the request Promise functions (the
    // response nonce is the same as the request nonce).
    const request = requests.get(message[NONCE]);
    if (request) {
      // Fulfil the request Promise.
      requests.delete(message[NONCE]);
      if (message.hasOwnProperty(RESULT)) {
        const result = this.deserialize(message[RESULT]);
        request.resolve(result);
      } else {
        const error = this.deserialize(message[ERROR]);
        request.reject(error);
      }
    } else {
      console.warn(`unmatched response '${message[NONCE]}'`);
    }
  }
  
  // Serialize a single argument or a return value. Objects are wrapped
  // because some will be sent by proxy.
  private serialize(data: any) {
    if (data === Object(data)) {
      const proxyId = data[PROXY_MARKER];
      if (proxyId) {
        proxies.set(proxyId, data);
        return { [PROXY]: proxyId };
      } else if (data instanceof Error) {
        return {
          [ERROR]: {
            message: data.message,
            stack: data.stack
          }
        };
      }
      return { [DATA]: data };
    }
    return data;
  }

  // Deserialize a single argument or a return value.
  private deserialize(data: any) {
    if (data === Object(data)) {
      if (data[PROXY]) {
        return this.createProxy([data[PROXY]]);
      } else if (data[ERROR]) {
        return Object.assign(new Error(), data[ERROR]);
      }
      return data[DATA];
    }
    return data;
  }

  // Create an ES6 Proxy to handle member get and function and method calls.
  // Member set is not supported for safety. Other intercepts are not
  // supported out of laziness. The first element of the path is the
  // proxyId, which is the empty string for the default Proximate proxy.
  // Otherwise it is the nonce attached by Proximate.enableProxy().
  private createProxy(path: (string|number|symbol)[], obj: any = function() {}) {
    // A Proxy can only be passed by proxy so mark it.
    obj[PROXY_MARKER] = nonce();
    const proxy = new Proxy(obj, {
      apply: (target, _, args: any[]) => {
        const transferables = args.flatMap(arg => {
          const result = transfers.get(arg) || [];
          transfers.delete(arg);
          return result;
        });
        const request = {
          [PROXY]: path,
          [ARGS]: args.map(arg => this.serialize(arg))
        };
        return this.sendRequest(request, transferables);
      },
      
      get: (target, property, _) => {
        if (property in target) return target[property];
        if (property === 'then') {
          if (path.length === 1) return { then: () => proxy };
          const request = {
            [PROXY]: path
          };
          const p = this.sendRequest(request);
          return p.then.bind(p);
        }
        return this.createProxy([...path, property], target);
      },

      set: (target, prop, value) => {
        throw new Error('setters are intentionally disabled');
      //   const transferList = transfers.get(value) || [];
      //   transfers.delete(value);
      //   const request = {
      //     [PROXY]: [...path, prop],
      //     [DATA]: this._serialize(value)
      //   };
      //   this._sendRequest(request);
      //   return true;
      }
    });
    return proxy;
  }

  private sendRequest(request: object, transferables: Transferable[] = []) {
    // Make the function/method call request. The Promise will be
    // settled when the response message arrives.
    return new Promise((resolve, reject) => {
      request[NONCE] = nonce();
      requests.set(request[NONCE], { resolve, reject });
      this.messagePort.postMessage(request, transferables);
    });
  };
  
  // Wrap a MessagePort with a Proxy and optionally provide an object
  // that can be called by proxy by the other endpoint.
  public static create(messagePort: MessagePort, obj: any = {}) {
    const relay = new Proximate(messagePort);
    proxies.set(relay.defaultProxyId, obj);

    // The ES6 Proxy we return must be created with a function target
    // in case the other endpoint provides a function to its
    // Proximate.create() invocation that we want to call.
    const target = function() {};
    target[CLOSE_METHOD] = () => {
      messagePort.removeEventListener('message', messagePort[RELAY_MARKER]);
      delete messagePort[RELAY_MARKER];
      messagePort.close && messagePort.close();
      proxies.delete(relay.defaultProxyId);
    };
    target[DEBUG_METHOD] = (label) => relay.debug = label;
    
    return relay.createProxy([''], target);
  }

  // Mark an object to be passed by proxy when sent as an argument or
  // return value.
  public static enableProxy(obj: any) {
    if (!obj[PROXY_MARKER]) {
      obj[PROXY_MARKER] = nonce();
    }
    return obj;
  }

  // Disassociate an object from its proxies. Making a call on any
  // previously sent proxy will reject the returned Promise.
  public static revokeProxies(obj: any) {
    proxies.delete(obj[PROXY_MARKER]);

    // If the object is sent by proxy in the future, don't allow
    // old proxies to work again.
    obj[PROXY_MARKER] = nonce();
    return obj;
  }

  // Associate any Transferable objects (e.g. ArrayBuffer,
  // MessagePort, ImageBitmap, OffscreenCanvase) in an object to be
  // sent as an argument or return value.
  public static transfer(obj: any, transferables: Transferable[]) {
    transfers.set(obj, transferables);
    return obj;
  }

  // Wrap a Window with the MessagePort interface. To listen to
  // an iframe element, use Proximate.portify(element.contentWindow).
  // Inside the iframe, use Proximate.portify(window.parent).
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