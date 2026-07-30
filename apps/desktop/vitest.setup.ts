class MemoryStorage implements Storage {
  #store = new Map<string, string>();

  get length(): number {
    return this.#store.size;
  }

  clear(): void {
    this.#store.clear();
  }

  getItem(key: string): string | null {
    return this.#store.has(key) ? (this.#store.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.#store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#store.set(String(key), String(value));
  }
}

const installStorage = (target: object, name: "localStorage" | "sessionStorage") => {
  const current = Reflect.get(target, name) as Storage | undefined;
  if (current && typeof current.clear === "function" && typeof current.setItem === "function") {
    return;
  }
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value: new MemoryStorage(),
    writable: true,
  });
};

installStorage(globalThis, "localStorage");
installStorage(globalThis, "sessionStorage");

if (typeof window !== "undefined") {
  installStorage(window, "localStorage");
  installStorage(window, "sessionStorage");
}
