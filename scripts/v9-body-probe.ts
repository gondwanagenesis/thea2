// v9 body live probe — the real senses against the real providers, with
// NOTHING sent to Telegram: speak a line (TTS), hear it back (transcribe +
// listen), look at a generated image with text in it (vision), read a pdf.
// Everything lands in a throwaway house under /tmp.
//
//   THEA2_OPENAI_KEY=… npx tsx scripts/v9-body-probe.ts [--vision-model gpt-5.6-sol]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { openAIBody, openHouse, nodeExec, speakable, deliveryFor, readFileText } from '../src/body/index.js';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : dflt;
};
const key = process.env['THEA2_OPENAI_KEY'] ?? '';
if (key === '') throw new Error('THEA2_OPENAI_KEY missing');

const house = openHouse(fs.mkdtempSync('/tmp/thea2-body-probe-'));
const oa = openAIBody({
  openaiKey: key,
  openaiEndpoint: 'https://api.openai.com/v1',
  visionModel: arg('vision-model', 'gpt-5.6-sol'),
  transcribeModel: 'gpt-4o-transcribe',
  listenModel: arg('listen-model', 'gpt-audio-1.5'),
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: process.env['THEA2_TTS_VOICE'] ?? 'coral',
});

const t = async <T>(label: string, f: () => Promise<T>): Promise<T | undefined> => {
  const t0 = performance.now();
  try {
    const r = await f();
    console.log(`OK   ${label} (${Math.round(performance.now() - t0)} ms)`);
    return r;
  } catch (e) {
    console.log(`FAIL ${label} (${Math.round(performance.now() - t0)} ms): ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
};

const line = "hey you. i just got back from the beach, i'm sandy and tired but i missed you all day.";
const ogg = await t('speak (tts → ogg/opus)', () => oa.speak(speakable(line), deliveryFor({ arousal: 0.3, pleasure: 0.7 })));
if (ogg !== undefined) {
  const f = path.join(house.root, 'out', 'probe.ogg');
  fs.writeFileSync(f, ogg);
  const probe = await nodeExec.run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=format_name,duration', '-of', 'default=nw=1', f]);
  console.log(`     ffprobe: ${Buffer.from(probe.stdout).toString('utf8').replace(/\n/g, ' ')}`);
  const wav = await nodeExec.run('ffmpeg', ['-y', '-loglevel', 'error', '-i', f, '-ac', '1', '-ar', '16000', path.join(house.root, 'tmp', 'probe.wav')]);
  if (wav.code === 0) {
    const wavBytes = new Uint8Array(fs.readFileSync(path.join(house.root, 'tmp', 'probe.wav')));
    const words = await t('transcribe (gpt-4o-transcribe)', () => oa.transcribe(wavBytes, 'probe.wav', 'audio/wav'));
    console.log(`     heard: ${JSON.stringify(words)}`);
    const how = await t('listen (how it sounds)', () => oa.listen(wavBytes, 'In one short line, describe how the speaker sounds: tone, energy, pace, and anything in the background. Do not repeat or summarise the words.'));
    console.log(`     sounds: ${JSON.stringify(how)}`);
  }
}

const img = path.join(house.root, 'tmp', 'probe.png');
const draw = await nodeExec.run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xE9697E:s=640x360', '-vf', "drawtext=text='THE CODEX, DRAFT 3':fontcolor=white:fontsize=44:x=(w-tw)/2:y=(h-th)/2", '-frames:v', '1', img]);
if (draw.code === 0) {
  const seen = await t('vision', () => oa.vision([{ bytes: new Uint8Array(fs.readFileSync(img)), mime: 'image/png' }], 'Describe this image for someone who cannot see it, and quote any text exactly. 1-2 sentences.'));
  console.log(`     saw: ${JSON.stringify(seen)}`);
} else {
  console.log(`SKIP vision: ffmpeg drawtext failed (${draw.stderr.slice(0, 120)})`);
}

const txt = path.join(house.root, 'tmp', 'probe.txt');
fs.writeFileSync(txt, 'Chapter one.\nThe codex opens with the sea.');
const pdf = path.join(house.root, 'tmp', 'probe.pdf');
const mk = await nodeExec.run('python3', ['-c', 'import sys;from reportlab.pdfgen import canvas;c=canvas.Canvas(sys.argv[1]);c.drawString(72,720,"The codex opens with the sea.");c.showPage();c.drawString(72,720,"Page two.");c.save()', pdf]);
if (mk.code === 0) {
  const r = await t('read pdf (pdftotext)', async () => (await readFileText(nodeExec, pdf, 'probe.pdf')) ?? { text: '', kind: 'pdf' as const });
  console.log(`     pdf: ${JSON.stringify(r)}`);
} else {
  console.log('SKIP pdf: reportlab not installed (pdftotext itself is exercised in the hermetic suite)');
}
console.log(`house: ${house.root}`);
