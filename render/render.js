// Usage: node render.js <page.html> <outdir>
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const [, , htmlPath, outDir] = process.argv;
const FPS = 30, W = 1280, H = 720;

function writeWav(file, inter, sr) {
  // 32-bit float stereo WAV
  const dataBytes = inter.length * 4;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 8, 28); b.writeUInt16LE(8, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < inter.length; i++) b.writeFloatLE(inter[i], 44 + i * 4);
  fs.writeFileSync(file, b);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', `--proxy-server=${process.env.HTTPS_PROXY || ''}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.setViewport({ width: W, height: H + 64 });
  await page.goto('file://' + path.resolve(htmlPath), { waitUntil: 'networkidle0', timeout: 120000 });
  await page.waitForFunction('window.READY === true', { timeout: 120000 });

  // Fonts: the page swallows load failures, so verify explicitly.
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const specs = ['400 56px "Permanent Marker"', '700 46px "Kalam"'];
    const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`);
    return { checks: specs.map((s) => [s, document.fonts.check(s)]), loaded };
  });
  console.log('fonts loaded:', fonts.loaded.join(', '));
  const fam = (n) => fonts.loaded.some((l) => l.replace(/"/g, '').startsWith(n));
  if (!fam('Kalam') || !fam('Permanent Marker') || fonts.checks.some(([, ok]) => !ok)) {
    console.error('FONT CHECK FAILED', fonts);
    process.exit(1);
  }
  const duration = await page.evaluate('window.DURATION');
  const nFrames = Math.floor(duration * FPS + 1e-9) + 1;
  console.log(`DURATION=${duration}s -> ${nFrames} frames`);

  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS),
    '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    path.join(outDir, 'video.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))));

  for (let i = 0; i < nFrames; i++) {
    const b64 = await page.evaluate((t) => {
      window.seek(t);
      const cv = document.getElementById('stage');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let s = '';
      for (let j = 0; j < d.length; j += 0x8000) s += String.fromCharCode.apply(null, d.subarray(j, j + 0x8000));
      return btoa(s);
    }, i / FPS);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== W * H * 4) throw new Error(`frame ${i}: bad size ${buf.length}`);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await ffDone;
  console.log('video.mp4 written');

  const audio = await page.evaluate(async () => {
    const r = await SOUND.renderOffline(window.scoreSound, window.DURATION, 48000, { voiceover: true });
    return { inter: Array.from(r.inter), peak: r.peak, sr: r.sr, frames: r.frames };
  });
  writeWav(path.join(outDir, 'effects.wav'), Float32Array.from(audio.inter), audio.sr);
  console.log(`effects.wav written: ${audio.frames} frames @ ${audio.sr} Hz, peak ${audio.peak.toFixed(3)}`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
