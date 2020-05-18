import { Proximate, ProxyProtocol } from '../dist/es/Proximate.js';

describe('Proximate.wrap()', function() {
  let port1, port2;
  beforeEach(() => {
    ({ port1, port2 } = new MessageChannel());
  });

  afterEach(() => {
    port1.close();
    port2.close();
  });

  it('should work with a function', async () => {
    const objectUnderTest = Proximate.wrap(port1, value => value);
    const proxy = Proximate.wrap(port2);

    expect(await proxy(42)).toBe(42);
    await proxy[Proximate.LINK].close();
  });

  it('should work with an object member variable', async () => {
    const objectUnderTest = Proximate.wrap(port1, { foo: 'bar' });
    const proxy = Proximate.wrap(port2);

    expect(await proxy.foo).toBe('bar');
    await proxy[Proximate.LINK].close();
  });

  it('should work with an object member function', async () => {
    const objectUnderTest = Proximate.wrap(port1, { foo: value => value });
    const proxy = Proximate.wrap(port2);

    expect(await proxy.foo('bar')).toBe('bar');
    await proxy[Proximate.LINK].close();
  });
});

describe('Marshalling', function() {
  let port1, port2;
  beforeEach(() => {
    ({ port1, port2 } = new MessageChannel());
  });

  afterEach(() => {
    port1.close();
    port2.close();
  });

  // All these tests pass a value in as an argument and get it back
  // as a result.

  fit('should pass primitives', async () => {
    const objectUnderTest = Proximate.wrap(port1, value => value);
    const proxy = Proximate.wrap(port2);

    expect(await proxy(null)).toBe(null);
    expect(await proxy(undefined)).toBe(undefined);
    expect(await proxy(false)).toBe(false);
    expect(await proxy(123)).toBe(123);
    expect(await proxy('foobar')).toBe('foobar');
    await expectAsync(proxy(Symbol("won't work"))).toBeRejected();
    await proxy[Proximate.LINK].close();
  });

  it('should pass arrays', async () => {
    const objectUnderTest = Proximate.wrap(port1, value => value);
    const proxy = Proximate.wrap(port2);

    expect(await proxy([])).toEqual([]);
    expect(await proxy([1])).toEqual([1]);
    expect(await proxy([1, 2, {}])).toEqual([1, 2, {}]);
    await proxy[Proximate.LINK].close();
  });

  it('should pass objects', async () => {
    const objectUnderTest = Proximate.wrap(port1, value => value);
    const proxy = Proximate.wrap(port2);

    expect(await proxy({})).toEqual({});
    expect(await proxy({ foo: 'bar' })).toEqual({ foo: 'bar' });
    expect(await proxy({ foo: { bar: 'baz' } })).toEqual({ foo: { bar: 'baz' } });
    await proxy[Proximate.LINK].close();
  });

  it("should pass Error", async () => {
    const objectUnderTest = Proximate.wrap(port1, value => value);
    const proxy = Proximate.wrap(port2);

    let error;
    try {
      error();
    } catch(e) {
      error = e;
    }
    expect(error instanceof Error).toBe(true);
    expect(await proxy(error)).toEqual(error);
    await proxy[Proximate.LINK].close();
  });

  it('should pass transferables', async () => {
    const objectUnderTest = Proximate.wrap(port1, value => value);
    const proxy = Proximate.wrap(port2);

    Proximate.protocols.set('Int8Array', {
      canHandle(data) {
        return data instanceof Int8Array;
      },
      serialize(data) {
        return [data, [data.buffer]];
      },
      deserialize(data) {
        return data;
      }
    })

    const iArrayX = Int8Array.from([1, 2, 3]);
    const iArrayY = await proxy(iArrayX);
    expect(iArrayX).not.toBe(iArrayY);
    expect(iArrayX.length).toBe(0);
    expect([...iArrayY]).toEqual([1, 2, 3]);
    Proximate.protocols.delete('Int8Array');
    await proxy[Proximate.LINK].close();
  });

  it('should pass proxies', async () => {
    class FunctionProtocol extends ProxyProtocol {
      canHandle(data) {
        return typeof data === 'function';
      }
    }
    Proximate.protocols.set('function', new FunctionProtocol());

    const objectUnderTest = Proximate.wrap(port1, value => value);
    const proxy = Proximate.wrap(port2);

    const f = () => 91;
    const functionProxy = await proxy(f);
    expect(await functionProxy()).toEqual(f());

    Proximate.protocols.delete('function');
    await proxy[Proximate.LINK].close();
  });
});

