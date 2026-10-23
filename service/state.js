import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

import { telegramTarget } from './target.js';
export { telegramTarget } from './target.js';

export class WidgetState extends EventEmitter {
  constructor({
    dir,
    preview,
    clock = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    super();
    Object.assign(this, { dir, preview, clock, wait });
    this.promo = {
      active: false,
      revision: "",
      url: "",
      scale: 0.75,
      accentOverride: "",
    };
    this.favorites = [];
    this.duration = 0;
    this.input = "";
    this.busy = false;
    this.error = "";
    this.sequence = 0;
    this.instance = randomUUID();
    this.generation = 0;
    this.persistence = Promise.resolve();
  }
  async load() {
    await mkdir(this.dir, { recursive: true });
    try {
      const stored = JSON.parse(
        await readFile(path.join(this.dir, "state.json"), "utf8"),
      );
      this.settings(
        {
          scale: stored.promo?.scale ?? 0.75,
          accentOverride: stored.promo?.accentOverride ?? "",
          duration: stored.duration ?? 0,
        },
        false,
      );
      this.input = String(stored.input || "").slice(0, 2048);
      this.favorites = (Array.isArray(stored.favorites) ? stored.favorites : [])
        .slice(0, 24)
        .flatMap((entry) => {
          try {
            return [
              {
                ...telegramTarget(entry.url),
                title: String(entry.title || "").slice(0, 120),
              },
            ];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if (error.code !== "ENOENT")
        this.error =
          "Не удалось прочитать настройки. Использованы стандартные значения.";
    }
  }
  snapshot() {
    return structuredClone({
      promo: this.promo,
      favorites: this.favorites,
      input: this.input,
      duration: this.duration,
      busy: this.busy,
      error: this.error,
      instance: this.instance,
      sequence: this.sequence,
      serverTime: this.clock(),
    });
  }
  changed() {
    this.sequence += 1;
    this.emit("change", this.snapshot());
  }
  save() {
    const document = JSON.stringify({
      promo: {
        scale: this.promo.scale,
        accentOverride: this.promo.accentOverride,
      },
      duration: this.duration,
      input: this.input,
      favorites: this.favorites,
    });
    const file = path.join(this.dir, "state.json");
    const write = this.persistence
      .catch(() => {})
      .then(async () => {
        await writeFile(`${file}.tmp`, document, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      });
    this.persistence = write;
    return write;
  }
  settings(data, notify = true) {
    // Validate the entire patch before changing any live values.
    if (data.scale !== undefined) {
      if (
        typeof data.scale !== "number" ||
        !Number.isFinite(data.scale) ||
        data.scale < 0.45 ||
        data.scale > 1.5
      )
        throw new Error("Масштаб должен быть от 45 до 150%.");
    }
    if (data.accentOverride !== undefined) {
      if (
        typeof data.accentOverride !== "string" ||
        !/^(?:#[0-9a-f]{6})?$/i.test(data.accentOverride)
      )
        throw new Error("Некорректный цвет.");
    }
    if (data.duration !== undefined) {
      if (
        !Number.isInteger(data.duration) ||
        data.duration < 0 ||
        data.duration > 3600
      )
        throw new Error("Длительность должна быть от 0 до 3600 секунд.");
    }
    if (
      data.input !== undefined &&
      (typeof data.input !== "string" || data.input.length > 2048)
    )
      throw new Error("Ссылка слишком длинная.");
    if (data.scale !== undefined) this.promo.scale = data.scale;
    if (data.accentOverride !== undefined)
      this.promo.accentOverride = data.accentOverride.toLowerCase();
    if (data.input !== undefined) this.input = data.input;
    if (data.duration !== undefined) {
      this.duration = data.duration;
      if (this.promo.active) this.armAutoHide();
    }
    if (notify) this.changed();
  }
  armAutoHide() {
    clearTimeout(this.autoHide);
    if (this.duration > 0) {
      this.autoHide = setTimeout(
        () => this.hide().catch((error) => this.report(error)),
        this.duration * 1000,
      );
      this.autoHide.unref?.();
    }
  }
  report(error) {
    this.error = error.message;
    this.changed();
  }
  async show(value = this.input) {
    const target = telegramTarget(value);
    const generation = ++this.generation;
    this.input = target.url;
    this.busy = true;
    this.error = "";
    this.changed();
    try {
      // Load first. A failed Telegram request must leave the current widget visible.
      const preview = await this.preview(target.username, target.postId);
      if (generation !== this.generation) return;
      let exitWait = 0;
      if (this.promo.active) {
        clearTimeout(this.autoHide);
        this.promo = {
          ...this.promo,
          active: false,
          revision: randomUUID(),
          changedAt: this.clock(),
        };
        this.changed();
        exitWait = 520;
      } else if (this.promo.url && this.promo.revision) {
        exitWait = Math.max(0, 520 - (this.clock() - this.promo.changedAt));
      }
      if (exitWait > 0) {
        await this.wait(exitWait);
        if (generation !== this.generation) return;
      }
      this.promo = {
        ...preview,
        scale: this.promo.scale,
        accentOverride: this.promo.accentOverride,
        active: true,
        changedAt: this.clock() + 150,
        revision: randomUUID(),
      };
      this.armAutoHide();
      await this.save();
    } catch (error) {
      if (generation === this.generation) this.error = error.message;
      throw error;
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.changed();
      }
    }
  }
  async hide() {
    ++this.generation;
    clearTimeout(this.autoHide);
    this.busy = false;
    this.error = "";
    if (this.promo.active)
      this.promo = {
        ...this.promo,
        active: false,
        changedAt: this.clock(),
        revision: randomUUID(),
      };
    this.changed();
    await this.save();
  }
  async toggle(value = this.input) {
    if (
      this.promo.active &&
      (!value || telegramTarget(value).url === this.promo.url)
    )
      return this.hide();
    return this.show(value);
  }
  async favorite(value, remove = false) {
    const target = telegramTarget(value);
    this.favorites = this.favorites.filter((entry) => entry.url !== target.url);
    if (!remove)
      this.favorites.unshift({
        ...target,
        title:
          this.promo.url === target.url
            ? this.promo.title
            : `@${target.username}`,
      });
    this.favorites = this.favorites.slice(0, 24);
    this.changed();
    await this.save();
  }
  async close() {
    ++this.generation;
    clearTimeout(this.autoHide);
    await this.persistence.catch(() => {});
  }
}
