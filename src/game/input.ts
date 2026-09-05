import { emptyInput, type Role, type RoleInput } from "./types";

/** Keyboard + mouse → per-role inputs. Every role uses the same keys (WASD/Space/Shift/Q/E). */
export class InputManager {
  keys = new Set<string>();
  yaw = 0;
  pitch = 0;
  private canvas: HTMLElement | null = null;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  onRoleSwitch: ((dir: number | "index", idx?: number) => void) | null = null;
  enabled = true;

  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.code === "Tab") {
      e.preventDefault();
      this.onRoleSwitch?.(e.shiftKey ? -1 : 1);
      return;
    }
    if (/^Digit[1-5]$/.test(e.code)) {
      this.onRoleSwitch?.("index", Number(e.code.slice(5)) - 1);
      return;
    }
    if (["Space", "ShiftLeft", "ShiftRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private onBlur = () => {
    this.keys.clear();
    this.dragging = false;
  };
  private onMouseMove = (e: MouseEvent) => {
    if (!this.enabled) return;
    const locked = document.pointerLockElement === this.canvas;
    if (locked) {
      this.yaw -= e.movementX * 0.0032;
      this.pitch -= e.movementY * 0.0022;
    } else if (this.dragging) {
      this.yaw -= (e.clientX - this.lastX) * 0.006;
      this.pitch -= (e.clientY - this.lastY) * 0.004;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }
    this.pitch = Math.max(-0.9, Math.min(0.7, this.pitch));
  };
  private onMouseDown = (e: MouseEvent) => {
    if (e.target !== this.canvas) return;
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };
  private onMouseUp = () => {
    this.dragging = false;
  };

  attach(canvas: HTMLElement) {
    this.canvas = canvas;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
  }

  detach() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
  }

  requestPointerLock() {
    this.canvas?.requestPointerLock?.();
  }

  private down(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  /** Update head yaw/pitch from keys (called each frame). */
  tickHead(dt: number, keysActive: boolean) {
    if (!keysActive) return;
    const turn = (this.down("KeyA", "ArrowLeft") ? 1 : 0) - (this.down("KeyD", "ArrowRight") ? 1 : 0);
    const look = (this.down("KeyW", "ArrowUp") ? 1 : 0) - (this.down("KeyS", "ArrowDown") ? 1 : 0);
    this.yaw += turn * dt * 2.2;
    this.pitch = Math.max(-0.9, Math.min(0.7, this.pitch + look * dt * 1.4));
  }

  read(role: Role, keysActive: boolean): RoleInput {
    const i = emptyInput();
    i.lx = this.yaw;
    i.ly = this.pitch;
    if (!keysActive || !this.enabled) return i;
    if (role === "head") {
      i.a = this.down("Space");
      return i;
    }
    i.f = (this.down("KeyW", "ArrowUp") ? 1 : 0) - (this.down("KeyS", "ArrowDown") ? 1 : 0);
    i.s = (this.down("KeyD", "ArrowRight") ? 1 : 0) - (this.down("KeyA", "ArrowLeft") ? 1 : 0);
    i.a = this.down("Space");
    i.b = this.down("ShiftLeft", "ShiftRight");
    i.q = this.down("KeyQ");
    i.e = this.down("KeyE");
    return i;
  }
}

export function inputsEqual(a: RoleInput, b: RoleInput) {
  return a.f === b.f && a.s === b.s && a.a === b.a && a.b === b.b && a.q === b.q && a.e === b.e && Math.abs(a.lx - b.lx) < 0.002 && Math.abs(a.ly - b.ly) < 0.002;
}
