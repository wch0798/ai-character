/** 프로덕션에서는 상세 콘솔 출력을 줄여 키/경로 노출을 막습니다. */
export function quietConsoleInProduction(): void {
  if (!import.meta.env.PROD) {
    return;
  }
  const noop = () => undefined;
  console.log = noop;
  console.debug = noop;
  console.info = noop;
  console.warn = noop;
  // error는 유지하되, 메시지에 키가 섞일 수 있어 스택만 최소화
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const safe = args.map((arg) => {
      if (typeof arg === "string") {
        return arg
          .replace(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)\S+/gi, "$1***")
          .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-***")
          .replace(/AIza[A-Za-z0-9_-]{10,}/g, "AIza***");
      }
      return arg;
    });
    originalError(...safe);
  };
}
