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
    const objectUnderTest = Proximate.wrap(port1, {
      receiver: value => value
    });
    const proxy = Proximate.wrap(port2);

    expect(await proxy(42)).toBe(42);
  });

  it('should work with an object member variable', async () => {
    const objectUnderTest = Proximate.wrap(port1, {
      receiver: { foo: 'bar' }
    });
    const proxy = Proximate.wrap(port2);

    expect(await proxy.foo).toBe('bar');
  });

  it('should work with an object member function', async () => {
    const objectUnderTest = Proximate.wrap(port1, {
      receiver: { foo: value => value }
    });
    const proxy = Proximate.wrap(port2);

    expect(await proxy.foo('bar')).toBe('bar');
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

  it('should pass primitives', async () => {
    const objectUnderTest = Proximate.wrap(port1, {
      receiver: value => value
    });
    const proxy = Proximate.wrap(port2);

    expect(await proxy(null)).toBe(null);
    expect(await proxy(undefined)).toBe(undefined);
    expect(await proxy(false)).toBe(false);
    expect(await proxy(123)).toBe(123);
    expect(await proxy('foobar')).toBe('foobar');
  });

  it('should pass arrays', async () => {
    const objectUnderTest = Proximate.wrap(port1, {
      receiver: value => value
    });
    const proxy = Proximate.wrap(port2);

    expect(await proxy([])).toEqual([]);
    expect(await proxy([1])).toEqual([1]);
    expect(await proxy([1, 2, {}])).toEqual([1, 2, {}]);
  });

  it('should pass objects', async () => {
    const objectUnderTest = Proximate.wrap(port1, {
      receiver: value => value
    });
    const proxy = Proximate.wrap(port2);

    expect(await proxy({})).toEqual({});
    expect(await proxy({ foo: 'bar' })).toEqual({ foo: 'bar' });
    expect(await proxy({ foo: { bar: 'baz' } })).toEqual({ foo: { bar: 'baz' } });
  });

  it("should pass Error", async () => {
    const objectUnderTest = Proximate.wrap(port1, {
      receiver: value => value,
      debug: 'receiver'
    });
    const proxy = Proximate.wrap(port2, { debug: 'proxy' });

    let error;
    try {
      error();
    } catch(e) {
      error = e;
    }
    expect(error instanceof Error).toBe(true);
    expect(await proxy(error)).toEqual(error);
  });

  it('should pass transferables', async () => {
    const objectUnderTest = Proximate.wrap(port1, {
      receiver: value => value,
      debug: 'receiver'
    });
    const proxy = Proximate.wrap(port2, { debug: 'proxy' });

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
  });

  it('should pass proxies', async () => {
    const objectUnderTest = Proximate.wrap(port1, {
      receiver: value => value,
      debug: 'receiver'
    });
    const proxy = Proximate.wrap(port2, { debug: 'proxy' });

    class FunctionProtocol extends ProxyProtocol {
      canHandle(data) {
        return typeof data === 'function';
      }
    }
    Proximate.protocols.set('function', new FunctionProtocol());

    const f = () => 91;
    const functionProxy = await proxy(f);
    expect(await functionProxy()).toEqual(f());
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
    const objectUnderTest = Proximate.wrap(port1, {
      receiver: obj,
      debug: 'receiver'
    });
    const proxy = Proximate.wrap(port2, { debug: 'proxy' });

    expect(await proxy.value).toBe(obj.value);
    expect(await proxy.foo.bar).toBe(obj.foo.bar);
  });

  it('should set', async () => {
    const obj = {
      value: 42,
      foo: {
        bar: 'baz'
      }
    };
    const objectUnderTest = Proximate.wrap(port1, {
      receiver: obj,
      debug: 'receiver'
    });
    const proxy = Proximate.wrap(port2, { debug: 'proxy' });

    proxy.value = 21;
    expect(await proxy.value).toBe(obj.value);
    expect(obj.value).toBe(21);

    proxy.foo = { x: 'different' };
    expect(await proxy.foo.x).toBe(obj.foo.x);
    expect(obj.foo.x).toBe('different');

    proxy.bar = 'baz';
    expect(await proxy.bar).toBe(obj.bar);
    expect(obj.bar).toBe('baz');
  });
});

describe('revokeProxies()', function() {
  let port1, port2;
  beforeEach(() => {
    ({ port1, port2 } = new MessageChannel());
  });

  afterEach(() => {
    port1.close();
    port2.close();
  });

  it('revokeProxies() should work', async () => {
    const f = () => 42;
    const objectUnderTest = Proximate.wrap(port1, {
      receiver: f,
      debug: 'receiver'
    });
    const proxy = Proximate.wrap(port2, { debug: 'proxy' });

    expect(await proxy()).toBe(f());

    Proximate.revokeProxies(f);
    await expectAsync(proxy()).toBeRejected();
  });
});

describe('portify()', function() {
  it('outside in should work', async () => {
    let iframe = await new Promise(resolve => {
      let iframe = document.createElement('iframe');
      iframe.onload = () => resolve(iframe);
      iframe.srcdoc = `<script type="module">
        import { Proximate } from '/dist/es/Proximate.js';
        Proximate.wrap(Proximate.portify(window.parent), {
          receiver: (value) => value,
          debug: 'iframe'
        });
      </script>`;
      document.body.appendChild(iframe);
    });

    const proxy = Proximate.wrap(Proximate.portify(iframe.contentWindow), {
      debug: 'main'
    });
    const data = 'Lorem ipsum';
    expect(await proxy(data)).toBe(data);
    iframe.remove();
  });

  it('inside out should work', async () => {
    let iframe = document.createElement('iframe');
    iframe.srcdoc = `<script type="module">
      import { Proximate } from '/dist/es/Proximate.js';
      const proxy = Proximate.wrap(Proximate.portify(window.parent), {
        receiver: (value) => value,
        debug: 'iframe'
      });
      proxy('Lorem ipsum');
    </script>`;
    document.body.appendChild(iframe);

    const p = new Promise(resolve => {
      Proximate.wrap(Proximate.portify(iframe.contentWindow), {
        receiver: resolve,
        debug: 'main'
      });
    });

    expect(await p).toBe('Lorem ipsum');
    iframe.remove();
  });
});