describe('Object member access', function() {
  let port1, port2;
  beforeEach(() => {
    ({ port1, port2 } = new MessageChannel());
  });

  afterEach(() => {
    port1.close();
    port2.close();
  });

  it('should get', async () => {
    const obj = {
      value: 42,
      foo: {
        bar: 'baz'
      }
    };
    const objectUnderTest = Proximate.wrap(port1, obj);
    const proxy = Proximate.wrap(port2);

    expect(await proxy.value).toBe(obj.value);
    expect(await proxy.foo.bar).toBe(obj.foo.bar);
    await proxy[Proximate.LINK].close();
  });

  it('should set', async () => {
    const obj = {
      value: 42,
      foo: {
        bar: 'baz'
      }
    };
    const objectUnderTest = Proximate.wrap(port1, obj);
    const proxy = Proximate.wrap(port2);

    proxy.value = 21;
    expect(await proxy.value).toBe(obj.value);
    expect(obj.value).toBe(21);

    proxy.foo = { x: 'different' };
    expect(await proxy.foo.x).toBe(obj.foo.x);
    expect(obj.foo.x).toBe('different');

    proxy.bar = 'baz';
    expect(await proxy.bar).toBe(obj.bar);
    expect(obj.bar).toBe('baz');
    await proxy[Proximate.LINK].close();
  });
});

describe('release', function() {
  let port1, port2;
  beforeEach(() => {
    ({ port1, port2 } = new MessageChannel());
  });

  afterEach(() => {
    port1.close();
    port2.close();
  });

  it('should work', async () => {
    const f = () => 42;
    const objectUnderTest = Proximate.wrap(port1, f);
    const proxy = Proximate.wrap(port2);

    // Verify that initially the proxy works.
    const id = Proximate.mapObjectToId.get(f);
    await expectAsync(proxy()).toBeResolvedTo(f());
    expect(proxy[Proximate.LINK].mapIdToProxies.size).toBeGreaterThan(0)
    expect(Proximate.mapIdToObject.get(id)).toBeDefined();

    await proxy[Proximate.RELEASE]();

    // Verify the proxy no longer works.
    await expectAsync(proxy()).toBeRejected();

    // Verify the internal mappings are gone.
    expect(proxy[Proximate.LINK].mapIdToProxies.size).toBe(0)
    expect(Proximate.mapIdToObject.get(id)).not.toBeDefined();
    expect(Proximate.mapObjectToId.get(f)).not.toBeDefined();
    await proxy[Proximate.LINK].close();
  });
});

describe('tracking', function() {
  let port1, port2;
  beforeEach(() => {
    ({ port1, port2 } = new MessageChannel());
  });

  afterEach(() => {
    port1.close();
    port2.close();
  });

  it('RELEASE_TRACKED should not release the primary', async () => {
    class FunctionProtocol extends ProxyProtocol {
      canHandle(data) {
        return typeof data === 'function';
      }
    }
    Proximate.protocols.set('function', new FunctionProtocol());

    function f() {
      return 'foo';
    }

    const objectUnderTest = Proximate.wrap(port1, () => f);
    const proxy = Proximate.wrap(port2);

    await proxy[Proximate.LINK].releaseTracked();
    await expectAsync(proxy()).toBeResolved();

    Proximate.protocols.delete('function');
    await proxy[Proximate.LINK].close();
  });

  it('RELEASE_TRACKED should release after TRACK', async () => {
    class FunctionProtocol extends ProxyProtocol {
      canHandle(data) {
        return typeof data === 'function';
      }
    }
    Proximate.protocols.set('function', new FunctionProtocol());

    function f() {
      return 'foo';
    }

    const objectUnderTest = Proximate.wrap(port1, () => f);
    const proxy = Proximate.wrap(port2);

    const proxyFuncA = await proxy();
    proxy[Proximate.LINK].track();
    const proxyFuncB = await proxy();

    await expectAsync(proxyFuncA()).toBeResolvedTo(f());
    await expectAsync(proxyFuncB()).toBeResolvedTo(f());

    await proxy[Proximate.LINK].releaseTracked();

    await expectAsync(proxyFuncA()).toBeResolvedTo(f());
    await expectAsync(proxyFuncB()).toBeRejected();

    await proxy[Proximate.LINK].close();
  });
});

describe('portify()', function() {
  it('outside in should work', async () => {
    let iframe = await new Promise(resolve => {
      let iframe = document.createElement('iframe');
      iframe.onload = () => resolve(iframe);
      iframe.srcdoc = `<script type="module">
        import { Proximate } from '/dist/es/Proximate.js';
        Proximate.wrap(Proximate.portify(window.parent), (value) => value);
      </script>`;
      document.body.appendChild(iframe);
    });

    const proxy = Proximate.wrap(Proximate.portify(iframe.contentWindow));
    const data = 'Four score';
    expect(await proxy(data)).toBe(data);
    await proxy[Proximate.LINK].close();
    iframe.remove();
  });

  it('inside out should work', async () => {
    let iframe = document.createElement('iframe');
    iframe.srcdoc = `<script type="module">
      import { Proximate } from '/dist/es/Proximate.js';
      const proxy = Proximate.wrap(Proximate.portify(window.parent), (value) => value);
      proxy('Lorem ipsum');
    </script>`;
    document.body.appendChild(iframe);

    let proxy;
    const p = new Promise(resolve => {
      proxy = Proximate.wrap(Proximate.portify(iframe.contentWindow), resolve);
    });

    expect(await p).toBe('Lorem ipsum');
    await proxy[Proximate.LINK].close();
    iframe.remove();
  });
});
