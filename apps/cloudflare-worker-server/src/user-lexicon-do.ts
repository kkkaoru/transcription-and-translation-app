/**
 * SQLite Durable Object wrapper. Logic lives in user-lexicon-sql.ts.
 *
 * This file runs with bun.
 */

import { DurableObject } from "cloudflare:workers";
import type { UserLexiconRpc } from "@caption-bridge/inference-server-core";
import { createSqlBackedUserLexicon } from "./user-lexicon-sql.js";

export interface UserLexiconDoEnv {
  USER_LEXICON?: unknown;
}

export class UserLexiconDO extends DurableObject<UserLexiconDoEnv> implements UserLexiconRpc {
  readonly #rpc: UserLexiconRpc;

  public constructor(ctx: DurableObjectState, env: UserLexiconDoEnv) {
    super(ctx, env);
    this.#rpc = createSqlBackedUserLexicon(ctx);
  }

  public meta() {
    return this.#rpc.meta();
  }

  public snapshotTsv() {
    return this.#rpc.snapshotTsv();
  }

  public snapshotCompact() {
    return this.#rpc.snapshotCompact();
  }

  public exportAll() {
    return this.#rpc.exportAll();
  }

  public restore(snapshot: Parameters<UserLexiconRpc["restore"]>[0]) {
    return this.#rpc.restore(snapshot);
  }

  public search(query: Parameters<UserLexiconRpc["search"]>[0]) {
    return this.#rpc.search(query);
  }

  public upsert(entry: Parameters<UserLexiconRpc["upsert"]>[0]) {
    return this.#rpc.upsert(entry);
  }

  public update(id: string, fields: Parameters<UserLexiconRpc["update"]>[1]) {
    return this.#rpc.update(id, fields);
  }

  public remove(id: string) {
    return this.#rpc.remove(id);
  }

  public replaceAll(entries: Parameters<UserLexiconRpc["replaceAll"]>[0]) {
    return this.#rpc.replaceAll(entries);
  }

  public clear() {
    return this.#rpc.clear();
  }

  public listDictionaries() {
    return this.#rpc.listDictionaries();
  }

  public createDictionary(name: string) {
    return this.#rpc.createDictionary(name);
  }

  public renameDictionary(id: string, name: string) {
    return this.#rpc.renameDictionary(id, name);
  }

  public deleteDictionary(id: string) {
    return this.#rpc.deleteDictionary(id);
  }

  public activateDictionary(id: string) {
    return this.#rpc.activateDictionary(id);
  }

  public startImport(input: Parameters<UserLexiconRpc["startImport"]>[0]) {
    return this.#rpc.startImport(input);
  }

  public importStatus(importId: string) {
    return this.#rpc.importStatus(importId);
  }

  public processQueuedImport(importId: string) {
    return this.#rpc.processQueuedImport(importId);
  }
}
