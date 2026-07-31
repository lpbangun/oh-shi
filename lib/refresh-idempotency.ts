export type StoredRefreshResponse<T> = {
  completed: boolean;
  httpStatus: number;
  body: T;
};

export type RefreshRunStore<T> = {
  claim(runKey: string): Promise<boolean>;
  read(runKey: string): Promise<StoredRefreshResponse<T> | null>;
  complete(runKey: string, response: StoredRefreshResponse<T>): Promise<void>;
};

export type RefreshExecution<T> =
  | { kind: "executed"; response: StoredRefreshResponse<T> }
  | { kind: "replayed"; response: StoredRefreshResponse<T> }
  | { kind: "duplicate_in_progress" };

export function validRunKey(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);
}

export async function executeRefreshOnce<T>(
  runKey: string,
  store: RefreshRunStore<T>,
  work: () => Promise<StoredRefreshResponse<T>>
): Promise<RefreshExecution<T>> {
  if (!validRunKey(runKey)) throw new Error("Invalid Idempotency-Key.");
  if (!(await store.claim(runKey))) {
    const existing = await store.read(runKey);
    if (existing?.completed) return { kind: "replayed", response: existing };
    return { kind: "duplicate_in_progress" };
  }
  const response = await work();
  await store.complete(runKey, { ...response, completed: true });
  return { kind: "executed", response: { ...response, completed: true } };
}
