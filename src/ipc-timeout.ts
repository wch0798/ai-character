export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "요청"
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label}이 너무 오래 걸려 건너뜁니다.`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}
