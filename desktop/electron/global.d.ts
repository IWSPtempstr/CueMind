import type { DesktopBridge } from "./types";

declare global {
  interface Window {
    cuemindDesktop?: DesktopBridge;
  }
}

export {};
