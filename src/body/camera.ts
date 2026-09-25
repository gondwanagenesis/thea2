// v9 body — her camera (Thea1's thea-imagine + thea-selfie, re-done on fal).
// imagine: anything, not her. selfie: her — the reference set (copied from
// Thea1's, the same face) through FLUX.2 edit. video: a still (often a selfie)
// brought to life, image-to-video. Everything lands in her house's out/.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Clock } from '../kernel/index.js';
import type { Fal } from './fal.js';
import type { House } from './house.js';

export const IMAGE_MODEL = 'fal-ai/flux-2-pro';
export const VIDEO_MODEL = 'fal-ai/kling-video/v2.5-turbo/standard/image-to-video';

/** Thea1's shot styles, verbatim (selfie-fal.mjs). */
export const SHOTS = {
  selfie: "a casual smartphone selfie taken at arm's length with the front camera",
  mirror: 'a mirror selfie, phone visible in her hand',
  candid: 'a candid photo, as if a friend took it without her posing',
  night: 'a night-time phone photo, low light, a little grain, warm lamps',
  golden: 'a phone photo in golden-hour sunlight, warm soft light',
} as const;
export type Shot = keyof typeof SHOTS;

export const SIZES = ['square_hd', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'] as const;
export type Size = (typeof SIZES)[number];

const MAX_REFS = 6;

const dataUri = (file: string): string => {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
};

export interface Camera {
  imagine(a: { prompt: string; editPath?: string | undefined; ref?: string | undefined; size?: Size | undefined }): Promise<string>;
  selfie(a: { scene: string; shot?: Shot | undefined }): Promise<string>;
  video(a: { imagePath: string; prompt: string }): Promise<string>;
  /** Her reference set (house paths). */
  refs(name?: string): string[];
}

export const makeCamera = (d: { fal: Fal; house: House; clock: Clock }): Camera => {
  const refsOf = (name = 'thea'): string[] => {
    const dir = d.house.resolve(`refs/${name}`);
    if (dir === undefined || !fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort()
      .slice(-MAX_REFS)
      .map((f) => path.join(dir, f));
  };
  const save = (bytes: Uint8Array, kind: string, ext: string): string => d.house.save('out', `${kind}.${ext}`, bytes, d.clock.epochMs());

  return {
    refs: (name) => refsOf(name).map((p) => d.house.rel(p)),

    imagine: async (a) => {
      const size = a.size ?? 'square_hd';
      if (a.editPath !== undefined) {
        const src = d.house.resolve(a.editPath);
        if (src === undefined || !fs.existsSync(src)) throw new Error(`there is no ${a.editPath} to edit`);
        const r = await d.fal.image(`${IMAGE_MODEL}/edit`, { prompt: a.prompt, image_urls: [dataUri(src)], image_size: size, output_format: 'jpeg' });
        return save(r.bytes, 'edit', 'jpg');
      }
      if (a.ref !== undefined) {
        const refs = refsOf(a.ref);
        if (refs.length === 0) throw new Error(`no reference images for "${a.ref}"`);
        const r = await d.fal.image(`${IMAGE_MODEL}/edit`, { prompt: a.prompt, image_urls: refs.map(dataUri), image_size: size, output_format: 'jpeg' });
        return save(r.bytes, `ref-${a.ref}`, 'jpg');
      }
      const r = await d.fal.image(IMAGE_MODEL, { prompt: a.prompt, image_size: size, output_format: 'jpeg' });
      return save(r.bytes, 'imagine', 'jpg');
    },

    selfie: async (a) => {
      const refs = refsOf('thea');
      const style = SHOTS[a.shot ?? 'selfie'];
      const phone = ' Realistic phone photo: natural skin texture, slight grain, casual framing, not a studio shot.';
      if (refs.length === 0) {
        const r = await d.fal.image(IMAGE_MODEL, { prompt: `${style}. ${a.scene}.${phone}`, image_size: 'portrait_4_3', output_format: 'jpeg' });
        return save(r.bytes, 'selfie', 'jpg');
      }
      const prompt = `${style} of the young woman shown in the reference images — exactly her face, hair and features, she is Thea. ${a.scene}.${phone}`;
      const r = await d.fal.image(`${IMAGE_MODEL}/edit`, { prompt, image_urls: refs.map(dataUri), image_size: 'portrait_4_3', output_format: 'jpeg' });
      return save(r.bytes, 'selfie', 'jpg');
    },

    video: async (a) => {
      const src = d.house.resolve(a.imagePath);
      if (src === undefined || !fs.existsSync(src)) throw new Error(`there is no ${a.imagePath} to bring to life`);
      const r = await d.fal.video(VIDEO_MODEL, { prompt: a.prompt, image_url: dataUri(src), duration: '5' });
      return save(r.bytes, 'video', 'mp4');
    },
  };
};
