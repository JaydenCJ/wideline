/**
 * The Wideline instance: the factory for events, the async context that
 * makes `current()` work anywhere in a request, and the place where a
 * finished event meets the sampler and the emitter. One instance per
 * service process is the intended shape.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as os from "node:os";
import { WideEvent } from "./event.js";
import { NdjsonEmitter } from "./emitter.js";
import {
  createMiddleware,
  wrapHandler,
  type ExpressMiddleware,
  type HttpHandler,
  type MiddlewareOptions,
  type RequestLike,
} from "./middleware.js";
import { createRedactor } from "./redact.js";
import { Sampler } from "./sampler.js";
import {
  DEFAULT_LIMITS,
  type Clock,
  type Diagnostics,
  type Emitter,
  type FieldValue,
  type Limits,
  type WidelineOptions,
} from "./types.js";

const defaultClock: Clock = { now: () => Date.now() };

/** Monotonic, sortable, collision-resistant-enough event ids. */
function defaultIdGenerator(clock: Clock, pid: number): () => string {
  let counter = 0;
  const prefix = ((clock.now() % 0xffffffff) ^ (pid * 2654435761)) >>> 0;
  return () => `${prefix.toString(36)}-${(++counter).toString(36).padStart(6, "0")}`;
}

export class Wideline {
  private readonly emitter: Emitter;
  private readonly sampler: Sampler;
  private readonly limits: Limits;
  private readonly clock: Clock;
  private readonly redactor: ReturnType<typeof createRedactor>;
  private readonly nextId: () => string;
  private readonly baseFields: Record<string, FieldValue>;
  private readonly als = new AsyncLocalStorage<WideEvent>();
  private readonly byRequest = new WeakMap<object, WideEvent>();
  private readonly counters: Diagnostics = {
    started: 0,
    emitted: 0,
    sampledOut: 0,
    lateCalls: 0,
    droppedFields: 0,
  };

  constructor(options: WidelineOptions) {
    if (!options || typeof options.service !== "string" || options.service.length === 0) {
      throw new TypeError("wideline: options.service (a non-empty string) is required");
    }
    this.emitter = options.emitter ?? new NdjsonEmitter();
    this.sampler = new Sampler(options.sample);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.clock = options.clock ?? defaultClock;
    this.redactor = createRedactor(options.redact);
    const pid = options.pid ?? process.pid;
    this.nextId = options.idGenerator ?? defaultIdGenerator(this.clock, pid);
    this.baseFields = {
      service: options.service,
      host: options.host ?? os.hostname(),
      pid,
    };
    if (options.version !== undefined) this.baseFields["service.version"] = options.version;
    if (options.env !== undefined) this.baseFields["env"] = options.env;
  }

  /**
   * Start a new wide event. The middleware calls this per request; call
   * it yourself for jobs, consumers, or anything else that deserves one
   * canonical line.
   */
  startEvent(initial?: Record<string, unknown>): WideEvent {
    this.counters.started += 1;
    const startedAt = this.clock.now();
    const event = new WideEvent({
      clock: this.clock,
      limits: this.limits,
      redact: this.redactor,
      onLateCall: () => {
        this.counters.lateCalls += 1;
      },
      onDroppedField: (n) => {
        this.counters.droppedFields += n;
      },
      baseFields: {
        ...this.baseFields,
        time: new Date(startedAt).toISOString(),
        "event.id": this.nextId(),
      },
      onFinish: (ev) => this.handleFinish(ev),
    });
    if (initial) event.set(initial);
    return event;
  }

  /** The wide event of the current async context, if any. */
  current(): WideEvent | undefined {
    return this.als.getStore();
  }

  /** Run `fn` with `event` as the current async context. */
  enter<R>(event: WideEvent | undefined, fn: () => R): R {
    if (!event) return fn();
    return this.als.run(event, fn);
  }

  /** The event started by the middleware for a given request object. */
  currentFor(req: RequestLike): WideEvent | undefined {
    return this.byRequest.get(req as object);
  }

  /** Internal: the middleware registers its event against the request. */
  register(req: RequestLike, event: WideEvent): void {
    this.byRequest.set(req as object, event);
  }

  /** Express-compatible middleware bound to this instance. */
  middleware(options?: MiddlewareOptions): ExpressMiddleware {
    return createMiddleware(this, options);
  }

  /** Wrap a plain `node:http` handler with instrumentation + error capture. */
  wrap(handler: HttpHandler, options?: MiddlewareOptions): HttpHandler {
    return wrapHandler(this, handler, options);
  }

  /**
   * Run a named unit of work (job, queue message, cron tick) under its
   * own wide event. Errors are recorded on the event, the event always
   * finishes, and the error is rethrown for the caller to handle.
   */
  async run<R>(name: string, fn: (event: WideEvent) => R | Promise<R>): Promise<R> {
    const event = this.startEvent({ "event.name": name });
    try {
      const result = await this.enter(event, () => fn(event));
      return result;
    } catch (err) {
      event.error(err);
      throw err;
    } finally {
      event.finish();
    }
  }

  /** Counters describing what this instance has done. */
  diagnostics(): Diagnostics {
    return { ...this.counters };
  }

  /** Internal: sampling decision + emit. Returns true if the event was kept. */
  private handleFinish(event: WideEvent): boolean {
    const fields = event.snapshot();
    const decision = this.sampler.decide(fields);
    if (!decision.kept) {
      this.counters.sampledOut += 1;
      return false;
    }
    fields["sample.rate"] = decision.weight;
    fields["sample.kept_by"] = decision.keptBy;
    this.emitter.emit(fields);
    this.counters.emitted += 1;
    return true;
  }
}
