import * as Effect from "effect/Effect";

interface MutationQueue {
  tail: Promise<void>;
  users: number;
}

const queues = new Map<string, MutationQueue>();

const acquire = (key: string): Promise<() => void> => {
  const queue = queues.get(key) ?? { tail: Promise.resolve(), users: 0 };
  const predecessor = queue.tail;
  let releaseTicket!: () => void;
  const ticket = new Promise<void>((resolve) => {
    releaseTicket = resolve;
  });
  queue.tail = ticket;
  queue.users += 1;
  queues.set(key, queue);

  return predecessor.then(() => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseTicket();
      queue.users -= 1;
      if (queue.users === 0 && queues.get(key) === queue) queues.delete(key);
    };
  });
};

export const withStudyLibraryMutationLock = <A, E, R>(
  key: string,
  mutation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => acquire(key)),
    () => mutation,
    (release) => Effect.sync(release),
  );
