export function safeConfirm(_message: string): boolean {
  // Native confirm/dialog는 always-on-top 창에서 Windows '응답 없음'을 만든다.
  return true;
}

export async function safeConfirmAsync(_message: string): Promise<boolean> {
  return true;
}
