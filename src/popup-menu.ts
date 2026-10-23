/**
 * Open/close wiring shared by the chat toolbar's small menus: the button toggles the menu,
 * a click elsewhere or Esc closes it. `onOpen` fills and places the menu before it shows.
 */
export type PopupMenu = { close(): void };

export function attachPopupMenu(button: HTMLElement, menu: HTMLElement, onOpen: () => void): PopupMenu {
  const close = () => {
    menu.hidden = true;
    button.classList.remove("open");
  };
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!menu.hidden) {
      close();
      return;
    }
    onOpen();
    menu.hidden = false;
    button.classList.add("open");
  });
  menu.addEventListener("pointerdown", (event) => event.stopPropagation());
  document.addEventListener("pointerdown", () => {
    if (!menu.hidden) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.stopPropagation();
      close();
    }
  }, true);
  return { close };
}
