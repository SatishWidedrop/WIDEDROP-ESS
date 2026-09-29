/**
 * A tiny, explicit state machine.
 *
 * Every workflow in the portal — payroll, attendance, leave, expenses,
 * policies, tickets, letters — declares its states and the transitions between
 * them here, once, and both the API and the UI read the same declaration. A
 * transition that is not listed cannot happen: there is no default "allow".
 */

export interface Transition<S extends string, E extends string> {
  from: S;
  to: S;
  /** The event that causes it, named for what the actor does. */
  event: E;
  /** Human-readable description, surfaced in the UI and in audit entries. */
  description: string;
}

export class StateMachine<S extends string, E extends string> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly S[];
  readonly transitions: readonly Transition<S, E>[];
  /** States from which nothing further can happen. */
  readonly terminal: ReadonlySet<S>;

  private readonly index: Map<string, Transition<S, E>>;

  constructor(config: {
    name: string;
    initial: S;
    states: readonly S[];
    transitions: readonly Transition<S, E>[];
  }) {
    this.name = config.name;
    this.initial = config.initial;
    this.states = config.states;
    this.transitions = config.transitions;
    this.index = new Map(config.transitions.map((t) => [`${t.from}\u0000${t.event}`, t]));

    const hasOutgoing = new Set(config.transitions.map((t) => t.from));
    this.terminal = new Set(config.states.filter((s) => !hasOutgoing.has(s)));

    // Fail at module load, not in production, if a transition names a state
    // that does not exist.
    for (const t of config.transitions) {
      if (!config.states.includes(t.from) || !config.states.includes(t.to)) {
        throw new Error(
          `${config.name}: transition ${t.from} -> ${t.to} names a state outside the declared set`,
        );
      }
    }
  }

  /** The transition for `event` from `from`, or undefined when it is not allowed. */
  find(from: S, event: E): Transition<S, E> | undefined {
    return this.index.get(`${from}\u0000${event}`);
  }

  can(from: S, event: E): boolean {
    return this.index.has(`${from}\u0000${event}`);
  }

  /** The resulting state, or undefined when the transition is not allowed. */
  next(from: S, event: E): S | undefined {
    return this.find(from, event)?.to;
  }

  /** Every event available from `from`. Used to render the actions a user has. */
  eventsFrom(from: S): E[] {
    return this.transitions.filter((t) => t.from === from).map((t) => t.event);
  }

  isTerminal(state: S): boolean {
    return this.terminal.has(state);
  }

  /** True when `state` can still reach `target` along some path. */
  canReach(state: S, target: S): boolean {
    const seen = new Set<S>([state]);
    const queue: S[] = [state];
    while (queue.length) {
      const current = queue.shift()!;
      if (current === target) return true;
      for (const t of this.transitions) {
        if (t.from === current && !seen.has(t.to)) {
          seen.add(t.to);
          queue.push(t.to);
        }
      }
    }
    return false;
  }
}
