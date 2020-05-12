import Proximate from '../dist/es/Proximate.js';

describe('Proximate.create()', function() {
  let port1, port2;
  beforeEach(() => {
    const channel = new MessageChannel();
    port1 = channel.port1;
    port2 = channel.port2;
  });

  afterEach(() => {
    port1.close();
    port2.close();
  });

  it('should work with a function', async () => {
    const objectUnderTest = Proximate.create(port1, { target: value => value });
    
    const proxy = Proximate.create(port2);
    const value = 17;
    const result = await proxy(value);
    expect(result).toBe(value);
  });

  it('should work with an object', async () => {
    const objectUnderTest = Proximate.create(port1, {
      target: {
        foo: value => value
      }
    });

    const proxy = Proximate.create(port2);
    const value = 'how now brown cow';
    const result = await proxy.foo(value);
    expect(result).toBe(value);
  });
});

describe('Proximate marshalling', function() {
  let port1, port2;
  beforeEach(() => {
    const channel = new MessageChannel();
    port1 = channel.port1;
    port2 = channel.port2;
  });

  afterEach(() => {
    port1.close();
    port2.close();
  });

  it('should pass primitives', async () => {
    const objectUnderTest = Proximate.create(port1, { target: value => value });

    const proxy = Proximate.create(port2);
    expect(await proxy(null)).toBe(null);
    expect(await proxy(undefined)).toBe(undefined);
    expect(await proxy(false)).toBe(false);
    expect(await proxy(123)).toBe(123);
    expect(await proxy('foobar')).toBe('foobar');
  });

  it('should pass arrays', async () => {
    const objectUnderTest = Proximate.create(port1, { target: value => value });

    const proxy = Proximate.create(port2);
    expect(await proxy([])).toEqual([]);
    expect(await proxy([1])).toEqual([1]);
    expect(await proxy([1, 2, {}])).toEqual([1, 2, {}]);
  });

  it('should pass objects', async () => {
    const objectUnderTest = Proximate.create(port1, { target: value => value });

    const proxy = Proximate.create(port2);
    expect(await proxy({})).toEqual({});
    expect(await proxy({ foo: 'bar' })).toEqual({ foo: 'bar' });
    expect(await proxy({ foo: { bar: 'baz' } })).toEqual({ foo: { bar: 'baz' } });
  });

  it('should pass proxies', async () => {
    const objectUnderTest = Proximate.create(port1, { target: value => value });
    
    const proxy = Proximate.create(port2);
    
    const f = () => 91;
    const functionProxy = await proxy(Proximate.enableProxy(f));
    expect(await functionProxy()).toEqual(f());

    const o = {
      value: 10,
      f() {
        return this.value;
      }
    };
    const objectProxy = await proxy(Proximate.enableProxy(o));
    expect(await objectProxy.value).toBe(o.value);
    expect(await objectProxy.f()).toEqual(o.f());
  });

  it('should pass proxies with passByProxy', async () => {
    const objectUnderTest = Proximate.create(port1, { target: value => value });
    
    const proxy = Proximate.create(port2, {
      passByProxy: (obj) => true
    });
    
    const f = () => 91;
    const functionProxy = await proxy(f);
    expect(await functionProxy()).toEqual(f());

    const o = {
      value: 10,
      f() {
        return this.value;
      }
    };
    const objectProxy = await proxy(o);
    expect(await objectProxy.value).toBe(o.value);
    expect(await objectProxy.f()).toEqual(o.f());
  });

  it("should pass Error", async () => {
    const objectUnderTest = Proximate.create(port1, { target: value => value });

    const proxy = Proximate.create(port2);
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
    const objectUnderTest = Proximate.create(port1, {
      target: value => Proximate.transfer(value, [value])
    });

    const proxy = Proximate.create(port2);

    const iArrayX = Int8Array.from([1, 2, 3]);
    const buffer = await proxy(Proximate.transfer(iArrayX.buffer, [iArrayX.buffer]));
    expect(iArrayX.length).toBe(0);
    
    const iArrayY = new Int8Array(buffer);
    expect([...iArrayY]).toEqual([1, 2, 3]);
  });
});

describe('Proximate member access', function() {
  let port1, port2;
  beforeEach(() => {
    const channel = new MessageChannel();
    port1 = channel.port1;
    port2 = channel.port2;
  });

  afterEach(() => {
    port1.close();
    port2.close();
  });

  it('should get', async () => {
    const objectUnderTest = Proximate.create(port1, { target: value => value });
    
    const proxy = Proximate.create(port2);
    
    const o = {
      value: 10,
    };
    const objectProxy = await proxy(Proximate.enableProxy(o));
    expect(await objectProxy.value).toBe(o.value);
  });

  it('should not set by default', async () => {
    const o = {
      value: 1
    };
    const objectUnderTest = Proximate.create(port1, { target: o });
    const proxy = Proximate.create(port2);

    proxy.value = 4321;
    expect(await proxy.value).toBe(1);
    expect(o.value).toBe(1);
  });

  it('should set with settable', async () => {
    const o = Proximate.settable({
      value: 1
    });
    const objectUnderTest = Proximate.create(port1, { target: o });
    const proxy = Proximate.create(port2);

    proxy.value = 4321;
    expect(await proxy.value).toBe(4321);
    expect(o.value).toBe(4321);
  });

  it('should support multi-level', async() => {
    const o = Proximate.settable({
    });
    const objectUnderTest = Proximate.create(port1, { target: o });
    const proxy = Proximate.create(port2);
    
    proxy.sub = { a: 42 };
    expect(await proxy.sub.a).toBe(42);
    expect(o.sub.a).toBe(42);

    proxy.sub.b = 54;
    expect(await proxy.sub.b).toBe(54);
    expect(o.sub.b).toBe(54);
  });
});

describe('Proximate.revokeProxies()', function() {
  let port1, port2;
  beforeEach(() => {
    const channel = new MessageChannel();
    port1 = channel.port1;
    port2 = channel.port2;
  });

  afterEach(() => {
    port1.close();
    port2.close();
  });

  it('should work', async () => {
    let functionProxies = [];
    const objectUnderTest = Proximate.create(port1, {
      target: f => functionProxies.push(f)
    });

    const proxy = Proximate.create(port2);

    const f = Proximate.enableProxy(() => 32);
    await proxy(f);
    await expectAsync(functionProxies[0]()).toBeResolvedTo(f());

    Proximate.revokeProxies(f);
    await proxy(f);
    
    await expectAsync(functionProxies[0]()).toBeRejected();
    await expectAsync(functionProxies[1]()).toBeResolvedTo(f());
  });
});

describe('Proximate.portify()', function() {
  it('should work', async () => {
    let iframe = await new Promise(resolve => {
      let iframe = document.createElement('iframe');
      iframe.onload = () => resolve(iframe);
      iframe.srcdoc = `<script type="module">
        import Proximate from '/dist/es/Proximate.js';
        Proximate.create(Proximate.portify(window.parent), { target: (value) => value });
      </script>`;
      document.body.appendChild(iframe);
    });

    const proxy = Proximate.create(Proximate.portify(iframe.contentWindow));
    const data = 'Lorem ipsum';
    expect(await proxy(data)).toBe(data);
    proxy[Proximate.close]();
    iframe.remove();
  });
});
