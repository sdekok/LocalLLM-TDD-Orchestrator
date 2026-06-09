/**
 * Race a promise against a timeout, but always clear the timer when either side
 * settles so we don't leak a Node.js timer for up to an hour.
 * Plain `Promise.race([p, setTimeoutReject(ms)])` leaves the timer armed, which
 * matters for long timeouts (the process can't exit cleanly and the captured
 * closure stays in memory).
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
