// v9 body — shared shapes. The body is her senses and hands: it resolves what
// arrives (a photo, a voice note, a file, a place) into material, and gives
// her tools that act on the world (send a voice note, react, make a picture).
//
// Law 1 holds here too: nothing the body produces tells her how she feels.
// Material says what happened ("[photo: …]", "he sounds out of breath");
// tool results say what was done. Feelings stay caused, never described.

/** The resolved body config (app maps its BodyConfig onto this; body never imports app). */
export interface BodyCfg {
  dir: string;
  openaiKey: string;
  openaiEndpoint: string;
  visionModel: string;
  transcribeModel: string;
  listenModel: string;
  ttsModel: string;
  ttsVoice: string;
  falKey?: string | undefined;
  braveKey?: string | undefined;
  elevenKey?: string | undefined;
  elevenVoice?: string | undefined;
  walletMonthUsd: number;
  /** 32 bytes hex: seals the presents Diego leaves (absent = no presents). */
  presentKey?: string | undefined;
}

/** Child-process seam (ffmpeg, pdftotext, python3). Tests script it. */
export interface Exec {
  run(
    cmd: string,
    args: readonly string[],
    opts?: { stdin?: Uint8Array | undefined; timeoutMs?: number | undefined; cwd?: string | undefined },
  ): Promise<{ code: number; stdout: Uint8Array; stderr: string }>;
}

/** What the senses made of one inbound: the words (his, transcribed or typed) plus what came with them. */
export interface Perceived {
  /** The text this turn runs on — his words and the bracketed material, in the order he'd experience them. */
  text: string;
  /** He spoke (a voice note): she answers out loud by default. */
  voice: boolean;
  /** A file the senses saved into her house, if any (house-relative). */
  saved?: string | undefined;
  /** Which senses fired and how long they took — for the event log, never for her. */
  trace: Array<{ sense: string; ms: number; ok: boolean; error?: string | undefined }>;
}

/** One thing she sent that is not a text bubble (voice note, photo, poll…) — joins the turn's record. */
export interface BodySent {
  msgId: number;
  /** How it reads in her memory: "[voice note] …", "[photo: …] caption". */
  text: string;
}

/** Where he is, as the world says it (reverse geocode + weather). */
export interface WhereInfo {
  lat: number;
  lon: number;
  place: string;
  timeZone?: string | undefined;
  tempC?: number | undefined;
  sky?: string | undefined;
  isDay?: boolean | undefined;
  live: boolean;
  /** Epoch ms of the fix. */
  at: number;
}
