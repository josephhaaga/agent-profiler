/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { ANIMAL_KINDS, renderAnimal, sampleAnimal } from "./animals";

function silhouette(kind: typeof ANIMAL_KINDS[number], time = 0) {
  return Array.from({ length: 7000 }, (_, i) => sampleAnimal(kind, (i % 100 + 0.5) / 100, (Math.floor(i / 100) + 0.5) / 70, time));
}

describe("original ASCII animal silhouettes", () => {
  test("exports all four species in scene-picker order", () => {
    expect(ANIMAL_KINDS).toEqual(["shark", "ray", "seahorse", "jellyfish"]);
  });

  for (const kind of ANIMAL_KINDS) {
    test(`${kind}: finite bounded density, substantial silhouette, transparent surroundings`, () => {
      for (const time of [0, 2.4, 17, -1]) {
        const values = silhouette(kind, time);
        expect(values.every(n => Number.isFinite(n) && n >= 0 && n <= 1)).toBe(true);
        const count = values.filter(n => n > 0).length;
        expect(count).toBeGreaterThan(350);
        expect(count).toBeLessThan(3000);
        expect(sampleAnimal(kind, 0, 0, time)).toBe(0);
        expect(sampleAnimal(kind, 1, 1, time)).toBe(0);
      }
    });

    test(`${kind}: deterministic frames with actual slow movement`, () => {
      const still = silhouette(kind, 0);
      expect(silhouette(kind, 0)).toEqual(still);
      expect(silhouette(kind, 3)).not.toEqual(still);
      expect(silhouette(kind, 0)).toEqual(still);
    });

    test(`${kind}: rejects invalid coordinates and times`, () => {
      for (const [x, y, time] of [[-0.1, 0.5, 0], [1.1, 0.5, 0], [0.5, -1, 0], [0.5, 2, 0], [NaN, 0.5, 0], [0.5, Infinity, 0], [0.5, 0.5, NaN]]) {
        expect(sampleAnimal(kind, x, y, time)).toBe(0);
      }
    });
  }

  test("species have materially different silhouettes, not renamed texture", () => {
    for (let i = 0; i < ANIMAL_KINDS.length; i++) {
      for (let j = i + 1; j < ANIMAL_KINDS.length; j++) {
        const a = silhouette(ANIMAL_KINDS[i]);
        const b = silhouette(ANIMAL_KINDS[j]);
        expect(a.filter((n, k) => (n > 0) !== (b[k] > 0)).length).toBeGreaterThan(450);
      }
    }
  });

  test("anatomical landmarks distinguish the requested animals", () => {
    expect(sampleAnimal("seahorse", 0.35, 0.248, 0)).toBeGreaterThan(0); // snout
    expect(sampleAnimal("seahorse", 0.55, 0.79, 0)).toBe(0); // open curled-tail center
    expect(sampleAnimal("ray", 0.1, 0.37, 0)).toBeGreaterThan(0); // broad wing
    expect(sampleAnimal("ray", 0.459, 0.93, 0)).toBeGreaterThan(0); // curved whip tail
    expect(sampleAnimal("jellyfish", 0.5, 0.2, 0)).toBeGreaterThan(0); // bell
    expect(sampleAnimal("jellyfish", 0.5, 0.08, 0)).toBe(0);
    expect(sampleAnimal("shark", 0.42, 0.29, 0)).toBeGreaterThan(0); // dorsal fin
  });

  test("renderer clears the backing store and paints bounded lavender glyphs only", () => {
    for (const kind of ANIMAL_KINDS) {
      const clears: number[][] = [];
      const transforms: number[][] = [];
      const glyphs: string[] = [];
      let saves = 0;
      let restores = 0;
      const context = {
        canvas: { width: 1400, height: 980 },
        fillStyle: "",
        save() { saves++; },
        restore() { restores++; },
        setTransform(...values: number[]) { transforms.push(values); },
        clearRect(...values: number[]) { clears.push(values); },
        fillText(glyph: string, x: number, y: number) {
          expect(this.fillStyle).toMatch(/^#(?:958bb8|a095c0|aba0c8|b6aad0|c0b4d8)$/);
          expect(x > 0 && x < 700 && y > 0 && y < 490).toBe(true);
          glyphs.push(glyph);
        },
      };
      renderAnimal(context as unknown as CanvasRenderingContext2D, kind, 0, 700, 490);
      expect(clears).toEqual([[0, 0, 1400, 980]]);
      expect(transforms).toEqual([[1, 0, 0, 1, 0, 0], [2, 0, 0, 2, 0, 0]]);
      expect(glyphs.length).toBeGreaterThan(350);
      expect(glyphs.length).toBeLessThanOrEqual(7000);
      expect(glyphs.every(glyph => glyph.length === 1)).toBe(true);
      expect(saves).toBe(1);
      expect(restores).toBe(1);
    }
  });
});
